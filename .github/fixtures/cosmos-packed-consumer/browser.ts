import { collection, key, type Database, type QueryPage, type RecordSnapshot } from "@dalgo/core";
import { type CancellableQueryExecutor, QueryCancelledError } from "@dalgo/adapter-runtime";
import { CosmosNoSqlDatabase, CosmosHttpError, CosmosTransportError, type CosmosNoSqlOptions, type CosmosAuthorizationRequest } from "@dal-go/dalgo2cosmosdb";

declare const signal: AbortSignal;
const options: CosmosNoSqlOptions = {
  endpoint: "https://cosmos.example.test", databaseId: "fixture", containerId: "records",
  authorization: (request: CosmosAuthorizationRequest) => { request.signal.throwIfAborted(); return "owned-read-resource-token"; },
  partitionKey: (path) => path,
};
const db = new CosmosNoSqlDatabase(options);
const database: Database = db;
const cancellable: CancellableQueryExecutor = db;
const items = collection<{ title: string; done: boolean }>("items");
const one: Promise<RecordSnapshot<{ title: string }>> = db.getWithSignal<{ title: string }>(key("items", "one"), signal);
const many: Promise<readonly RecordSnapshot<{ title: string }>[]> = db.getManyWithSignal<{ title: string }>([key("items", "one")], signal);
const page: Promise<QueryPage<{ title: string; done: boolean }>> = db.queryWithSignal(items.query().where("done", "==", false).limit(2).build(), signal);
const insert: Promise<void> = db.insert(key("items", "one"), { title: "fixture" });
const set: Promise<void> = db.set(key("items", "one"), { title: "fixture" });
const remove: Promise<void> = db.delete(key("items", "one"));
const compatible = new CosmosNoSqlDatabase({ ...options, authorization: () => "old-zero-argument-provider" });
void [database, cancellable, one, many, page, insert, set, remove, compatible, QueryCancelledError, CosmosHttpError, CosmosTransportError];
// @ts-expect-error Node Buffer must not enter this DOM-only program.
type ForbiddenBuffer = typeof Buffer;
// @ts-expect-error Node process must not enter this DOM-only program.
type ForbiddenProcess = typeof process;
// @ts-expect-error NodeJS namespace must not enter this DOM-only program.
type ForbiddenNamespace = NodeJS.Process;

// Additive native existing-document public API; managed contracts above remain.
import {
  NativeCosmosNoSqlDatabase, NativeCosmosError, NativeCosmosHttpError,
  NativeCosmosJsonNumber, nativeCosmosNumber, nativeCosmosResourceToken, nativeCosmosAadToken,
  encodeNativeCosmosJson, decodeNativeCosmosJson,
  type NativeCosmosNoSqlOptions, type NativeCosmosKey, type NativeCosmosReadResult,
  type NativeCosmosBatchResult, type NativeCosmosPage, type NativeCosmosJsonObject,
  type NativeCosmosAuthorizationRequest, type NativeCosmosSession, type NativeCosmosCursor,
} from "@dal-go/dalgo2cosmosdb";
const nativeOptions: NativeCosmosNoSqlOptions = {
  endpoint: "https://cosmos.example.test", databaseId: "fixture", containerId: "records",
  partitionKeyField: "tenant", authScopeId: "trusted-fixture-user",
  authorization: (request: NativeCosmosAuthorizationRequest) => {
    request.signal.throwIfAborted(); return nativeCosmosResourceToken("type=resource&ver=1.0&sig=owned+/=");
  },
  collections: { items: { partition: "tenant:a" } },
};
const native = new NativeCosmosNoSqlDatabase(nativeOptions);
const nativeDatabase: Database = native;
const nativeKey: NativeCosmosKey = { id: "original", partition: "tenant:a" };
const number: NativeCosmosJsonNumber = nativeCosmosNumber("9223372036854775807");
const nativeOne: Promise<NativeCosmosReadResult> = native.getNative(nativeKey, { signal });
const nativeMany: Promise<NativeCosmosBatchResult> = native.getManyNative([nativeKey, nativeKey], { signal });
const nativeExists: Promise<boolean> = native.existsNative(nativeKey, { signal });
declare const nativeSession: NativeCosmosSession;
declare const nativeCursor: NativeCosmosCursor;
const nativePage: Promise<NativeCosmosPage<NativeCosmosJsonObject>> = native.queryNative({
  sql: "SELECT * FROM c WHERE c.wide >= @wide", partition: "tenant:a", limit: 2,
  parameters: [{ name: "@wide", value: number }], cursor: nativeCursor,
}, { signal, session: nativeSession });
const nativeBridge: Promise<RecordSnapshot<NativeCosmosJsonObject>> = native.getWithSignal<NativeCosmosJsonObject>(key("items", "original"), signal);
const nativeInsert: Promise<void> = native.insert(key("items", "original"), { native: true });
const nativeTransaction: Promise<number> = native.runReadwriteTransaction(() => Promise.resolve(1));
const nativeData = decodeNativeCosmosJson(encodeNativeCosmosJson({ exact: number }));
void [nativeDatabase, nativeOne, nativeMany, nativeExists, nativePage, nativeBridge,
  nativeInsert, nativeTransaction, nativeData, nativeCosmosAadToken, NativeCosmosError, NativeCosmosHttpError];
native.close();
