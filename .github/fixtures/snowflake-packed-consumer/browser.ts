import { collection, type Database, type QueryPage, type RecordSnapshot } from "@dalgo/core";
import { type CancellableQueryExecutor, QueryCancelledError } from "@dalgo/adapter-runtime";
import { SnowflakeDatabase, SnowflakeError, type SnowflakeOptions, type SnowflakeLimits } from "@dal-go/dalgo2snowflake";
declare const signal: AbortSignal;
const limits: SnowflakeLimits = { maxKeys: 10, maxPageBytes: 65_536, maxNodes: 10_000 };
const options: SnowflakeOptions = { ...limits, endpoint: "https://owned.snowflakecomputing.com", database: "DB", schema: "PUBLIC", tables: { users: { table: "USERS", idColumn: "ID" } }, token: ownedSignal => { ownedSignal?.throwIfAborted(); return "synthetic-broker-token"; } };
const db = new SnowflakeDatabase(options); const database: Database = db; const cancellable: CancellableQueryExecutor = db;
const users = collection<Record<string, string | null>>("users");
const one: Promise<RecordSnapshot<unknown>> = db.getWithSignal(users.key("a"), signal);
const many: Promise<readonly RecordSnapshot<unknown>[]> = db.getManyWithSignal([users.key("a")], signal);
const page: Promise<QueryPage<Record<string, string | null>>> = db.queryWithSignal(users.query().limit(2).build(), signal);
void [database, cancellable, one, many, page, QueryCancelledError, SnowflakeError]; db.close();
// @ts-expect-error Browser declarations must not inject Node Buffer.
type ForbiddenBuffer = typeof Buffer;
// @ts-expect-error Browser declarations must not inject Node process.
type ForbiddenProcess = typeof process;
// @ts-expect-error Browser declarations must not inject the Node namespace.
type ForbiddenNamespace = NodeJS.Process;
