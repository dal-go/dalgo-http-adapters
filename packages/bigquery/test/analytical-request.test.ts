import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileReadPlan, queryRequest, type Execution, bounds, type SourceProfile } from "../src/analytical.js";
import { wireParameters } from "../src/analytical/protocol.js";

const source: SourceProfile = {
  version: 1, sourceId: "synthetic", descriptorDigest: "synthetic", logicalCollection: "sample",
  sourceProject: "source-project", datasetId: "ds", tableId: "tbl", location: "EU",
  schema: [{ name: "ts", type: "TIMESTAMP", mode: "NULLABLE" }],
  publisherReviewRef: "synthetic", rightsReviewRef: "synthetic", use: "connection-test",
};
const execution: Execution = {
  jobProject: "job-project", principal: { kind: "workload", subject: "synthetic", generation: "1" },
  maximumBytesBilled: "1000", sessionBudgetBytes: "3000",
};
const fixtureBytes = readFileSync(new URL("../testdata/requests/timestamp-parameters-r1.json", import.meta.url));
expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe("0b78ab6eca04922b20dca7cfbf0a8e449dc8744a9fdb57556cba71747d30f930");
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  version: number; cases: { epochMicroseconds: string; wireUTC: string }[];
};
describe("exact TIMESTAMP REST requests", () => {
  it.each(fixture.cases)("serializes scalar and IN epoch $epochMicroseconds without changing the canonical plan", async example => {
    for (const op of ["=", "IN"] as const) {
      const value = op === "IN" ? [example.epochMicroseconds] : example.epochMicroseconds;
      const plan = await compileReadPlan(source, {
        from: "sample", projection: ["ts"], where: { op, column: "ts", value }, order: [], limit: 1,
      });
      expect(plan.parameters[0]?.value).toEqual(value);
      const expected = op === "IN"
        ? `[{"name":"p0","parameterType":{"type":"ARRAY","arrayType":{"type":"TIMESTAMP"}},"parameterValue":{"arrayValues":[{"value":"${example.wireUTC}"}]}}]`
        : `[{"name":"p0","parameterType":{"type":"TIMESTAMP"},"parameterValue":{"value":"${example.wireUTC}"}}]`;
      expect(JSON.stringify(wireParameters(plan.parameters))).toBe(expected);
      for (const dryRun of [true, false]) {
        const request = queryRequest(plan, execution, bounds(), source.location, dryRun) as { queryParameters: unknown };
        expect(JSON.stringify(request.queryParameters)).toBe(expected);
      }
      expect(plan.parameters[0]?.value).toEqual(value);
    }
  });
  it("preserves explicit typed NULL and validates TIMESTAMP bounds before serialization", () => {
    expect(wireParameters([{ name: "p0", type: "TIMESTAMP", value: null }])).toEqual([
      { name: "p0", parameterType: { type: "TIMESTAMP" }, parameterValue: { value: null } },
    ]);
    for (const value of ["-62135596800000001", "253402300800000000", "1.5", "1\n"]) {
      expect(() => wireParameters([{ name: "p0", type: "TIMESTAMP", value }])).toThrow("unsupported_value");
    }
  });
});
