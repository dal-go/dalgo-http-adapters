import { collection } from "@dalgo/core";
import * as root from "@dalgo/ovdb";
import * as dtql from "@dalgo/ovdb/dtql";
import { fixture, response } from "./dtql-fixture.js";

export async function runSyntheticOVDBConsumer(): Promise<object> {
  const expected = ["OpenVaultDbDTQLQueryExecutor", "assertOpenVaultDbExecutionBudget", "createOpenVaultDbExecutionBudget", "createOpenVaultDbExecutionId", "raceOpenVaultDbExecutionBudget", "validateOpenVaultDbDTQLEvidence", "validateOpenVaultDbDTQLPlan"].sort();
  if (JSON.stringify(Object.keys(root).sort()) !== JSON.stringify(expected) || Object.keys(root).some(key => !(key in dtql))) throw new Error("public export inventory mismatch");
  const owner = root.createOpenVaultDbExecutionBudget(), f = await fixture(root.createOpenVaultDbExecutionId(owner.budget));
  let posts = 0;
  const count = (): number => posts;
  const fetcher: typeof fetch = (_input, init) => {
    posts++;
    if (init?.method !== "POST" || init.signal !== owner.budget.signal || init.credentials !== "omit" || init.cache !== "no-store") throw new Error("unsafe request");
    return Promise.resolve(response(f.metadata));
  };
  try {
    const executor = new dtql.OpenVaultDbDTQLQueryExecutor({ ...f.config, providerReadPlan: f.plan, budget: owner.budget, fetch: fetcher });
    const page = await executor.query(collection<{ rate: string }>("daily").query().build());
    if ((page.complete as unknown) !== true || page.records[0]?.data.rate !== "001.23000" || posts !== 1) throw new Error("incomplete synthetic output");
    await root.validateOpenVaultDbDTQLEvidence(page, f.plan, owner.budget);
    root.assertOpenVaultDbExecutionBudget(owner.budget);
    const refusal = new dtql.OpenVaultDbDTQLQueryExecutor({ ...f.config, providerReadPlan: f.plan, budget: owner.budget, fetch: fetcher });
    let refused = false;
    try { await refusal.query(collection("daily").query().limit(51).build()); } catch { refused = true; }
    if (!refused || count() !== 1) throw new Error("missing pre-I/O refusal");
    return { synthetic: true, providerRequests: 0, nativeRows: 1, preIORefusal: true, posts, core: "registry:0.6.0" };
  } finally { owner.dispose(); }
}
