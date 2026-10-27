import { describe, expect, it } from "vitest";

import fixture from "../fixtures/conformance.json" with { type: "json" };

interface CancellationCase {
  readonly id: string;
  readonly phase: string;
  readonly expect: {
    readonly outcome: string;
    readonly reason?: string;
  };
}

interface ConformanceFixture {
  readonly format: string;
  readonly cancellation: { readonly cases: readonly CancellationCase[] };
  readonly page: { readonly types: readonly { readonly name: string }[] };
  readonly refusals: { readonly features: readonly string[] };
}

describe("conformance fixture", () => {
  const value = fixture as ConformanceFixture;

  it("has a stable format and unique cancellation cases", () => {
    expect(value.format).toBe("dalgo-adapter-conformance/1");
    expect(value.cancellation.cases.length).toBeGreaterThanOrEqual(8);
    const ids = value.cancellation.cases.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of value.cancellation.cases) {
      expect(item.phase).not.toBe("");
      expect(["cancelled", "redacted-error"]).toContain(item.expect.outcome);
      if (item.expect.outcome === "cancelled") {
        expect(["caller", "deadline"]).toContain(item.expect.reason);
      }
    }
  });

  it("documents JSON value preservation and explicit refusals", () => {
    expect(value.page.types.map((item) => item.name)).toEqual([
      "string",
      "safe-integer",
      "boolean",
      "null",
      "object",
      "array",
    ]);
    expect(value.refusals.features).toEqual([
      "projection",
      "joins",
      "aggregation",
      "grouping",
      "subquery",
      "fulltext",
      "timeseries",
      "native",
      "discovery",
    ]);
  });
});
