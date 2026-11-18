import { describe, expect, it } from "vitest";
import { assertScopedRedisScanReply, parseRedisReply, RedisReadError, scopeRedisRead, type RedisValue } from "../src/protocol.js";

const bytes = (value: string): RedisValue => ({ kind: "bytes", base64: btoa(value) });
describe("transport-independent protocol entry", () => {
  it("forces literal SCAN scope and retains the strict read allowlist", () => {
    expect(scopeRedisRead(["scan", "0", "COUNT", "1"], "scope[*]?\\:")).toEqual(["SCAN", "0", "COUNT", "1", "MATCH", "scope\\[\\*\\]\\?\\\\:*"]);
    expect(() => scopeRedisRead(["SCAN", "0"], undefined)).toThrow(RedisReadError);
    expect(() => scopeRedisRead(["SCAN", "0", "MATCH", "*"], "scope:")).toThrow(RedisReadError);
    expect(() => scopeRedisRead(["KEYS", "scope:*"], "scope:")).toThrow(RedisReadError);
    expect(parseRedisReply(new TextEncoder().encode(":9223372036854775807\r\n"), 100)?.value).toEqual({ kind: "integer", value: "9223372036854775807" });
  });

  it("checks a whole SCAN page's actual size, uint64 cursor and literal byte prefix", () => {
    const page = (keys: readonly RedisValue[]): RedisValue => ({ kind: "array", values: [bytes("0"), { kind: "array", values: keys }] });
    expect(() => { assertScopedRedisScanReply(page(Array.from({ length: 256 }, () => bytes("scope:k"))), "scope:"); }).not.toThrow();
    expect(() => { assertScopedRedisScanReply(page(Array.from({ length: 257 }, () => bytes("scope:k"))), "scope:"); }).toThrow("Redis read failed (limit)");
    expect(() => { assertScopedRedisScanReply(page([bytes("scope:k"), bytes("foreign:k")]), "scope:"); }).toThrow("Redis read failed (protocol)");
    expect(() => { assertScopedRedisScanReply(page([{ kind: "bytes", base64: "c2NvcGU6AP8=" }]), "scope:"); }).not.toThrow();
    expect(() => { assertScopedRedisScanReply({ kind: "array", values: [bytes("18446744073709551616"), { kind: "array", values: [] }] }, "scope:"); }).toThrow(RedisReadError);
  });
});
