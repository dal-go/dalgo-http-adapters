// Authored synthetic responses only; no source admission or provider call.
// BigQuery and OVDB sharing one strict registry core 0.6 instance. This floor
// pairing remains required alongside OVDB's own modern-core release matrix.
import { collection, type QueryExecutor } from "@dalgo/core";
import * as root from "@dalgo/ovdb";
import * as tugql from "@dalgo/ovdb/tugql";
import { nativePage, runBigQuery } from "./bigquery.js";
import { fixture, response } from "./tugql-fixture.js";

export async function runCombinedConsumer(prepare: (endpoint: string, id: string, body: string, mode: string) => Promise<void>) {
  const bigqueryRows = await runBigQuery();
  const ovdbRows = { default: 0, explicit: 0 };
  for (const mode of ["default", "explicit"] as const) {
    for (const Executor of [root.OpenVaultDbTugQLQueryExecutor, tugql.OpenVaultDbTugQLQueryExecutor]) {
      const owner = root.createOpenVaultDbExecutionBudget();
      try {
        const f = await fixture(root.createOpenVaultDbExecutionId(owner.budget));
        await prepare(f.config.endpoint, f.plan.execution.id, await response(f.metadata).text(), mode);
        const executor: QueryExecutor = new Executor({ ...f.config, providerReadPlan: f.plan, budget: owner.budget, ...(mode === "explicit" ? { fetch: globalThis.fetch } : {}) });
        const page = await executor.query(collection<{ rate: string }>("daily").query().limit(1).build());
        nativePage(page);
        await root.validateOpenVaultDbTugQLEvidence(page, f.plan, owner.budget);
        root.assertOpenVaultDbExecutionBudget(owner.budget);
        if (page.sourceRights?.length !== 1) throw new Error("OVDB evidence lost");
        ovdbRows[mode]++;
      } finally { owner.dispose(); }
    }
  }
  return { synthetic: true, coreVersion: "0.6.0", adapters: ["@dalgo/bigquery", "@dalgo/ovdb"], providerRequests: 0, bigqueryRows, httpRows: 0,
    bigqueryDefaultNativeFetch: true, bigqueryExplicitNativeFetch: true, sharedKeyIdentity: true,
    ovdbDefaultRows: ovdbRows.default, ovdbExplicitRows: ovdbRows.explicit };
}
