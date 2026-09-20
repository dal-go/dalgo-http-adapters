import {
  DOCUMENT_ID,
  UnsupportedError,
  collection,
  collectionGroup,
  key,
  type StructuredQuery,
} from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { compileElasticsearchQuery } from "../src/query.js";

interface Product { price: number; sku: string; tags: string[]; status: string }

function rawQuery(name: string): StructuredQuery<unknown> {
  return { source: { kind: "collection", name }, filters: [], orders: [] };
}

describe("compileElasticsearchQuery", () => {
  it("maps DALgo filters, sort, limit, and search_after", () => {
    const query = collection<Product>("products").query()
      .where("price", ">=", 10)
      .where("tags", "array-contains-any", ["sale", "new"])
      .where("status", "!=", "hidden")
      .orderBy("price", "desc")
      .orderBy("sku")
      .limit(5)
      .startAfter(10, "p1")
      .build();

    expect(compileElasticsearchQuery(query).body).toEqual({
      query: { bool: { filter: [
        { range: { price: { gte: 10 } } },
        { terms: { tags: ["sale", "new"] } },
        { bool: {
          filter: [{ exists: { field: "status" } }],
          must_not: [{ term: { status: "hidden" } }],
        } },
      ] } },
      sort: [{ price: "desc" }, { sku: "asc" }],
      size: 5,
      search_after: [10, "p1"],
    });
  });

  it("rejects collection groups, nested collections, and unrepresentable cursors", () => {
    expect(() => compileElasticsearchQuery(collectionGroup("items").build())).toThrow(UnsupportedError);
    expect(() => compileElasticsearchQuery(collection("items", { parent: key("parents", "p1") }).query().build())).toThrow(UnsupportedError);
    expect(() => compileElasticsearchQuery(collection("items").query().orderBy("name").startAt("a").build())).toThrow(UnsupportedError);
    expect(() => compileElasticsearchQuery(collection("items").query().startAfter("a").build())).toThrow(UnsupportedError);
    expect(() => compileElasticsearchQuery(collection("items").query().orderBy("name").offset(1).startAfter("a").build())).toThrow(UnsupportedError);
    expect(() => compileElasticsearchQuery(collection("items").query().orderBy(DOCUMENT_ID).build())).toThrow(UnsupportedError);
  });

  it("requires exact fields for negative membership filters", () => {
    const query = collection<Product>("products").query()
      .where("status", "not-in", ["hidden", "deleted"])
      .build();
    expect(compileElasticsearchQuery(query).body.query).toEqual({ bool: { filter: [{ bool: {
      filter: [{ exists: { field: "status" } }],
      must_not: [{ terms: { status: ["hidden", "deleted"] } }],
    } }] } });
  });

  it("rejects invalid Elasticsearch index names through the public compiler", () => {
    expect(() => compileElasticsearchQuery(rawQuery(""))).toThrow("index name is required");
    expect(() => compileElasticsearchQuery(rawQuery("x".repeat(256)))).toThrow("255 bytes");
    expect(() => compileElasticsearchQuery(rawQuery("Uppercase"))).toThrow("lowercase");
  });
});
