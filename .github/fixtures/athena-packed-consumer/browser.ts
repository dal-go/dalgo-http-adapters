import { collection, type Database, type StructuredQuery } from "@dalgo/core";
import { type CancellableQueryExecutor, QueryCancelledError } from "@dalgo/adapter-runtime";
import {
  AthenaDatabase,
  AthenaError,
  AthenaNativeClient,
  type AthenaCursor,
  type AthenaLimits,
  type AthenaNativePage,
  type AthenaReceipt,
  type AthenaSource,
  type AthenaTable,
  type AthenaTransport,
} from "@dalgo/dalgo2athena";
import { AthenaHttpClient, type AthenaHttpOptions } from "@dalgo/dalgo2athena/browser";
import { createAthenaHttpHandler, type AthenaHttpHandlerOptions } from "@dalgo/dalgo2athena/http";

declare const signal: AbortSignal;
const table: AthenaTable = { table: "USERS", columns: { ID: "string", NAME: "string" }, idColumn: "ID" };
const limits: AthenaLimits = { maxConcurrent: 2, maxRows: 100, maxPages: 4, maxRequestBytes: 65_536, maxResponseBytes: 1_048_576 };
const source: AthenaSource = {
  sourceId: "synthetic-source", region: "eu-west-1", workGroup: "primary", catalog: "AwsDataCatalog", database: "analytics",
  outputLocation: "s3://owned-results/athena/", expectedBucketOwner: "123456789012", maxScanBytes: "1073741824",
  encryption: { option: "SSE_S3" }, tables: { users: table },
};
const transport: AthenaTransport = {
  authorize: ownedSignal => { ownedSignal.throwIfAborted(); return { principal: "browser-bridge", generation: "1" }; },
  request: (_action, _body, _authority, ownedSignal) => { ownedSignal.throwIfAborted(); return Promise.reject(new Error("synthetic bridge only")); },
};
const native = new AthenaNativeClient({ ...limits, source, transport });
const db = new AthenaDatabase(native);
const database: Database = db;
const cancellable: CancellableQueryExecutor = db;
const users = collection<Record<string, string | null>>("users");
const query: StructuredQuery<unknown> = users.query().where("NAME", "==", "Ada").limit(2).build();
const page: Promise<AthenaNativePage> = native.queryPage(query, { signal, pageSize: 10 });
async function readPage(): Promise<AthenaNativePage> {
  let current = await native.queryPage(query, { signal });
  const receipt: AthenaReceipt = current.receipt;
  const cursor: AthenaCursor | undefined = current.nextCursor;
  if (cursor !== undefined) current = await native.nextPage(cursor, signal);
  void receipt;
  return current;
}
const httpOptions: AthenaHttpOptions = {
  ...limits, endpoint: "https://owned.example.test/athena",
  headers: ownedSignal => { ownedSignal.throwIfAborted(); return { authorization: "synthetic-bridge" }; },
};
const reader = new AthenaHttpClient(httpOptions);
const handlerOptions: AthenaHttpHandlerOptions = { ...limits, allowedOrigins: ["https://app.example.test"], authorize: () => native };
const handler = createAthenaHttpHandler(handlerOptions);
// @ts-expect-error Browser declarations must not inject Node Buffer.
type ForbiddenBuffer = typeof Buffer;
// @ts-expect-error Browser declarations must not inject Node process.
type ForbiddenProcess = typeof process;
// @ts-expect-error Browser declarations must not inject the Node namespace.
type ForbiddenNamespace = NodeJS.Process;
// @ts-expect-error The browser-facing root must not expose the Node credential factory.
type ForbiddenNodeFactory = typeof import("@dalgo/dalgo2athena").createAthenaNodeClient;
// @ts-expect-error Browser bridge options must not accept a Node credential factory.
const invalidHttpOptions: AthenaHttpOptions = { ...httpOptions, credentials: () => ({ accessKeyId: "synthetic", secretAccessKey: "synthetic" }) };
void [database, cancellable, page, readPage, reader, handler, invalidHttpOptions, QueryCancelledError, AthenaError];
