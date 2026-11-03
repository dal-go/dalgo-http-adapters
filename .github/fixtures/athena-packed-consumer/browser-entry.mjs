import { collection, UnsupportedError } from "@dalgo/core";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { AthenaDatabase, AthenaError, AthenaNativeClient } from "@dalgo/dalgo2athena";
import { AthenaHttpClient } from "@dalgo/dalgo2athena/browser";
import { createAthenaHttpHandler } from "@dalgo/dalgo2athena/http";

export async function verifyBrowserRoots() {
  if (!(AthenaError.prototype instanceof Error) || !(QueryCancelledError.prototype instanceof Error)) throw new Error("public error identity changed");
  let nativeAuthorizeCalls = 0; let nativeRequestCalls = 0;
  const native = new AthenaNativeClient({
    source: {
      sourceId: "browser-native-source", region: "eu-west-1", workGroup: "primary", catalog: "AwsDataCatalog", database: "analytics",
      outputLocation: "s3://owned-results/athena/", expectedBucketOwner: "123456789012", maxScanBytes: "1073741824",
      encryption: { option: "SSE_S3" }, tables: { users: { table: "USERS", columns: { ID: "string", NAME: "string" }, idColumn: "ID" } },
    },
    transport: {
      authorize: () => { nativeAuthorizeCalls++; throw new Error("unexpected native identity"); },
      request: () => { nativeRequestCalls++; throw new Error("unexpected native transport"); },
    },
  });
  const nativeDatabase = new AthenaDatabase(native);
  let transactionCallbackRan = false;
  let nativeError;
  try { await nativeDatabase.runReadwriteTransaction(() => { transactionCallbackRan = true; return Promise.resolve(1); }); } catch (failure) { nativeError = failure; }
  if (!(nativeError instanceof UnsupportedError) || transactionCallbackRan) throw new Error("public core unsupported identity changed");
  if (nativeAuthorizeCalls !== 0 || nativeRequestCalls !== 0) throw new Error("unsupported transaction reached native identity or transport");
  let headerCalls = 0; let transportFetchCalls = 0;
  const database = new AthenaHttpClient({
    endpoint: "https://app.example.test/athena",
    headers: () => { headerCalls++; throw new Error("unexpected browser bridge header callback"); },
    fetch: () => { transportFetchCalls++; throw new Error("unexpected browser transport fetch"); },
  });
  if (headerCalls !== 0) throw new Error("lazy construction acquired bridge headers");
  const users = collection("users");
  const query = users.query().limit(1).build();
  const controller = new AbortController(); Object.defineProperty(controller.signal, "aborted", { get() { throw new Error("PRIVATE_SIGNAL_GETTER"); } }); controller.abort("PRIVATE_REASON");
  let error;
  try { await database.queryPage(query, { signal: controller.signal }); } catch (failure) { error = failure; }
  if (!(error instanceof QueryCancelledError) || error.reason !== "caller" || error.message.includes("PRIVATE")) throw new Error("public caller cancellation identity/redaction changed");
  if (headerCalls !== 0 || transportFetchCalls !== 0) throw new Error("preabort reached the bridge or transport");
  nativeError = undefined;
  try { await native.queryPage(collection("users").query().limit(1).build(), { signal: controller.signal }); } catch (failure) { nativeError = failure; }
  if (!(nativeError instanceof QueryCancelledError) || nativeError.reason !== "caller" || nativeError.message.includes("PRIVATE")) throw new Error("native caller cancellation identity/redaction changed");
  if (nativeAuthorizeCalls !== 0 || nativeRequestCalls !== 0) throw new Error("native preabort reached identity or transport");
  let authorizeCalls = 0;
  const handler = createAthenaHttpHandler({ allowedOrigins: ["https://app.example.test"], authorize: () => { authorizeCalls++; throw new Error("unexpected authorize callback"); } });
  const refused = await handler(new Request("https://app.example.test/athena", { method: "GET" }));
  if (refused.status !== 405 || authorizeCalls !== 0) throw new Error("unsupported operation invoked its callback");
  database.close(); nativeDatabase.close(); return { coreAndErrorIdentity: true, lazy: true };
}
