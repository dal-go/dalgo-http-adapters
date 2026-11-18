import { RedisReadError, type RedisValue } from "./contracts.js";

interface Parsed { readonly value: RedisValue; readonly offset: number }

/** Incremental RESP2 parser, called only after the transport has capped received bytes. */
export function parseRedisReply(bytes: Uint8Array, maxBytes: number): Parsed | undefined {
  if (bytes.byteLength > maxBytes) throw new RedisReadError("limit");
  let nodes = 0;
  const ascii = new TextDecoder("utf-8", { fatal: true });
  const line = (start: number): { value: string; offset: number } | undefined => {
    for (let end = start; end + 1 < bytes.length; end++) {
      if (bytes[end] === 13 && bytes[end + 1] === 10) {
        try { return { value: ascii.decode(bytes.subarray(start, end)), offset: end + 2 }; }
        catch { throw new RedisReadError("protocol"); }
      }
    }
    return undefined;
  };
  const integer = (value: string): bigint => {
    if (!/^[+-]?\d+$/u.test(value) || value.length > 21) throw new RedisReadError("protocol");
    const n = BigInt(value);
    if (n < -9_223_372_036_854_775_808n || n > 9_223_372_036_854_775_807n) throw new RedisReadError("protocol");
    return n;
  };
  const parse = (start: number, depth: number): Parsed | undefined => {
    if (start >= bytes.length) return undefined;
    if (++nodes > 100_000 || depth > 32) throw new RedisReadError("limit");
    const header = line(start + 1);
    if (header === undefined) return undefined;
    const type = bytes[start];
    if (type === 43) return { value: header.value, offset: header.offset }; // +
    if (type === 45) throw new RedisReadError("denied"); // server details deliberately discarded
    if (type === 58) return { value: { kind: "integer", value: integer(header.value).toString() }, offset: header.offset };
    if (type !== 36 && type !== 42) throw new RedisReadError("protocol");
    const count = integer(header.value);
    if (count === -1n) return { value: null, offset: header.offset };
    if (count < 0n) throw new RedisReadError("protocol");
    if (count > BigInt(maxBytes)) throw new RedisReadError("limit");
    const length = Number(count);
    if (type === 36) {
      const end = header.offset + length;
      if (end + 2 > maxBytes) throw new RedisReadError("limit");
      if (bytes.length < end + 2) return undefined;
      if (bytes[end] !== 13 || bytes[end + 1] !== 10) throw new RedisReadError("protocol");
      // Browser-safe base64 conversion; no Buffer or server imports in this module.
      let raw = "";
      for (const byte of bytes.subarray(header.offset, end)) raw += String.fromCharCode(byte);
      return { value: { kind: "bytes", base64: btoa(raw) }, offset: end + 2 };
    }
    if (length > 100_000) throw new RedisReadError("limit");
    const values: RedisValue[] = [];
    let offset = header.offset;
    for (let i = 0; i < length; i++) {
      const child = parse(offset, depth + 1);
      if (child === undefined) return undefined;
      values.push(child.value);
      offset = child.offset;
    }
    return { value: { kind: "array", values }, offset };
  };
  return parse(0, 0);
}
