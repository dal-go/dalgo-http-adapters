import { collection, identityCodec, Key, UnsupportedError, type Database, type StructuredQuery, type Codec, type RecordSnapshot } from "@dalgo/core";
import { BigQueryDatabase, compileBigQueryQuery, type BigQueryTable } from "@dalgo/bigquery";
import { MetadataFixtureHarness, type SourceProfile } from "@dalgo/bigquery/analytical";

interface Item { title: string }
const items = collection<Item>("items");
const key: Key = items.key("one");
const codec: Codec<Item> = { encode: value => identityCodec.encode(value), decode: value => value as Item };
const query: StructuredQuery<Item> = items.query().limit(1).build();
const table: BigQueryTable = {
  datasetId: "synthetic", tableId: "items", keyColumn: { column: "id", type: "STRING" },
  columns: { title: { column: "title", type: "STRING" } },
};
const db: Database = new BigQueryDatabase({ projectId: "synthetic-project", accessToken: () => "synthetic", tables: { items: table } });
const record: Promise<RecordSnapshot<Item>> = db.get(key, codec);
void [record, db.query(query), compileBigQueryQuery("synthetic-project", table, query, 1), UnsupportedError, MetadataFixtureHarness];
const source: SourceProfile | undefined = undefined;
void source;
