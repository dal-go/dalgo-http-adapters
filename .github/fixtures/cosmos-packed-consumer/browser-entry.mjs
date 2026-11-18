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
  await verifyNativeBrowserRoots();
  return { coreAndErrorIdentity: true, lazy: true };
}

// Native roots share the SAME public core/error identity. This VM deliberately
// proves only import/laziness/preabort/codec behavior, not a browser query/CORS.
import { NativeCosmosNoSqlDatabase, nativeCosmosResourceToken, nativeCosmosNumber,
  encodeNativeCosmosJson } from "@dal-go/dalgo2cosmosdb";
async function verifyNativeBrowserRoots() {
  let calls = 0;
  const database = new NativeCosmosNoSqlDatabase({
    endpoint: "https://cosmos.example.test", databaseId: "fixture", containerId: "records",
    partitionKeyField: "tenant", authScopeId: "trusted-fixture-user",
    authorization: () => { calls++; return nativeCosmosResourceToken("type=resource&ver=1.0&sig=owned"); },
    collections: { items: { partition: "tenant:a" } },
  });
  const controller = new AbortController(); controller.abort("PRIVATE_NATIVE_CALLER");
  Object.defineProperty(controller.signal, "aborted", { get() { throw new Error("PRIVATE_SIGNAL_GETTER"); } });
  const nativeKey = { id: "original", partition: "tenant:a" };
  for (const read of [
    () => database.getNative(nativeKey, { signal: controller.signal }),
    () => database.getManyNative([nativeKey], { signal: controller.signal }),
    () => database.queryNative({ sql: "SELECT * FROM c", partition: "tenant:a" }, { signal: controller.signal }),
  ]) {
    let failure;
    try { await read(); } catch (error) { failure = error; }
    if (!(failure instanceof QueryCancelledError) || failure.reason !== "caller" || failure.message.includes("PRIVATE")) throw new Error("native public cancellation identity/redaction changed");
  }
  let invoked = false; let failure;
  try { await database.runReadwriteTransaction(() => { invoked = true; return Promise.resolve(1); }); } catch (error) { failure = error; }
  if (!(failure instanceof UnsupportedError) || invoked || calls !== 0) throw new Error("native unsupported authority/lazy root changed");
  if (encodeNativeCosmosJson({ wide: nativeCosmosNumber("9223372036854775807") }) !== '{"wide":9223372036854775807}') throw new Error("native public numeric codec changed");
  database.close();
}
