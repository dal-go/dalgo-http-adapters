import { collection, type Codec, type Database, type QueryPage, type RecordSnapshot, type StructuredQuery } from "@dalgo/core";
import { type CancellableQueryExecutor, QueryCancelledError } from "@dalgo/adapter-runtime";
import {
  AthenaDatabase,
  AthenaError,
  AthenaNativeClient,
  type AthenaColumn,
  type AthenaCounters,
  type AthenaCursor,
  type AthenaLimits,
  type AthenaNativePage,
  type AthenaOptions,
  type AthenaReadOptions,
  type AthenaReceipt,
  type AthenaSource,
  type AthenaTable,
  type AthenaTransport,
} from "@dalgo/dalgo2athena";
import { createAthenaHttpHandler, type AthenaHttpHandlerOptions } from "@dalgo/dalgo2athena/http";
import { AthenaHttpClient, type AthenaHttpOptions } from "@dalgo/dalgo2athena/browser";
import { createAthenaNodeClient, createAthenaNodeTransport, type AthenaNodeCredential, type AthenaNodeOptions } from "@dalgo/dalgo2athena/node";

declare const signal: AbortSignal;
const table: AthenaTable = { table: "USERS", columns: { ID: "string", NAME: "string" }, idColumn: "ID" };
const limits: AthenaLimits = { maxConcurrent: 2, maxRows: 100, maxPages: 4, maxRequestBytes: 65_536, maxResponseBytes: 1_048_576, pollIntervalMs: 250 };
const source: AthenaSource = {
  sourceId: "synthetic-source", region: "eu-west-1", workGroup: "primary", catalog: "AwsDataCatalog", database: "analytics",
  outputLocation: "s3://owned-results/athena/", expectedBucketOwner: "123456789012", maxScanBytes: "1073741824",
  encryption: { option: "SSE_S3" }, tables: { users: table },
};
const nodeOptions: AthenaNodeOptions = {
  ...limits, source,
  credentials: async (ownedSignal: AbortSignal): Promise<AthenaNodeCredential> => {
    ownedSignal.throwIfAborted();
    return {
      principal: "synthetic-read-only-principal", generation: "1", accessKeyId: "SYNTHETICACCESSKEY",
      secretAccessKey: "synthetic-secret-value", sessionToken: "synthetic-session-token", expiresAt: Date.now() + 60_000,
    };
  },
};
const transport: AthenaTransport = createAthenaNodeTransport(nodeOptions);
const options: AthenaOptions = { ...limits, source, transport };
const native: AthenaNativeClient = new AthenaNativeClient(options);
const nodeNative: AthenaNativeClient = createAthenaNodeClient(nodeOptions);
const db = new AthenaDatabase(native);
const database: Database = db;
const cancellable: CancellableQueryExecutor = db;
const users = collection<Record<string, string | null>>("users");
const key = users.key("a");
const query: StructuredQuery<Record<string, string | null>> = users.query().where("NAME", "==", "Ada").limit(2).build();
const nativeQuery: StructuredQuery<unknown> = collection<unknown>("users").query().where("NAME", "==", "Ada").limit(2).build();
const codec: Codec<{ name: string }> = { encode: value => value, decode: value => ({ name: String((value as Record<string, unknown>).NAME) }) };
const one: Promise<RecordSnapshot<{ name: string }>> = db.getWithSignal(key, signal, codec);
const many: Promise<readonly RecordSnapshot<{ name: string }>[]> = db.getManyWithSignal([key], signal, codec);
const page: Promise<QueryPage<Record<string, string | null>>> = db.queryWithSignal(query, signal);
const original: Promise<RecordSnapshot<unknown>> = db.get(key);
const transaction: Promise<number> = db.runReadwriteTransaction(() => Promise.resolve(1));
const readOptions: AthenaReadOptions = { signal, pageSize: 100 };
async function readNativePages(): Promise<readonly (readonly (string | null)[])[]> {
  let current: AthenaNativePage = await native.queryPage(nativeQuery, readOptions);
  const columns: readonly AthenaColumn[] = current.columns;
  const receipt: AthenaReceipt = current.receipt;
  const counters: Readonly<AthenaCounters> = receipt.counters;
  const rows: readonly (readonly (string | null)[])[] = current.rows;
  const cursor: AthenaCursor | undefined = current.nextCursor;
  if (cursor !== undefined) current = await native.nextPage(cursor, signal);
  void [columns, counters, cursor, current];
  return rows;
}
const httpOptions: AthenaHttpOptions = {
  ...limits, endpoint: "https://owned.example.test/athena",
  headers: ownedSignal => { ownedSignal.throwIfAborted(); return Promise.resolve({ authorization: "synthetic-bridge" }); },
};
const browserReader = new AthenaHttpClient(httpOptions);
const bridged: Promise<AthenaNativePage> = browserReader.queryPage(nativeQuery, readOptions);
const handlerOptions: AthenaHttpHandlerOptions = { ...limits, allowedOrigins: ["https://app.example.test"], authorize: async () => native };
const handler = createAthenaHttpHandler(handlerOptions);
// @ts-expect-error Native reads expose bounded pages, not arbitrary raw SQL execution.
native.execute("SELECT * FROM USERS");
// @ts-expect-error A raw next-token string is not a branded AthenaCursor.
native.nextPage("raw-next-token");
// @ts-expect-error Static credential text is not a credential-provider function.
const invalidNodeOptions: AthenaNodeOptions = { ...nodeOptions, credentials: "must-not-be-a-static-credential" };
// @ts-expect-error Unsupported client constructor options are not silently accepted.
const invalidNative: AthenaNativeClient = new AthenaNativeClient({ ...options, rawSQL: "SELECT * FROM USERS" });
void [database, cancellable, key, one, many, page, original, transaction, readNativePages, nodeNative, browserReader, bridged, handler, invalidNodeOptions, invalidNative, nativeQuery, AthenaError, QueryCancelledError];
db.close();
