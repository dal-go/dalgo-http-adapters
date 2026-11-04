import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { createAbortScope, QueryCancelledError } from "@dalgo/adapter-runtime";
import { RedisReadError, resolveRedisLimits, validateRedisRead, type RedisLimits, type RedisReadExecutor, type RedisValue } from "./contracts.js";
import { parseRedisReply } from "./resp.js";

export interface RedisNodeOptions extends RedisLimits {
  /** Server-owned endpoint; never accept this object from an HTTP body. */
  readonly host: string;
  readonly port?: number;
  /** Verify TLS with the platform trust store. No disable-verification option. */
  readonly tls?: boolean;
  readonly username?: string;
  readonly password?: string;
  readonly database?: number;
  /** Server-authorized literal prefix for key enumeration. SCAN is refused when absent.
   * Redis ACL key patterns do not filter SCAN output. Glob characters here are escaped.
   */
  readonly scanPrefix?: string;
}

function encode(command: readonly string[]): Buffer {
  const chunks = [Buffer.from(`*${String(command.length)}\r\n`)];
  for (const value of command) {
    const bytes = Buffer.from(value, "utf8");
    chunks.push(Buffer.from(`$${String(bytes.length)}\r\n`), bytes, Buffer.from("\r\n"));
  }
  return Buffer.concat(chunks);
}

/** Refuse the whole page rather than filtering/truncating an untrusted reply. */
function assertScopedScanReply(value: RedisValue, prefix: string | undefined): void {
  if (prefix === undefined || value === null || typeof value === "string" || value.kind !== "array" || value.values.length !== 2) throw new RedisReadError("protocol");
  const cursor = value.values[0];
  const keys = value.values[1];
  if (cursor === undefined || cursor === null || typeof cursor === "string" || cursor.kind !== "bytes"
    || keys === undefined || keys === null || typeof keys === "string" || keys.kind !== "array") throw new RedisReadError("protocol");
  const cursorBytes = Buffer.from(cursor.base64, "base64");
  const cursorText = cursorBytes.toString("utf8");
  if (!/^\d{1,20}$/u.test(cursorText) || BigInt(cursorText) > 18_446_744_073_709_551_615n) throw new RedisReadError("protocol");
  const literal = Buffer.from(prefix, "utf8");
  for (const key of keys.values) {
    if (key === null || typeof key === "string" || key.kind !== "bytes") throw new RedisReadError("protocol");
    const bytes = Buffer.from(key.base64, "base64");
    if (!bytes.subarray(0, literal.length).equals(literal)) throw new RedisReadError("protocol");
  }
}

/** Independent TypeScript RESP2 read executor. Each operation owns and destroys one socket. */
export class RedisNodeExecutor implements RedisReadExecutor {
  readonly #options: RedisNodeOptions;
  readonly #limits;

  public constructor(options: RedisNodeOptions) {
    if (typeof options.host !== "string" || options.host.length === 0 || /[\s/]/u.test(options.host) || options.host.includes(String.fromCharCode(0))) throw new TypeError("Redis host is invalid");
    if (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535)) throw new TypeError("Redis port is invalid");
    if (options.database !== undefined && (!Number.isSafeInteger(options.database) || options.database < 0)) throw new TypeError("Redis database is invalid");
    if (options.username !== undefined && options.password === undefined) throw new TypeError("Redis username requires a password");
    if (options.scanPrefix !== undefined && (typeof options.scanPrefix !== "string" || options.scanPrefix.length === 0)) throw new TypeError("Redis scanPrefix must be a nonempty literal prefix");
    this.#options = { ...options };
    this.#limits = resolveRedisLimits(options);
    const authBytes = Buffer.byteLength(options.username ?? "") + Buffer.byteLength(options.password ?? "") + 6;
    if (options.password !== undefined && authBytes > this.#limits.maxCommandBytes) throw new RedisReadError("limit");
  }

  public async execute(command: readonly string[], signal?: AbortSignal): Promise<RedisValue> {
    let admitted = validateRedisRead(command, this.#limits);
    if (admitted[0] === "SCAN") {
      if (this.#options.scanPrefix === undefined) throw new RedisReadError("policy");
      let pattern = "";
      for (const char of this.#options.scanPrefix) pattern += "\\*?[]".includes(char) ? `\\${char}` : char;
      pattern += "*";
      const match = admitted.indexOf("MATCH", 2);
      if (match === -1) admitted = [...admitted, "MATCH", pattern];
      else if (admitted[match + 1] !== pattern) throw new RedisReadError("policy");
      admitted = validateRedisRead(admitted, this.#limits);
    }
    const scope = createAbortScope(signal, this.#limits.timeoutMs);
    let socket: Socket | undefined;
    try {
      if (scope.signal.aborted) throw new QueryCancelledError("caller");
      const options = { host: this.#options.host, port: this.#options.port ?? 6379 };
      socket = this.#options.tls === true ? connectTls({ ...options, rejectUnauthorized: true }) : connectTcp(options);
      const owned = socket;
      // Install a persistent listener before awaiting readiness; never leak a raw socket error.
      owned.on("error", () => undefined);
      const ready = this.#options.tls === true ? "secureConnect" : "connect";
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => { owned.off(ready, onReady); owned.off("error", onError); scope.signal.removeEventListener("abort", onAbort); };
        const onReady = (): void => { cleanup(); resolve(); };
        const onError = (): void => { cleanup(); reject(new RedisReadError("transport")); };
        const onAbort = (): void => { cleanup(); owned.destroy(); reject(new QueryCancelledError(scope.callerAborted ? "caller" : "deadline")); };
        owned.once(ready, onReady); owned.once("error", onError); scope.signal.addEventListener("abort", onAbort, { once: true });
        if (scope.signal.aborted) onAbort();
      });
      const request = (args: readonly string[]): Promise<RedisValue> => new Promise((resolve, reject) => {
        let bytes: Buffer = Buffer.alloc(0);
        let settled = false;
        const cleanup = (): void => { owned.off("data", onData); owned.off("error", onError); owned.off("end", onError); owned.off("close", onError); scope.signal.removeEventListener("abort", onAbort); };
        const fail = (error: Error): void => { if (settled) return; settled = true; cleanup(); owned.destroy(); reject(error); };
        const onError = (): void => { fail(new RedisReadError("transport")); };
        const onAbort = (): void => { fail(new QueryCancelledError(scope.callerAborted ? "caller" : "deadline")); };
        const onData = (chunk: Buffer): void => {
          if (chunk.byteLength > this.#limits.maxReplyBytes - bytes.byteLength) { fail(new RedisReadError("limit")); return; }
          bytes = bytes.length === 0 ? chunk : Buffer.concat([bytes, chunk]);
          try {
            const parsed = parseRedisReply(bytes, this.#limits.maxReplyBytes);
            if (parsed === undefined) return;
            if (parsed.offset !== bytes.length) { fail(new RedisReadError("protocol")); return; }
            settled = true; cleanup(); resolve(parsed.value);
          } catch (error) { fail(error instanceof RedisReadError ? error : new RedisReadError("protocol")); }
        };
        owned.on("data", onData); owned.once("error", onError); owned.once("end", onError); owned.once("close", onError); scope.signal.addEventListener("abort", onAbort, { once: true });
        if (scope.signal.aborted) { onAbort(); return; }
        if (owned.destroyed) { onError(); return; }
        owned.write(encode(args));
      });
      const password = this.#options.password;
      if (password !== undefined) {
        const auth = this.#options.username === undefined ? ["AUTH", password] : ["AUTH", this.#options.username, password];
        if (await request(auth) !== "OK") throw new RedisReadError("protocol");
      }
      if (this.#options.database !== undefined && this.#options.database !== 0) {
        if (await request(["SELECT", String(this.#options.database)]) !== "OK") throw new RedisReadError("protocol");
      }
      const value = await request(admitted);
      if (admitted[0] === "SCAN") assertScopedScanReply(value, this.#options.scanPrefix);
      if (scope.callerAborted || scope.deadlineExceeded) throw new QueryCancelledError(scope.callerAborted ? "caller" : "deadline");
      return value;
    } catch (error) {
      if (error instanceof RedisReadError || error instanceof QueryCancelledError) throw error;
      throw new RedisReadError("transport");
    } finally {
      socket?.destroy();
      scope.dispose();
    }
  }
}

export { createRedisHttpHandler } from "./server.js";
export type { RedisHttpHandlerOptions } from "./server.js";
