import { describe, expect, it, vi } from "vitest";
import { decodeNativeCosmosJson, encodeNativeCosmosJson, NativeCosmosError, NativeCosmosJsonNumber, nativeCosmosNumber } from "../src/index.js";

describe("native Cosmos exact JSON", () => {
  it("round-trips wide, fractional, exponent and negative-zero lexemes without number coercion", () => {
    const raw = '{"id":"original","wide":9223372036854775807,"fraction":1.230000000000000001,"exponent":1e+99,"zero":-0,"nested":[true,null,"😀"]}';
    const value = decodeNativeCosmosJson(raw);
    expect(encodeNativeCosmosJson(value)).toBe(raw);
    expect(nativeCosmosNumber("-0")).toBeInstanceOf(NativeCosmosJsonNumber);
    expect(Object.isFrozen(nativeCosmosNumber("1.00"))).toBe(true);
  });
  it("preserves own native keys and never interprets a lookalike object as a number tag", () => {
    const raw = '{"__proto__":{"own":true},"constructor":"data","prototype":null,"lexeme":"123","nested":{"$number":"456"}}';
    const value = decodeNativeCosmosJson(raw);
    expect(Object.getPrototypeOf(value)).toBe(null);
    expect(encodeNativeCosmosJson(value)).toBe(raw);
    expect(Object.prototype).not.toHaveProperty("own");
  });
  it("refuses duplicate names, malformed Unicode, trailing values and non-JSON numbers", () => {
    for (const raw of ['{"x":1,"x":2}', '"\\ud800"', '"\\udc00"', '"\ud800"', "{} []", "01", "+1", "NaN", "1e", "[1,]", '{"a":}', "1".repeat(129)]) {
      expect(() => decodeNativeCosmosJson(raw)).toThrow(NativeCosmosError);
    }
    for (const number of ["01", "NaN", "+1", "1".repeat(129)]) expect(() => nativeCosmosNumber(number)).toThrow(NativeCosmosError);
  });
  it("refuses cyclic, accessor, custom-class and sparse input without invoking foreign serializers", () => {
    const getter = vi.fn(() => "hidden"); const serializer = vi.fn(() => "hidden");
    const accessor = Object.defineProperty({}, "value", { get: getter, enumerable: true });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    class Custom { public toJSON = serializer; }
    const extra = [1]; Object.defineProperty(extra, "extra", { value: 2 });
    const sparse: unknown[] = []; sparse.length = 3; sparse[0] = 1; sparse[2] = 3;
    for (const value of [accessor, cycle, new Custom(), sparse, extra, { n: Infinity }, { n: 9007199254740992 }, { n: 1n }]) expect(() => encodeNativeCosmosJson(value)).toThrow(NativeCosmosError);
    expect(getter).not.toHaveBeenCalled(); expect(serializer).not.toHaveBeenCalled();
  });
  it("charges repeated escaped wire occurrences before constructing an over-budget result", () => {
    const shared = "\u0000".repeat(1000);
    expect(() => encodeNativeCosmosJson({ query: "SELECT * FROM c", parameters: [{ name: "@x", value: [shared, shared] }] }, 10_000)).toThrow(NativeCosmosError);
    const boundary = { s: '\n"\\😀' };
    const encoded = JSON.stringify(boundary); const bytes = new TextEncoder().encode(encoded).length;
    expect(encodeNativeCosmosJson(boundary, bytes)).toBe(encoded);
    expect(() => encodeNativeCosmosJson(boundary, bytes - 1)).toThrow(NativeCosmosError);
  });
  it("bounds nested structures and runs the supplied cancellation guard during traversal", () => {
    let nested: unknown = null;
    for (let i = 0; i < 34; i++) nested = [nested];
    expect(() => encodeNativeCosmosJson(nested)).toThrow(NativeCosmosError);
    expect(() => decodeNativeCosmosJson("[".repeat(34) + "null" + "]".repeat(34))).toThrow(NativeCosmosError);
    const stopped = new Error("owned stop");
    expect(() => encodeNativeCosmosJson({ item: 1 }, 100, () => { throw stopped; })).toThrow(stopped);
  });
});
