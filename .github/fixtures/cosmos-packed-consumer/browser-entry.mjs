import { collection, key, UnsupportedError } from "@dalgo/core";
import { QueryCancelledError, isCancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { CosmosNoSqlDatabase } from "@dal-go/dalgo2cosmosdb";

export async function verifyBrowserRoots() {
  let tokenCalls = 0;
  const db = new CosmosNoSqlDatabase({ endpoint: "https://cosmos.example.test", databaseId: "fixture", containerId: "records", authorization: () => { tokenCalls++; throw new Error("unexpected browser credential acquisition"); } });
  if (!isCancellableQueryExecutor(db)) throw new Error("public cancellable contract changed");
  let callbackRan = false;
  let failure;
  try { await db.runReadwriteTransaction(async () => { callbackRan = true; }); } catch (error) { failure = error; }
  if (!(failure instanceof UnsupportedError) || callbackRan) throw new Error("unsupported callback/core identity changed");
  const controller = new AbortController(); controller.abort("owned-secret-cause");
  for (const read of [() => db.getWithSignal(key("items", "one"), controller.signal), () => db.getManyWithSignal([key("items", "one")], controller.signal), () => db.queryWithSignal(collection("items").query().limit(2).build(), controller.signal)]) {
    failure = undefined;
    try { await read(); } catch (error) { failure = error; }
    if (!(failure instanceof QueryCancelledError) || failure.reason !== "caller" || failure.message.includes("owned-secret-cause")) throw new Error("public cancellation identity changed");
  }
  if (tokenCalls !== 0) throw new Error("preabort acquired a token");
  return { coreAndErrorIdentity: true, lazy: true };
}
