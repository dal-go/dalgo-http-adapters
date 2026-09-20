import { Key, UnsupportedError } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { assertSafeKey, keyFromRtdbPath, rtdbCollectionPath } from "../src/path.js";
describe("RTDB paths", () => { it("round-trips nested keys", () => { const key = new Key("spaces", "one").child("items", "milk"); expect(keyFromRtdbPath(key.path).path).toBe(key.path); expect(rtdbCollectionPath({ kind: "collection", name: "items", parent: new Key("spaces", "one") })).toBe("spaces/one/items"); }); it("rejects numeric and Firebase-reserved key IDs", () => { expect(() => { assertSafeKey(new Key("items", 1)); }).toThrow(UnsupportedError); expect(() => { assertSafeKey(new Key("items", "bad.name")); }).toThrow(UnsupportedError); }); });
