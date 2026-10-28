import { collection } from "@dalgo/core";

import { TypesenseDatabase, type TypesenseQuery } from "@dal-go/dalgo2typesense";

const db = new TypesenseDatabase({
  baseUrl: "http://127.0.0.1:8108",
  allowInsecureLoopbackHttp: true,
  collection: "books",
  headers: () => ({ "X-TYPESENSE-API-KEY": "search-key" }),
  metadataHeaders: () => ({ "X-TYPESENSE-API-KEY": "metadata-key" }),
});

const books = collection<{ title: string; genre: string; year: number }>("books");

const query: TypesenseQuery<{ title: string; year: number }> = {
  ...books
    .query()
    .where("year", ">=", 1965)
    .orderBy("year", "asc")
    .limit(20)
    .build(),
  projection: ["title", "year"],
  where: {
    kind: "or",
    conditions: [
      {
        left: { kind: "field", field: { field: "genre", source: "" } },
        operator: "==",
        right: { kind: "literal", value: "cyberpunk" },
      },
      {
        left: { kind: "field", field: { field: "genre", source: "" } },
        operator: "==",
        right: { kind: "literal", value: "science fiction" },
      },
    ],
  },
};

const page = await db.queryWithSignal(query, new AbortController().signal);
console.log(page.records.map((record) => record.key.id));

const native = await db.search({
  q: "Neuromancr",
  queryBy: ["title"],
  filterBy: "genre:=`cyberpunk`",
  sortBy: [{ field: "year", direction: "desc" }],
  facetBy: ["year"],
  limit: 10,
});
console.log(native.hits.map((hit) => hit.id), native.facets);

db.close();
