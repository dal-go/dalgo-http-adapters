import { cancelQuietly, createAbortScope, QueryCancelledError, raceAbort } from "@dalgo/adapter-runtime";
import { assertScopedRedisScanReply, parseRedisReply, RedisReadError, resolveRedisLimits, scopeRedisRead, type RedisLimits, type RedisReadExecutor, type RedisValue } from "@dalgo/dalgo2redis-resp/protocol";

export { RedisReadError } from "@dalgo/dalgo2redis-resp/protocol";
export type { RedisLimits, RedisReadExecutor, RedisValue } from "@dalgo/dalgo2redis-resp/protocol";

export interface UpstashRedisOptions extends RedisLimits {
  /** Trusted saved configuration, never an arbitrary request-body URL. */
  readonly endpoint: string;
  /** Scoped provider read credential, not an application session or admin token.
   * Acquired within the same request deadline. Never persisted by this adapter.
   */
  readonly token: string | ((signal: AbortSignal) => string | Promise<string>);
  /** Explicit transport for the host/tests; must implement normal Fetch security. */
  readonly fetch?: typeof fetch;
  /** Authorized literal prefix. Default Read Only tokens may still deny SCAN. */
  readonly scanPrefix?: string;
  /** Only for a disposable, owned HTTP fixture at a literal loopback address. */
  readonly allowInsecureLoopbackHttp?: boolean;
}

// JSON can represent lone UTF16 surrogates that cannot identify the same UTF8
// key at the provider. Keep valid astral pairs without replacing invalid units.
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function bulk(value: RedisValue): boolean {
  return value === null || (typeof value !== "string" && value.kind === "bytes");
}

/** Refuse a partial or wrong-type service reply rather than publish success. */
function assertReply(command: readonly string[], value: RedisValue, prefix: string | undefined): void {
  const name = command[0];
  if (name === "SCAN") { assertScopedRedisScanReply(value, prefix); return; }
  if (name === "TYPE") {
    if (typeof value !== "string") throw new RedisReadError("protocol");
    return;
  }
  if (name === "MGET" || name === "HMGET") {
    const count = command.length - (name === "MGET" ? 1 : 2);
    if (value === null || typeof value === "string" || value.kind !== "array"
      || value.values.length !== count || value.values.some(child => !bulk(child))) throw new RedisReadError("protocol");
    return;
  }
  if (name === "GET" || name === "HGET" || name === "ZSCORE") {
    if (!bulk(value)) throw new RedisReadError("protocol");
    return;
  }
  // The shared admission already closed the remaining integer-read allowlist.
  if (value === null || typeof value === "string" || value.kind !== "integer") throw new RedisReadError("protocol");
}

function endpoint(options: UpstashRedisOptions): string {
  let url: URL;
  try { url = new URL(options.endpoint); } catch { throw new RedisReadError("policy"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(options.allowInsecureLoopbackHttp === true && loopback && url.protocol === "http:")) throw new RedisReadError("policy");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") throw new RedisReadError("policy");
  return url.href;
}

/** One independent read over the official Upstash REST protocol. Importing or
 * constructing the executor performs no I/O and loads no Node/TCP driver.
 */
export class UpstashRedisExecutor implements RedisReadExecutor {
  public readonly readOnly = true as const;
  public readonly serverCancellation = "http-abort-only" as const;
  readonly #endpoint: string;
  readonly #token: UpstashRedisOptions["token"];
  readonly #fetch: typeof fetch;
  readonly #prefix: string | undefined;
  readonly #limits;

  public constructor(options: UpstashRedisOptions) {
    this.#endpoint = endpoint(options);
    if (typeof options.token !== "string" && typeof options.token !== "function") throw new RedisReadError("policy");
    if (options.scanPrefix !== undefined && (typeof options.scanPrefix !== "string" || options.scanPrefix.length === 0 || !wellFormed(options.scanPrefix))) throw new RedisReadError("policy");
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#prefix = options.scanPrefix;
    this.#limits = resolveRedisLimits(options);
    if (this.#limits.timeoutMs > 60_000 || this.#limits.maxReplyBytes > 16_777_216 || this.#limits.maxCommandBytes > 1_048_576 || this.#limits.maxArguments > 1024) throw new RedisReadError("limit");
  }

  public async execute(command: readonly string[], signal?: AbortSignal): Promise<RedisValue> {
    const scope = createAbortScope(signal, this.#limits.timeoutMs);
    const expires = performance.now() + this.#limits.timeoutMs;
    const cancelled = (): QueryCancelledError => new QueryCancelledError(scope.deadlineExceeded ? "deadline" : "caller");
    const assertActive = (): void => {
      // Read the clock even when the event loop has not serviced its timer yet.
      const elapsed = performance.now() >= expires;
      if (scope.signal.aborted) throw cancelled();
      if (elapsed) throw new QueryCancelledError("deadline");
    };
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let abandoned = false;
    let cleaned = false;
    const clean = (): void => {
      // A response arriving after finally still transfers ownership here.
      if (response === undefined || cleaned) return;
      cleaned = true;
      try { cancelQuietly(reader ?? response.body); } catch { /* A hostile body getter cannot replace the failure. */ }
    };
    try {
      assertActive();
      const admitted = scopeRedisRead(command, this.#prefix, this.#limits);
      if (admitted.some(part => !wellFormed(part))) throw new RedisReadError("policy");
      const body = JSON.stringify(admitted);
      if (new TextEncoder().encode(body).byteLength > this.#limits.maxCommandBytes) throw new RedisReadError("limit");
      const token = await raceAbort(Promise.resolve().then(() => {
        assertActive();
        return typeof this.#token === "string" ? this.#token : this.#token(scope.signal);
      }), scope.signal, cancelled);
      assertActive();
      if (token.length === 0 || token.length > 8192 || !/^[!-~]+$/u.test(token)) throw new RedisReadError("denied");
      const fetching = Promise.resolve().then(() => {
        assertActive();
        return this.#fetch(this.#endpoint, {
          method: "POST", redirect: "error", credentials: "omit", signal: scope.signal,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/octet-stream", "Upstash-Response-Format": "resp2" },
          body,
        });
      }).then(value => {
        // Establish ownership before awaiting the race: abort can interleave
        // between its resolved promise and the handler's continuation.
        response = value;
        if (abandoned || scope.signal.aborted) clean();
        return value;
      });
      const received = await raceAbort(fetching, scope.signal, cancelled);
      assertActive();
      if (received.redirected || (received.url !== "" && received.url !== this.#endpoint)) throw new RedisReadError("transport");
      if (received.status !== 200) throw new RedisReadError([400, 401, 403].includes(received.status) ? "denied" : "transport");
      if (received.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/octet-stream") throw new RedisReadError("protocol");
      const length = received.headers.get("content-length");
      if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > this.#limits.maxReplyBytes)) throw new RedisReadError("limit");
      if (received.body === null) throw new RedisReadError("protocol");
      reader = received.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        assertActive();
        const next = await raceAbort(reader.read(), scope.signal, cancelled);
        assertActive();
        if (next.done) break;
        if (next.value.byteLength > this.#limits.maxReplyBytes - size) throw new RedisReadError("limit");
        size += next.value.byteLength;
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const parsed = parseRedisReply(bytes, this.#limits.maxReplyBytes);
      if (parsed?.offset !== size) throw new RedisReadError("protocol");
      assertReply(admitted, parsed.value, this.#prefix);
      assertActive();
      return parsed.value;
    } catch (error) {
      if (scope.signal.aborted) throw cancelled();
      if (error instanceof RedisReadError || error instanceof QueryCancelledError) throw error;
      throw new RedisReadError("transport");
    } finally {
      abandoned = true;
      clean();
      try { reader?.releaseLock(); } catch { /* Pending hostile reads cannot delay disposal. */ }
      // Cleanup callbacks can synchronously abort after the last body read.
      try { assertActive(); } finally { scope.dispose(); }
    }
  }
}
