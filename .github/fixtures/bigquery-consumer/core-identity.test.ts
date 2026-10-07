import { collection, identityCodec, Key, UnsupportedError } from "@dalgo/core";
import { BigQueryDatabase } from "@dalgo/bigquery";
import { expect, it } from "vitest";
it("uses the consumer's canonical core keys, codec and UnsupportedError", async () => {
  const items = collection<{ title: string }>("items");
  const db = new BigQueryDatabase({ projectId: "synthetic-project", accessToken: () => "synthetic", tables: {
    items: { datasetId: "synthetic", tableId: "items", keyColumn: { column: "id", type: "STRING" }, columns: { title: { column: "title", type: "STRING" } } },
  }, fetch: async () => new Response(JSON.stringify({ jobComplete: true, jobReference: { jobId: "fixture" }, schema: { fields: [{ name: "__dalgo_key", type: "STRING" }, { name: "title", type: "STRING" }] }, rows: [{ f: [{ v: "one" }, { v: "hello" }] }] })) });
  const record = await db.get(items.key("one"), identityCodec);
  expect(record.key).toBeInstanceOf(Key);
  expect(record.data).toEqual({ title: "hello" });
  const page = await db.query(items.query().limit(1).build());
  expect(page.records[0]?.key).toBeInstanceOf(Key);
  await expect(db.runReadwriteTransaction(async () => undefined)).rejects.toBeInstanceOf(UnsupportedError);
});
