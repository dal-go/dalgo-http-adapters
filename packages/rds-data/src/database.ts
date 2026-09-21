import { ExecuteStatementCommand, type ExecuteStatementCommandOutput, type Field, type SqlParameter } from "@aws-sdk/client-rds-data";
import { AlreadyExistsError, Key, UnsupportedError, identityCodec, type Codec, type Database, type ExistingRecord, type QueryPage, type ReadwriteTransaction, type RecordSnapshot, type StructuredQuery, type UpdateData } from "@dal-go/dalgo";
import { compileRdsQuery, quoteIdentifier, quoteTable, rdsKeyValue, rdsScalar, type RdsParameter } from "./sql.js";
import type { RdsDataDatabaseOptions, RdsDataTable } from "./types.js";

const isBrowser = typeof window !== "undefined" && typeof window.document !== "undefined";
type Scalar = string | number | boolean | null;
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function positive(value: number | undefined, fallback: number, label: string): number { const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${label} must be a positive safe integer`); return result; }
function codecOr<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }

/** Redacted adapter error. Service responses, SQL and parameter values are deliberately not exposed. */
export class RdsDataError extends Error { public constructor(message: string) { super(message); this.name = "RdsDataError"; } }

function frozenTables(tables: Readonly<Record<string, RdsDataTable>>, dialect: RdsDataDatabaseOptions["dialect"]): Readonly<Record<string, RdsDataTable>> {
  const result: Record<string, RdsDataTable> = {};
  for (const [collection, table] of Object.entries(tables)) {
    if (collection.length === 0) throw new TypeError("collection mapping must not be empty");
    quoteTable(table, dialect); quoteIdentifier(table.keyColumn, dialect, "keyColumn");
    if (table.keyType !== "string" && table.keyType !== "integer") throw new TypeError("keyType must be string or integer");
    if (table.uniqueKey !== undefined && table.uniqueKey !== true && table.uniqueKey !== false) throw new TypeError("uniqueKey must be a boolean");
    if (Object.hasOwn(table.columns, "__dalgo_key")) throw new TypeError("__dalgo_key is reserved");
    const physical = [table.keyColumn, ...Object.values(table.columns)];
    if (new Set(physical).size !== physical.length) throw new TypeError("keyColumn and mapped physical columns must be unique");
    for (const [field, column] of Object.entries(table.columns)) { quoteIdentifier(field, dialect, "field"); quoteIdentifier(column, dialect, "column"); }
    result[collection] = Object.freeze({ ...table, columns: Object.freeze({ ...table.columns }) });
  }
  return Object.freeze(result);
}

function parameter(name: string, value: unknown): SqlParameter {
  if (value === null) return { name, value: { isNull: true } };
  if (typeof value === "string") return { name, value: { stringValue: value } };
  if (typeof value === "boolean") return { name, value: { booleanValue: value } };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new UnsupportedError("RDS Data API mapped numbers must be finite");
    if (Number.isInteger(value)) { if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new UnsupportedError("RDS Data API integral values must be safe integers"); return { name, value: { longValue: value } }; }
    return { name, value: { doubleValue: value } };
  }
  throw new UnsupportedError("RDS Data API mapped values must be scalar");
}

function resultValue(value: Field | undefined): Scalar {
  if (!isObject(value)) throw new RdsDataError("RDS Data API returned an invalid field union");
  const names = ["stringValue", "longValue", "doubleValue", "booleanValue", "isNull", "blobValue", "arrayValue"].filter((name) => value[name] !== undefined);
  if (names.length !== 1) throw new RdsDataError("RDS Data API returned an invalid field union");
  switch (names[0]) {
    case "stringValue": if (typeof value.stringValue === "string") return value.stringValue; break;
    case "longValue": if (typeof value.longValue === "number" && Number.isSafeInteger(value.longValue) && !Object.is(value.longValue, -0)) return value.longValue; break;
    case "doubleValue": if (typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)) return value.doubleValue; break;
    case "booleanValue": if (typeof value.booleanValue === "boolean") return value.booleanValue; break;
    case "isNull": if (value.isNull === true) return null; break;
    case "blobValue": case "arrayValue": throw new UnsupportedError(`RDS Data API ${names[0]} result fields`);
    default: break;
  }
  throw new RdsDataError("RDS Data API returned an invalid field union variant");
}

/** DALgo adapter for Aurora's HTTPS RDS Data API. */
export class RdsDataDatabase implements Database {
  readonly #options: RdsDataDatabaseOptions;
  readonly #tables: Readonly<Record<string, RdsDataTable>>;
  readonly #maxRows: number;
  readonly #maxGetManyKeys: number;
  readonly #timeoutMs: number;

  public constructor(options: RdsDataDatabaseOptions) {
    if (isBrowser && options.allowBrowser !== true) throw new UnsupportedError("RDS Data API browser use; do not expose a database secret or broad AWS credentials");
    if (typeof options.resourceArn !== "string" || options.resourceArn.length === 0) throw new TypeError("resourceArn is required");
    if (typeof options.secretArn !== "string" || options.secretArn.length === 0) throw new TypeError("secretArn is required");
    if (options.database !== undefined && (typeof options.database !== "string" || options.database.length === 0)) throw new TypeError("database must be a non-empty string when supplied");
    if (options.dialect !== "postgresql" && options.dialect !== "mysql") throw new TypeError("dialect must be postgresql or mysql");
    this.#options = options; this.#tables = frozenTables(options.tables, options.dialect);
    this.#maxRows = positive(options.maxRows, 1000, "maxRows"); this.#maxGetManyKeys = positive(options.maxGetManyKeys, 100, "maxGetManyKeys"); this.#timeoutMs = positive(options.timeoutMs, 30_000, "timeoutMs");
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const table = this.#tableForKey(key); this.#key(key.id, table);
    const query = compileRdsQuery(table, this.#options.dialect, { source: { kind: "collection", name: key.collection }, filters: [{ field: "__name__", operator: "==", value: key.id }], orders: [] }, 2, undefined);
    const rows = await this.#select(query.sql, query.parameters, table);
    if (rows.length === 0) return { key, exists: false };
    if (rows.length !== 1 || rows[0]?.__dalgo_key !== key.id) throw new RdsDataError("RDS Data API point read did not return exactly the requested key");
    return this.#snapshot(key, rows[0] ?? {}, codec);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#maxGetManyKeys) throw new UnsupportedError(`RDS Data API getMany exceeded maxGetManyKeys (${String(this.#maxGetManyKeys)})`);
    return Promise.all(keys.map((key) => this.get(key, codec)));
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    const table = this.#tableForCollection(query.source.name); const requested = query.limit;
    if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) throw new TypeError("query limit must be a positive safe integer");
    if (requested !== undefined && requested > this.#maxRows) throw new UnsupportedError(`RDS Data API query limit exceeded maxRows (${String(this.#maxRows)})`);
    const limit = requested ?? this.#maxRows + 1; const compiled = compileRdsQuery(table, this.#options.dialect, query, limit, query.offset);
    const rows = await this.#select(compiled.sql, compiled.parameters, table);
    if (requested === undefined && rows.length > this.#maxRows) throw new UnsupportedError(`RDS Data API query exceeded maxRows (${String(this.#maxRows)})`);
    return { records: rows.map((row) => { const id = row.__dalgo_key; this.#key(id, table); return this.#snapshot(new Key(query.source.name, id), row, query.source.codec) as ExistingRecord<T>; }) };
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const table = this.#writable(key); const dataValues = this.#full(data, codec, table); const fields = Object.keys(table.columns);
    const columns = [table.keyColumn, ...fields.map((field) => table.columns[field] ?? "")]; const params = [{ name: "key", value: key.id }, ...fields.map((field) => ({ name: `v${field}`, value: dataValues[field] }))];
    const sql = `INSERT INTO ${quoteTable(table, this.#options.dialect)} (${columns.map((column) => quoteIdentifier(column, this.#options.dialect, "column")).join(", ")}) VALUES (${params.map((item) => `:${item.name}`).join(", ")})`;
    try { this.#assertOne(await this.#mutate(sql, params)); } catch (error) { if (error instanceof RdsDataError) throw error; throw new AlreadyExistsError(key); }
  }

  /** Provider-neutral SQL has no atomic MySQL/PostgreSQL upsert spelling; set is intentionally unsupported. */
  public set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> { void [key, data, codec]; return Promise.reject(new UnsupportedError("RDS Data API set requires dialect-specific upsert semantics")); }

  public async update(key: Key, data: UpdateData): Promise<void> {
    const table = this.#writable(key); const values = this.#partial(data, table); const fields = Object.keys(values); if (fields.length === 0) return;
    const sql = `UPDATE ${quoteTable(table, this.#options.dialect)} SET ${fields.map((field) => `${quoteIdentifier(table.columns[field] ?? "", this.#options.dialect, "column")} = :v${field}`).join(", ")} WHERE ${quoteIdentifier(table.keyColumn, this.#options.dialect, "keyColumn")} = :key`;
    this.#assertAtMostOne(await this.#mutate(sql, [...fields.map((field) => ({ name: `v${field}`, value: values[field] })), { name: "key", value: key.id }]));
  }

  public async delete(key: Key): Promise<void> { const table = this.#writable(key); this.#assertAtMostOne(await this.#mutate(`DELETE FROM ${quoteTable(table, this.#options.dialect)} WHERE ${quoteIdentifier(table.keyColumn, this.#options.dialect, "keyColumn")} = :key`, [{ name: "key", value: key.id }])); }
  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> { void callback; return Promise.reject(new UnsupportedError("RDS Data API callback transactions are not implemented")); }

  async #select(sql: string, params: readonly RdsParameter[], table: RdsDataTable): Promise<readonly Record<string, Scalar>[]> {
    const output = await this.#execute(sql, params, true); const metadata = output.columnMetadata;
    const names = ["__dalgo_key", ...Object.keys(table.columns)];
    if (!Array.isArray(metadata) || metadata.length !== names.length || metadata.some((column, index) => !isObject(column) || column.name !== names[index])) throw new RdsDataError("RDS Data API result metadata did not match configured projection");
    if (!Array.isArray(output.records)) throw new RdsDataError("RDS Data API query omitted records");
    if (output.records.length > this.#maxRows + 1) throw new UnsupportedError("RDS Data API result exceeded configured bound");
    return output.records.map((row) => { if (!Array.isArray(row) || row.length !== names.length) throw new RdsDataError("RDS Data API result row did not match configured projection"); return Object.fromEntries(names.map((name, index) => [name, resultValue(row[index])])) as Record<string, Scalar>; });
  }
  async #mutate(sql: string, params: readonly RdsParameter[]): Promise<number> {
    const output = await this.#execute(sql, params, false); const count = output.numberOfRecordsUpdated;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new RdsDataError("RDS Data API mutation omitted a valid affected-row count"); return count;
  }
  async #execute(sql: string, params: readonly RdsParameter[], includeMetadata: boolean): Promise<ExecuteStatementCommandOutput> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const input = { resourceArn: this.#options.resourceArn, secretArn: this.#options.secretArn, ...(this.#options.database === undefined ? {} : { database: this.#options.database }), sql, includeResultMetadata: includeMetadata, parameters: params.map((item) => parameter(item.name, item.value)) };
      const result = await new Promise<ExecuteStatementCommandOutput>((resolve, reject) => {
        const onAbort = (): void => reject(new RdsDataError("RDS Data API operation exceeded timeout")); controller.signal.addEventListener("abort", onAbort, { once: true });
        void Promise.resolve().then(() => this.#options.client.send(new ExecuteStatementCommand(input), { abortSignal: controller.signal })).then((value) => { controller.signal.removeEventListener("abort", onAbort); resolve(value); }, () => { controller.signal.removeEventListener("abort", onAbort); reject(new RdsDataError("RDS Data API request failed")); });
      });
      if (!isObject(result)) throw new RdsDataError("RDS Data API returned an invalid response"); return result;
    } finally { clearTimeout(timer); }
  }
  #tableForKey(key: Key): RdsDataTable { if (key.parent !== undefined) throw new UnsupportedError("RDS Data API nested keys"); return this.#tableForCollection(key.collection); }
  #tableForCollection(collection: string): RdsDataTable { const table = this.#tables[collection]; if (table === undefined) throw new UnsupportedError(`RDS Data API collection has no table mapping: ${collection}`); return table; }
  #writable(key: Key): RdsDataTable { const table = this.#tableForKey(key); this.#key(key.id, table); if (table.uniqueKey !== true) throw new UnsupportedError("RDS Data API writes require uniqueKey: true"); return table; }
  #key(value: unknown, table: RdsDataTable): asserts value is string | number { rdsKeyValue(value, table); }
  #snapshot<T>(key: Key, row: Record<string, Scalar>, codec?: Codec<T>): RecordSnapshot<T> { const data = { ...row }; delete data.__dalgo_key; return { key, exists: true, data: codecOr(codec).decode(data) }; }
  #full<T>(data: T, codec: Codec<T> | undefined, table: RdsDataTable): Record<string, Scalar> { const encoded = codecOr(codec).encode(data); const fields = Object.keys(table.columns); if (!isObject(encoded) || Object.keys(encoded).length !== fields.length || fields.some((field) => !Object.hasOwn(encoded, field))) throw new UnsupportedError("RDS Data API insert data must exactly match the declared projection"); return this.#partial(encoded, table); }
  #partial(data: unknown, table: RdsDataTable): Record<string, Scalar> { if (!isObject(data)) throw new UnsupportedError("RDS Data API update data must be a top-level object"); const result: Record<string, Scalar> = {}; for (const [field, value] of Object.entries(data)) { if (table.columns[field] === undefined) throw new UnsupportedError(`RDS Data API field is not declared in table mapping: ${field}`); result[field] = rdsScalar(value) as Scalar; } return result; }
  #assertOne(count: number): void { if (count !== 1) throw new RdsDataError("RDS Data API insert did not affect exactly one record"); }
  #assertAtMostOne(count: number): void { if (count > 1) throw new RdsDataError("RDS Data API key mutation affected multiple records"); }
}
