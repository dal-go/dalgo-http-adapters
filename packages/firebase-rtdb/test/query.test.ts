import { UnsupportedError, collection, collectionGroup } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { compileRtdbQuery } from "../src/query.js";
const reference = {} as never;
describe("RTDB query limits", () => {
  it("rejects collection groups and unsupported composition before SDK access", () => { expect(() => compileRtdbQuery(reference, collectionGroup<{ rank: number }>("items").build())).toThrow(UnsupportedError); expect(() => compileRtdbQuery(reference, collection<{ rank: number }>("items").query().where("rank", "in", [1]).build())).toThrow(UnsupportedError); expect(() => compileRtdbQuery(reference, collection<{ rank: number }>("items").query().orderBy("rank", "desc").build())).toThrow(UnsupportedError); });
});
