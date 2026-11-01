import { key, UnsupportedError } from "@dalgo/core";
import { QueryCancelledError, isCancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { InfluxDB3Database } from "@dal-go/dalgo2influxdb";

export async function verifyBrowserRoots() {
  let tokenCalls = 0;
  const db = new InfluxDB3Database({ database: "fixture", serverUrl: "https://influx.example.test", accessToken: () => { tokenCalls++; throw new Error("unexpected browser credential acquisition"); }, tables: { items: { table: "items", keyColumn: { column: "id", nullable: false }, columns: { title: { column: "title" } } } } });
  if (!isCancellableQueryExecutor(db)) throw new Error("public cancellable contract changed");
  let callbackRan = false;
  let failure;
  try { await db.runReadwriteTransaction(async () => { callbackRan = true; }); } catch (error) { failure = error; }
  if (!(failure instanceof UnsupportedError) || callbackRan) throw new Error("unsupported callback/core identity changed");
  const controller = new AbortController(); controller.abort("owned-secret-cause");
  for (const read of [() => db.getWithSignal(key("items", "one"), controller.signal), () => db.getManyWithSignal([key("items", "one")], controller.signal), () => db.appendLineProtocolWithSignal(["fixture value=1"], controller.signal)]) {
    failure = undefined;
    try { await read(); } catch (error) { failure = error; }
    if (!(failure instanceof QueryCancelledError) || failure.reason !== "caller" || failure.message.includes("owned-secret-cause")) throw new Error("public cancellation identity changed");
  }
  if (tokenCalls !== 0) throw new Error("preabort acquired a token");
  return { coreAndErrorIdentity: true, lazy: true };
}
