/** Native RESP values. Bulk bytes and 64-bit integers never pass through JSON numbers. */
export type RedisValue = null | string
  | { readonly kind: "integer"; readonly value: string }
  | { readonly kind: "bytes"; readonly base64: string }
  | { readonly kind: "array"; readonly values: readonly RedisValue[] };

export interface RedisReadExecutor {
  execute(command: readonly string[], signal?: AbortSignal): Promise<RedisValue>;
}

export interface RedisLimits {
  readonly timeoutMs?: number;
  readonly maxCommandBytes?: number;
  readonly maxReplyBytes?: number;
  readonly maxArguments?: number;
  readonly maxScanCount?: number;
}

export interface ResolvedRedisLimits {
  readonly timeoutMs: number;
  readonly maxCommandBytes: number;
  readonly maxReplyBytes: number;
  readonly maxArguments: number;
  readonly maxScanCount: number;
}

/** Redacted failure: never contains endpoint, keys, credentials, or a server error. */
export class RedisReadError extends Error {
  public constructor(public readonly code: "policy" | "limit" | "protocol" | "transport" | "denied") {
    super(`Redis read failed (${code})`);
    this.name = "RedisReadError";
  }
}

export function resolveRedisLimits(input: RedisLimits = {}): ResolvedRedisLimits {
  const positive = (value: number | undefined, fallback: number): number => {
    const n = value ?? fallback;
    if (!Number.isSafeInteger(n) || n < 1) throw new TypeError("Redis limits must be positive safe integers");
    return n;
  };
  return {
    timeoutMs: positive(input.timeoutMs, 10_000),
    maxCommandBytes: positive(input.maxCommandBytes, 65_536),
    maxReplyBytes: positive(input.maxReplyBytes, 1_048_576),
    maxArguments: positive(input.maxArguments, 128),
    maxScanCount: positive(input.maxScanCount, 1_000),
  };
}

const singleKey = new Set(["GET", "TYPE", "TTL", "PTTL", "STRLEN", "HLEN", "LLEN", "SCARD", "ZCARD"]);
const keyAndField = new Set(["HGET", "HEXISTS", "ZSCORE"]);

/** The returned array is a copy: mutation by callers cannot change an admitted command. */
export function validateRedisRead(input: unknown, limits = resolveRedisLimits()): readonly string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new RedisReadError("policy");
  }
  const raw: readonly unknown[] = input;
  if (raw.length > limits.maxArguments + 1) throw new RedisReadError("limit");
  const command: string[] = [];
  let bytes = raw.length - 1;
  for (const part of raw) {
    if (typeof part !== "string") throw new RedisReadError("policy");
    bytes += new TextEncoder().encode(part).byteLength;
    if (bytes > limits.maxCommandBytes) throw new RedisReadError("limit");
    command.push(part);
  }
  const name = command[0]?.toUpperCase() ?? "";
  if (singleKey.has(name) && command.length === 2) return [name, ...command.slice(1)];
  if (keyAndField.has(name) && command.length === 3) return [name, ...command.slice(1)];
  if ((name === "MGET" || name === "EXISTS") && command.length >= 2) return [name, ...command.slice(1)];
  if (name === "HMGET" && command.length >= 3) return [name, ...command.slice(1)];
  if (name === "SCAN") {
    const cursor = command[1] ?? "";
    if (!/^\d{1,20}$/u.test(cursor) || BigInt(cursor) > 18_446_744_073_709_551_615n) throw new RedisReadError("policy");
    const seen = new Set<string>();
    let count: number | undefined;
    const args = [name, command[1] ?? "0"];
    for (let i = 2; i < command.length; i += 2) {
      const option = command[i]?.toUpperCase() ?? "";
      const value = command[i + 1];
      if (value === undefined || !["MATCH", "COUNT", "TYPE"].includes(option) || seen.has(option)) throw new RedisReadError("policy");
      seen.add(option);
      if (option === "COUNT") {
        if (!/^[1-9]\d*$/u.test(value)) throw new RedisReadError("policy");
        count = Number(value);
        if (!Number.isSafeInteger(count) || count > limits.maxScanCount) throw new RedisReadError("limit");
      }
      args.push(option, value);
    }
    if (count === undefined) args.push("COUNT", String(Math.min(100, limits.maxScanCount)));
    return args;
  }
  // KEYS, scripting, writes, transactions, administration and unbounded collection reads never reach a socket.
  throw new RedisReadError("policy");
}

export function isRedisValue(value: unknown, depth = 0, budget = { nodes: 0 }): value is RedisValue {
  if (++budget.nodes > 100_000 || depth > 32) return false;
  if (value === null || typeof value === "string") return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 2) return false;
  if (v.kind === "integer") {
    if (typeof v.value !== "string" || v.value.length > 21 || !/^-?(?:0|[1-9]\d*)$/u.test(v.value)) return false;
    const n = BigInt(v.value);
    return n >= -9_223_372_036_854_775_808n && n <= 9_223_372_036_854_775_807n;
  }
  if (v.kind === "bytes") return typeof v.base64 === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(v.base64);
  return v.kind === "array" && Array.isArray(v.values) && v.values.every((v: unknown) => isRedisValue(v, depth + 1, budget));
}
