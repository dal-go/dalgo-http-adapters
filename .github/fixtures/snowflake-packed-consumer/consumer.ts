import { collection, type Database, type Codec, type QueryPage, type RecordSnapshot } from "@dalgo/core";
import { type CancellableQueryExecutor, QueryCancelledError } from "@dalgo/adapter-runtime";
import { SnowflakeDatabase, SnowflakeError, type SnowflakeOptions, type SnowflakeTable, type SnowflakeLimits } from "@dal-go/dalgo2snowflake";

declare const signal: AbortSignal;
const table: SnowflakeTable = { table: "USERS", idColumn: "ID", idType: "string" };
const limits: SnowflakeLimits = { maxConcurrent: 2, maxRequestBytes: 65_536, maxResponseBytes: 1_048_576, maxPartitions: 16 };
const options: SnowflakeOptions = {
  ...limits, endpoint: "https://owned.snowflakecomputing.com", database: "DB", schema: "PUBLIC", warehouse: "WAREHOUSE",
  tables: { users: table }, token: ownedSignal => { ownedSignal?.throwIfAborted(); return Promise.resolve("synthetic-read-only-token"); }, tokenType: "KEYPAIR_JWT",
};
const db = new SnowflakeDatabase(options); const database: Database = db; const cancellable: CancellableQueryExecutor = db;
const users = collection<Record<string, string | null>>("users");
const codec: Codec<{ name: string }> = { encode: value => value, decode: value => ({ name: String((value as Record<string, unknown>).NAME) }) };
const one: Promise<RecordSnapshot<{ name: string }>> = db.getWithSignal(users.key("a"), signal, codec);
const many: Promise<readonly RecordSnapshot<{ name: string }>[]> = db.getManyWithSignal([users.key("a"), users.key("a")], signal, codec);
const page: Promise<QueryPage<Record<string, string | null>>> = db.queryWithSignal(users.query().where("NAME", "==", "Ada").limit(2).build(), signal);
const original: Promise<RecordSnapshot<unknown>> = db.get(users.key("a"));
const transaction: Promise<number> = db.runReadwriteTransaction(() => Promise.resolve(1));
// @ts-expect-error Static token text is not a credential-provider function.
const invalid: SnowflakeOptions = { ...options, token: "must-not-be-a-static-credential" };
// @ts-expect-error No arbitrary SQL execution API is introduced by native-table reads.
db.execute("DELETE FROM USERS");
void [database, cancellable, one, many, page, original, transaction, invalid, QueryCancelledError, SnowflakeError];
db.close(); const nodeBuffer: Buffer = Buffer.from("Node profile only"); void nodeBuffer;
