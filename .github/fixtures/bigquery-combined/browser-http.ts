// Authored synthetic responses only; no source admission or provider call.
// BigQuery and HTTP sharing one strict registry core 0.8 instance.
import { collection, type QueryExecutor } from "@dalgo/core";
import { ECBQueryExecutor } from "@dalgo/http";
import { nativePage, runBigQuery } from "./bigquery.js";
import { syntheticPlan } from "./http-fixture.js";

export async function runCombinedConsumer(_prepare: (endpoint: string, id: string, body: string, mode: string) => Promise<void>) {
  const bigqueryRows = await runBigQuery();
  const plan = await syntheticPlan();
  const http: QueryExecutor = new ECBQueryExecutor({ collectionName: "daily", executorId: "synthetic-browser", providerReadPlan: plan, fetch: globalThis.fetch.bind(globalThis) });
  const httpPage = await http.query(collection<{ rate: string }>("daily").query().where("currency", "==", "AAA").limit(1).build());
  nativePage(httpPage);
  if (httpPage.sourceRights?.length !== 1 || httpPage.providerReads?.execution.id !== plan.execution.id) throw new Error("HTTP evidence lost");
  return { synthetic: true, coreVersion: "0.8.0", adapters: ["@dalgo/bigquery", "@dalgo/http"], providerRequests: 0, bigqueryRows, httpRows: 1,
    bigqueryDefaultNativeFetch: true, bigqueryExplicitNativeFetch: true, sharedKeyIdentity: true, ovdbDefaultRows: 0, ovdbExplicitRows: 0 };
}
