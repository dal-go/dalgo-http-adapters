// Authored synthetic responses only; no source admission or provider call.
// Shared BigQuery half of each strict shared-core browser consumer.
import { collection, Key, UnsupportedError, type QueryExecutor, type QueryPage } from "@dalgo/core";
import { BigQueryDatabase } from "@dalgo/bigquery";

export function nativePage(page: QueryPage<{ rate: string }>): void {
  if (page.records.length !== 1 || !(page.records[0]?.key instanceof Key) || page.records[0].data.rate !== "001.23000") throw new Error("shared core lexical/key identity lost");
}
export async function runBigQuery(): Promise<number> {
  let bigqueryRows = 0;
  for (const mode of ["default", "explicit"] as const) {
    const db = new BigQueryDatabase({ projectId: "synthetic-project", accessToken: () => "synthetic-token", timeoutMs: 1000, maxRows: 1, pageSize: 1,
      tables: { items: { datasetId: "synthetic", tableId: "items", keyColumn: { column: "id", type: "STRING" }, columns: { rate: { column: "rate", type: "STRING" } } } },
      ...(mode === "explicit" ? { fetch: globalThis.fetch } : {}) });
    const executor: QueryExecutor = db;
    nativePage(await executor.query(collection<{ rate: string }>("items").query().limit(1).build()));
    let refused = false;
    try { await db.runReadwriteTransaction(async () => undefined); } catch (e) { refused = e instanceof UnsupportedError; }
    if (!refused) throw new Error("shared core error identity lost");
    bigqueryRows++;
  }
  return bigqueryRows;
}
