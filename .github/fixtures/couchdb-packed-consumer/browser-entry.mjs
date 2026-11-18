import { collection, key, UnsupportedError } from "@dalgo/core";
import { QueryCancelledError, isCancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { CouchDbDatabase, NativeCouchDbDatabase } from "@dalgo/dalgo2couchdb";
export async function verifyBrowserRoots() {
  let headers = 0;
  const options = { databaseUrl: "https://couch.example.test/app", headers: () => { headers++; throw new Error("unexpected credential acquisition"); } };
  const databases = [new CouchDbDatabase(options), new NativeCouchDbDatabase({ ...options, collection: "items" })];
  for (const db of databases) {
    if (!isCancellableQueryExecutor(db)) throw new Error("public cancellable identity changed");
    let called = false; let failure;
    try { await db.runReadwriteTransaction(async () => { called = true; }); } catch (error) { failure = error; }
    if (!(failure instanceof UnsupportedError) || called) throw new Error("callback refusal/core identity changed");
    const caller = new AbortController(); caller.abort("owned-secret-cause");
    for (const read of [() => db.getWithSignal(key("items", "a"), caller.signal), () => db.getManyWithSignal([key("items", "a")], caller.signal), () => db.queryWithSignal(collection("items").query().limit(1).build(), caller.signal)]) {
      failure = undefined; try { await read(); } catch (error) { failure = error; }
      if (!(failure instanceof QueryCancelledError) || failure.reason !== "caller" || failure.message.includes("owned-secret-cause")) throw new Error("public cancellation identity changed");
    }
  }
  if (headers !== 0) throw new Error("lazy/preaborted browser acquired credentials");
  return { coreAndErrorIdentity: true, lazy: true };
}
