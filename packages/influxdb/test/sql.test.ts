import { collection } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { compileInfluxDB3Query } from "../src/index.js";

const table = {
  table: "items",
  keyColumn: { column: "id", nullable: false },
  columns: { title: { column: "title", nullable: false }, rank: { column: "rank", nullable: false } },
} as const;

describe("compileInfluxDB3Query", () => {
  it("uses only configuration-derived identifiers and named WHERE values", () => {
    const items = collection<{ title: string; rank: number }>("items");
    const compiled = compileInfluxDB3Query(table, items.query().where("title", "==", "x' OR 1=1").orderBy("rank", "desc").startAfter(3, "id-3").build(), 5);
    expect(compiled.sql).toContain('t."title" = $p0');
    expect(compiled.sql).toContain('t."rank" < $c0');
    expect(compiled.sql).toContain('t."id" > $c1');
    expect(compiled.params).toEqual({ p0: "x' OR 1=1", c0: 3, c1: "id-3" });
  });
});
