import { RedisReadError, resolveRedisLimits, validateRedisRead, type RedisValue, type ResolvedRedisLimits } from "./contracts.js";

export { parseRedisReply } from "./resp.js";
export { RedisReadError, resolveRedisLimits, validateRedisRead } from "./contracts.js";
export type { RedisLimits, RedisReadExecutor, RedisValue, ResolvedRedisLimits } from "./contracts.js";

/** Transport-independent admission; SCAN always uses an authorized literal prefix. */
export function scopeRedisRead(input: unknown, prefix: string | undefined, limits: ResolvedRedisLimits = resolveRedisLimits()): readonly string[] {
  let admitted = validateRedisRead(input, limits);
  if (admitted[0] !== "SCAN") return admitted;
  if (typeof prefix !== "string" || prefix.length === 0) throw new RedisReadError("policy");
  let pattern = "";
  for (const char of prefix) pattern += "\\*?[]".includes(char) ? `\\${char}` : char;
  pattern += "*";
  const match = admitted.indexOf("MATCH", 2);
  if (match === -1) admitted = [...admitted, "MATCH", pattern];
  else if (admitted[match + 1] !== pattern) throw new RedisReadError("policy");
  return validateRedisRead(admitted, limits);
}

function bytes(value: string): Uint8Array {
  try {
    const raw = atob(value);
    return Uint8Array.from(raw, char => char.charCodeAt(0));
  } catch { throw new RedisReadError("protocol"); }
}

/** Refuse a malformed/oversized/foreign whole page, never filter or truncate it.
 * COUNT is a hint, so it is not used as a returned-key bound.
 */
export function assertScopedRedisScanReply(value: RedisValue, prefix: string | undefined): void {
  if (prefix === undefined || prefix.length === 0 || value === null || typeof value === "string" || value.kind !== "array" || value.values.length !== 2) throw new RedisReadError("protocol");
  const cursor = value.values[0];
  const keys = value.values[1];
  if (cursor === undefined || cursor === null || typeof cursor === "string" || cursor.kind !== "bytes"
    || keys === undefined || keys === null || typeof keys === "string" || keys.kind !== "array") throw new RedisReadError("protocol");
  const cursorBytes = bytes(cursor.base64);
  const cursorText = new TextDecoder().decode(cursorBytes);
  if (!/^\d{1,20}$/u.test(cursorText) || BigInt(cursorText) > 18_446_744_073_709_551_615n) throw new RedisReadError("protocol");
  if (keys.values.length > 256) throw new RedisReadError("limit");
  const literal = new TextEncoder().encode(prefix);
  for (const key of keys.values) {
    if (key === null || typeof key === "string" || key.kind !== "bytes") throw new RedisReadError("protocol");
    const data = bytes(key.base64);
    if (data.length < literal.length || literal.some((byte, index) => data[index] !== byte)) throw new RedisReadError("protocol");
  }
}
