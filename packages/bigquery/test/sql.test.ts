import { collection } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { compileBigQueryQuery, parameter, type BigQueryTable } from "../src/index.js";

const table: BigQueryTable = {
  datasetId: "app_data",
  tableId: "items",
  keyColumn: { column: "id", type: "STRING", nullable: false },
  columns: {
    title: { column: "title", type: "STRING" },
    done: { column: "done", type: "BOOL" },
    rank: { column: "rank", type: "INT64", nullable: false },
  },
};

describe("compileBigQueryQuery", () => {
  it("uses quoted configured identifiers and named typed parameters", () => {
    const items = collection<{ done: boolean; rank: string }>("items");
    const compiled = compileBigQueryQuery("example-project", table, items.query()
      .where("done", "==", false)
      .where("rank", ">=", "10")
      .orderBy("rank")
      .limit(5)
      .build(), 6);

    expect(compiled.sql).toBe("SELECT t.`id` AS `__dalgo_key`, t.`title` AS `title`, t.`done` AS `done`, t.`rank` AS `rank` FROM `example-project.app_data.items` AS t WHERE t.`done` = @p0 AND t.`rank` >= @p1 ORDER BY t.`rank` ASC, t.`id` ASC LIMIT 6");
    expect(compiled.parameters).toEqual([
      { name: "p0", parameterType: { type: "BOOL" }, parameterValue: { value: "false" } },
      { name: "p1", parameterType: { type: "INT64" }, parameterValue: { value: "10" } },
    ]);
  });

  it("rejects unmapped fields and incomplete cursor values", () => {
    const items = collection<{ title: string; rank: string }>("items");
    expect(() => compileBigQueryQuery("example_project", table, items.query().where("title", "array-contains", "x").build(), 2))
      .toThrow("repeated columns");
    expect(() => compileBigQueryQuery("example_project", table, items.query().orderBy("rank").startAfter("x").build(), 2))
      .toThrow("cursor value count");
  });

  it("maps null equality to GoogleSQL null predicates without a null parameter", () => {
    const items = collection<{ title: string | null }>("items");
    const compiled = compileBigQueryQuery("example-project", table, items.query().where("title", "==", null).build(), 2);
    expect(compiled.sql).toContain("WHERE t.`title` IS NULL");
    expect(compiled.parameters).toEqual([]);
  });

  it("rejects malformed scalar values before they reach SQL", () => {
    expect(() => parameter("id", { column: "id", type: "INT64" }, "1e9")).toThrow("INT64");
    expect(() => parameter("price", { column: "price", type: "NUMERIC" }, Number.NaN)).toThrow("finite decimal");
    expect(() => parameter("title", { column: "title", type: "STRING" }, undefined)).toThrow("cannot be undefined");
  });
});
