import { DOCUMENT_ID, UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { compileNeo4jQuery } from "../src/query.js";
import type { ResolvedCollection } from "../src/types.js";

const collections = new Map<string, ResolvedCollection>([
  ["items", { collection: "items", label: "Item", idProperty: "id" }],
]);

describe("compileNeo4jQuery", () => {
  it("uses configured quoted labels, parameter values, and deterministic ID ordering", () => {
    const query = collection<{ done: boolean; rank: number }>("items").query()
      .where("done", "==", false)
      .orderBy("rank", "desc")
      .limit(10)
      .build();
    expect(compileNeo4jQuery(query, collections)).toEqual({
      statement: "MATCH (n:`Item`) WHERE n.`done` = $filter0 RETURN n AS node ORDER BY n.`rank` DESC, n.`id` DESC LIMIT $limit",
      parameters: { filter0: false, limit: 10 },
      collection: collections.get("items"),
      orders: [{ field: "rank", direction: "desc" }, { field: DOCUMENT_ID, direction: "desc" }],
    });
  });

  it("compiles a lexicographic value cursor without embedding values", () => {
    const query = collection<{ rank: number }>("items").query()
      .orderBy("rank")
      .startAfter(4, "item-4")
      .build();
    const compiled = compileNeo4jQuery(query, collections);
    expect(compiled.statement).toContain("(n.`rank` > $startAfter0 OR n.`rank` = $startAfter0 AND n.`id` > $startAfter1)");
    expect(compiled.parameters).toMatchObject({ startAfter0: 4, startAfter1: "item-4" });
  });

  it("rejects hierarchical and graph-shaped DALgo query sources", () => {
    expect(() => compileNeo4jQuery(collection("items").in(key("spaces", "a")).query().build(), collections))
      .toThrow(UnsupportedError);
  });

  it("rejects unapproved field names and nullable cursor values", () => {
    expect(() => compileNeo4jQuery(collection("items").query().where("x; MATCH (n)", "==", 1).build(), collections)).toThrow(TypeError);
    expect(() => compileNeo4jQuery(collection("items").query().startAfter(null).build(), collections)).toThrow(TypeError);
  });

  it("rejects ambiguous null and malformed membership filter values", () => {
    expect(() => compileNeo4jQuery(collection("items").query().where("status", "==", null).build(), collections))
      .toThrow(UnsupportedError);
    expect(() => compileNeo4jQuery(collection("items").query().where("status", "in", "open").build(), collections))
      .toThrow(TypeError);
    expect(() => compileNeo4jQuery(collection("items").query().where("tags", "array-contains-any", ["a", null]).build(), collections))
      .toThrow(TypeError);
  });
});
