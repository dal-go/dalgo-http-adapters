import { Key, collection } from "@dalgo/core";
import { QueryCancelledError, isCancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { ConvexDatabase, ConvexReadError } from "@dalgo/dalgo2convex";

export async function verifyBrowserRoots() {
  let tokenCalls = 0, callbackRan = false;
  const db = new ConvexDatabase({
    endpoint: "https://owned.convex.cloud",
    token: () => { tokenCalls++; throw new Error("unexpected browser credential acquisition"); },
    collections: { tasks: { getFunction: "dalgo:getTask" } },
    queries: { tasks: { path: "dalgo:listTasks", collection: "tasks" } },
  });
  if (!isCancellableQueryExecutor(db) || db.metadata().provenance !== "trusted-configuration") throw new Error("public configured facade changed");
  let error;
  try { await db.runReadwriteTransaction(async () => { callbackRan = true; }); } catch (failure) { error = failure; }
  if (!(error instanceof ConvexReadError) || error.code !== "not-implemented" || callbackRan) throw new Error("transaction refusal identity changed");
  const controller = new AbortController(); controller.abort("private-browser-cause");
  for (const read of [
    () => db.getWithSignal(new Key("tasks", "a"), controller.signal),
    () => db.getManyWithSignal([new Key("tasks", "a")], controller.signal),
    () => db.queryFunction("tasks", {}, { signal: controller.signal }),
    () => db.queryWithSignal(collection("tasks").query().build(), controller.signal),
  ]) {
    error = undefined;
    try { await read(); } catch (failure) { error = failure; }
    if (!(error instanceof QueryCancelledError) || error.reason !== "caller" || error.message.includes("private-browser-cause") || Object.hasOwn(error, "cause")) throw new Error("public cancellation identity changed");
  }
  if (tokenCalls !== 0) throw new Error("preabort invoked token supplier");
  db.close();
  return { coreAndPublicErrorIdentity: true, lazy: true };
}
