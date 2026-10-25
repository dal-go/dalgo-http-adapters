import { DOCUMENT_ID, UnsupportedError, collection, collectionGroup, key } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { compileQdrantQuery } from "../src/query.js";

interface Product { price: number; tags: string[]; status: string }
const productOne = "123e4567-e89b-12d3-a456-426614174000";

describe("compileQdrantQuery", () => {
  it("maps honest payload and point-ID filters to Qdrant filter clauses", () => {
    const query = collection<Product>("products").query()
      .where("price", ">=", 10)
      .where("tags", "array-contains-any", ["sale", "new"])
      .where(DOCUMENT_ID, "in", [productOne, 2])
      .limit(5)
      .offset(3)
      .build();
    expect(compileQdrantQuery(query)).toEqual({
      filter: { must: [
        { key: "price", range: { gte: 10 } },
        { key: "tags", match: { any: ["sale", "new"] } },
        { has_id: [productOne, 2] },
      ] },
      limit: 5,
      offset: 3,
    });
  });

  it("uses a bounded default limit and rejects unsupported DALgo shapes", () => {
    expect(compileQdrantQuery(collection("items").query().build(), 7)).toEqual({ limit: 7 });
    expect(() => compileQdrantQuery(collectionGroup("items").build())).toThrow(UnsupportedError);
    expect(() => compileQdrantQuery(collection("items", { parent: key("parents", "p") }).query().build())).toThrow(UnsupportedError);
    expect(() => compileQdrantQuery(collection("items").query().orderBy("name").build())).toThrow(UnsupportedError);
    expect(() => compileQdrantQuery(collection("items").query().startAfter("x").build())).toThrow(UnsupportedError);
    expect(() => compileQdrantQuery(collection("items").query().limit(8).build(), 7)).toThrow("maxQueryLimit");
  });

  it("rejects negative, null, and malformed filter values instead of changing semantics", () => {
    expect(() => compileQdrantQuery(collection<Product>("products").query().where("status", "!=", "hidden").build())).toThrow(UnsupportedError);
    expect(() => compileQdrantQuery(collection<Product>("products").query().where("status", "==", null).build())).toThrow(UnsupportedError);
    expect(() => compileQdrantQuery(collection("products").query().where(DOCUMENT_ID, "==", -1).build())).toThrow("point IDs");
    expect(() => compileQdrantQuery(collection("products").query().where(DOCUMENT_ID, "==", "a/b").build())).toThrow("UUID");
    expect(() => compileQdrantQuery(collection("products").query().where(DOCUMENT_ID, "in", []).build())).toThrow("non-empty array");
    expect(() => compileQdrantQuery(collection<Product>("products").query().where("tags", "array-contains-any", [true]).build())).toThrow(UnsupportedError);
  });
});
