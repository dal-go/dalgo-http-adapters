import {
  DOCUMENT_ID,
  UnsupportedError,
  collection,
  collectionGroup,
  key,
  type StructuredQuery,
} from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { compileOpenSearchQuery } from "../src/query.js";

interface Product { price: number; sku: string; tags: string[]; status: string }

function rawQuery(name: string): StructuredQuery<unknown> {
  return { source: { kind: "collection", name }, filters: [], orders: [] };
}

describe("compileOpenSearchQuery", () => {
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

    expect(compileOpenSearchQuery(query).body).toEqual({
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
    expect(() => compileOpenSearchQuery(collectionGroup("items").build())).toThrow(UnsupportedError);
    expect(() => compileOpenSearchQuery(collection("items", { parent: key("parents", "p1") }).query().build())).toThrow(UnsupportedError);
    expect(() => compileOpenSearchQuery(collection("items").query().orderBy("name").startAt("a").build())).toThrow(UnsupportedError);
    expect(() => compileOpenSearchQuery(collection("items").query().startAfter("a").build())).toThrow(UnsupportedError);
    expect(() => compileOpenSearchQuery(collection("items").query().orderBy("name").offset(1).startAfter("a").build())).toThrow(UnsupportedError);
    expect(() => compileOpenSearchQuery(collection("items").query().orderBy(DOCUMENT_ID).build())).toThrow(UnsupportedError);
  });

  it("requires exact fields for negative membership filters", () => {
    const query = collection<Product>("products").query()
      .where("status", "not-in", ["hidden", "deleted"])
      .build();
    expect(compileOpenSearchQuery(query).body.query).toEqual({ bool: { filter: [{ bool: {
      filter: [{ exists: { field: "status" } }],
      must_not: [{ terms: { status: ["hidden", "deleted"] } }],
    } }] } });
  });

  it("maps null and empty membership filters without inventing term:null semantics", () => {
    const missing = compileOpenSearchQuery(collection<Product>("products").query().where("status", "==", null).build());
    expect(missing.body.query).toEqual({ bool: { filter: [{ bool: { must_not: [{ exists: { field: "status" } }] } }] } });
    const exists = compileOpenSearchQuery(collection<Product>("products").query().where("status", "!=", null).build());
    expect(exists.body.query).toEqual({ bool: { filter: [{ exists: { field: "status" } }] } });
    const none = compileOpenSearchQuery(collection<Product>("products").query().where("tags", "array-contains-any", []).build());
    expect(none.body.query).toEqual({ bool: { filter: [{ match_none: {} }] } });
  });

  it("requires string document IDs and a bounded size", () => {
    const documentId = collection<Product>("products").query().where(DOCUMENT_ID, "in", ["p1", "p2"]).build();
    expect(compileOpenSearchQuery(documentId).body.query).toEqual({ bool: { filter: [{ terms: { _id: ["p1", "p2"] } }] } });
    expect(() => compileOpenSearchQuery(collection<Product>("products").query().where(DOCUMENT_ID, "==", 1).build())).toThrow("string IDs");
    expect(() => compileOpenSearchQuery(collection<Product>("products").query().where(DOCUMENT_ID, "in", ["p1", 2]).build())).toThrow("array of strings");
    expect(() => compileOpenSearchQuery(collection("products").query().limit(2).build(), 1)).toThrow("maxQueryLimit");
    expect(compileOpenSearchQuery(collection("products").query().build(), 3).body.size).toBe(3);
  });

  it("rejects invalid OpenSearch index names through the public compiler", () => {
    expect(() => compileOpenSearchQuery(rawQuery(""))).toThrow("index name is required");
    expect(() => compileOpenSearchQuery(rawQuery("x".repeat(256)))).toThrow("255 bytes");
    expect(() => compileOpenSearchQuery(rawQuery("Uppercase"))).toThrow("lowercase");
  });
});
