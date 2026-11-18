import { createAbortScope, raceAbort, QueryCancelledError } from "@dalgo/adapter-runtime";
import { isRedisValue, RedisReadError, resolveRedisLimits, validateRedisRead, type RedisLimits, type RedisReadExecutor, type RedisValue } from "./contracts.js";
import { assertActive, cancellationError, object, readJson } from "./http-body.js";

export interface RedisHttpOptions extends RedisLimits {
  /** Your authenticated application route, not a Redis URL or Upstash endpoint. */
  readonly endpoint: string;
  readonly fetch?: typeof fetch;
  /** Optional short-lived application authorization, acquired within the cancellation deadline. */
  readonly headers?: () => Promise<Readonly<Record<string, string>>>;
}

/** Browser-safe lightweight client. This entry has no Node/TCP imports. */
export class RedisHttpExecutor implements RedisReadExecutor {
  readonly #options: RedisHttpOptions;
  readonly #limits;

  public constructor(options: RedisHttpOptions) {
    const url = new URL(options.endpoint);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new TypeError("Redis application endpoint must use HTTPS except loopback");
    if (url.username || url.password || url.search || url.hash) throw new TypeError("Redis application endpoint must not contain credentials, query or fragment");
    this.#options = { ...options, endpoint: url.toString() };
    this.#limits = resolveRedisLimits(options);
  }

  public async execute(command: readonly string[], signal?: AbortSignal): Promise<RedisValue> {
    const admitted = validateRedisRead(command, this.#limits);
    const scope = createAbortScope(signal, this.#limits.timeoutMs);
    let response: Response | undefined;
    try {
      const headers = this.#options.headers === undefined ? {} : await raceAbort(Promise.resolve().then(this.#options.headers), scope.signal, () => cancellationError(scope));
      assertActive(scope);
      const fetching = (this.#options.fetch ?? globalThis.fetch)(this.#options.endpoint, {
        method: "POST", redirect: "error", credentials: "same-origin", signal: scope.signal,
        headers: { ...headers, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ command: admitted }),
      }).then(value => {
        if (scope.signal.aborted) {
          try { void value.body?.cancel().catch(() => undefined); } catch { /* Best-effort late-response cleanup. */ }
        }
        return value;
      });
      response = await raceAbort(fetching, scope.signal, () => cancellationError(scope));
      if (!response.ok) {
        if (response.status === 499) throw new QueryCancelledError("caller");
        if (response.status === 504) throw new QueryCancelledError("deadline");
        throw new RedisReadError(response.status === 401 || response.status === 403 ? "denied" : response.status === 413 ? "limit" : "transport");
      }
      const payload = await readJson(response.body, this.#limits.maxReplyBytes, scope);
      if (!object(payload) || Object.keys(payload).length !== 1 || !isRedisValue(payload.result)) throw new RedisReadError("protocol");
      assertActive(scope);
      return payload.result;
    } catch (error) {
      if (error instanceof RedisReadError || error instanceof QueryCancelledError) throw error;
      throw new RedisReadError("transport");
    } finally {
      try { void response?.body?.cancel().catch(() => undefined); } catch { /* Nonblocking best-effort cleanup. */ }
      scope.dispose();
    }
  }
}
