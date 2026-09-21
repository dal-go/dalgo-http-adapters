import { key } from "@dalgo/core";
import { describe, expect, it } from "vitest";
import { deserializeKey, serializeKey } from "../src/index.js";

describe("IndexedDB key serialization", () => {
  it("round-trips nested keys without losing numeric or escaped ids", () => {
    const original = key("items", "a/b", key("spaces", 42));
    const restored = deserializeKey(serializeKey(original));
    expect(restored.path).toBe(original.path);
    expect(restored.id).toBe("a/b");
    expect(restored.parent?.id).toBe(42);
  });
});
