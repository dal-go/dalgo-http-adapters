import { collection, UnsupportedError } from "@dalgo/core";
import { QueryCancelledError, isCancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { SnowflakeDatabase, SnowflakeError } from "@dal-go/dalgo2snowflake";

export async function verifyBrowserRoots() {
  let tokenCalls = 0;
  const database = new SnowflakeDatabase({ endpoint: "https://owned.snowflakecomputing.com", database: "DB", schema: "PUBLIC", tables: { users: { table: "USERS", idColumn: "ID" } }, token: () => { tokenCalls++; throw new Error("unexpected browser token callback"); } });
  if (!isCancellableQueryExecutor(database)) throw new Error("public cancellable identity changed");
  let callbackRan = false; let error;
  try { await database.runReadwriteTransaction(() => { callbackRan = true; return Promise.resolve(1); }); } catch (failure) { error = failure; }
  if (!(error instanceof UnsupportedError) || callbackRan) throw new Error("public core unsupported identity changed");
  const controller = new AbortController(); Object.defineProperty(controller.signal, "aborted", { get() { throw new Error("PRIVATE_SIGNAL_GETTER"); } }); controller.abort("PRIVATE_REASON");
  const users = collection("users");
  for (const read of [() => database.getWithSignal(users.key("a"), controller.signal), () => database.getManyWithSignal([users.key("a")], controller.signal), () => database.queryWithSignal(users.query().limit(1).build(), controller.signal)]) {
    error = undefined; try { await read(); } catch (failure) { error = failure; }
    if (!(error instanceof QueryCancelledError) || error.reason !== "caller" || error.message.includes("PRIVATE")) throw new Error("public caller cancellation identity/redaction changed");
  }
  if (tokenCalls !== 0) throw new Error("preabort acquired a credential");
  if (!(new SnowflakeError("owned class identity") instanceof Error)) throw new Error("public adapter error export changed");
  database.close(); return { coreAndErrorIdentity: true, lazy: true };
}
