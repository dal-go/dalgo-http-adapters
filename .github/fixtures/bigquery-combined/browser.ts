// Authored synthetic responses only; no source admission or provider call.
import { collection, Key, UnsupportedError, type QueryExecutor, type QueryPage } from "@dalgo/core";
import { BigQueryDatabase } from "@dalgo/bigquery";
import { ECBQueryExecutor } from "@dalgo/http";
import * as root from "@dalgo/ovdb";
import * as dtql from "@dalgo/ovdb/dtql";
import { syntheticPlan } from "./http-fixture.js";
import { fixture, response } from "./dtql-fixture.js";

function nativePage(page: QueryPage<{ rate: string }>): void {
  if (page.records.length !== 1 || !(page.records[0]?.key instanceof Key) || page.records[0].data.rate !== "001.23000") throw new Error("shared core lexical/key identity lost");
}
export async function runCombinedConsumer(prepare: (endpoint: string, id: string, body: string, mode: string) => Promise<void>) {
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
  const plan = await syntheticPlan();
  const http: QueryExecutor = new ECBQueryExecutor({ collectionName: "daily", executorId: "synthetic-browser", providerReadPlan: plan, fetch: globalThis.fetch.bind(globalThis) });
  const httpPage = await http.query(collection<{ rate: string }>("daily").query().where("currency", "==", "AAA").limit(1).build());
  nativePage(httpPage);
  if (httpPage.sourceRights?.length !== 1 || httpPage.providerReads?.execution.id !== plan.execution.id) throw new Error("HTTP evidence lost");
  const ovdbRows = { default: 0, explicit: 0 };
  for (const mode of ["default", "explicit"] as const) {
    for (const Executor of [root.OpenVaultDbDTQLQueryExecutor, dtql.OpenVaultDbDTQLQueryExecutor]) {
      const owner = root.createOpenVaultDbExecutionBudget();
      try {
        const f = await fixture(root.createOpenVaultDbExecutionId(owner.budget));
        await prepare(f.config.endpoint, f.plan.execution.id, await response(f.metadata).text(), mode);
        const executor: QueryExecutor = new Executor({ ...f.config, providerReadPlan: f.plan, budget: owner.budget, ...(mode === "explicit" ? { fetch: globalThis.fetch } : {}) });
        const page = await executor.query(collection<{ rate: string }>("daily").query().limit(1).build());
        nativePage(page);
        await root.validateOpenVaultDbDTQLEvidence(page, f.plan, owner.budget);
        root.assertOpenVaultDbExecutionBudget(owner.budget);
        if (page.sourceRights?.length !== 1) throw new Error("OVDB evidence lost");
        ovdbRows[mode]++;
      } finally { owner.dispose(); }
    }
  }
  return { synthetic: true, coreVersion: "0.6.0", providerRequests: 0, bigqueryRows, httpRows: 1,
    bigqueryDefaultNativeFetch: true, bigqueryExplicitNativeFetch: true, sharedKeyIdentity: true,
    ovdbDefaultRows: ovdbRows.default, ovdbExplicitRows: ovdbRows.explicit };
}
