import {
  AlreadyExistsError,
  DOCUMENT_ID,
  Key,
  NotFoundError,
  UnsupportedError,
  identityCodec,
  type Codec,
  type Database,
  type ExistingRecord,
  type QueryPage,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
} from "@dal-go/dalgo";
import type { SpannerColumn, SpannerDatabaseOptions, SpannerTable } from "./types.js";

const API = "https://spanner.googleapis.com/v1";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_ROWS = 100;
const DEFAULT_RESPONSE_BYTES = 1_048_576;

interface Field { readonly name?: unknown; readonly type?: { readonly code?: unknown }; }

export class SpannerHttpError extends Error {
  public readonly status: number;
  public constructor(status: number) { super(`Cloud Spanner request failed with HTTP ${String(status)}`); this.name = "SpannerHttpError"; this.status = status; }
}
/** Deliberately redacts token-provider, transport, and response-body failures. */
export class SpannerRequestError extends Error { public constructor() { super("Cloud Spanner request could not be completed"); this.name = "SpannerRequestError"; } }

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`malformed Cloud Spanner ${label}`);
  return value as Record<string, unknown>;
}
function positive(value: number | undefined, fallback: number, label: string, max: number): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < 1 || actual > max) throw new TypeError(`${label} must be a safe integer from 1 to ${String(max)}`);
  return actual;
}
function identifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) throw new TypeError(`${label} must be a simple SQL identifier`);
  return value;
}
function quoted(value: string, label: string): string { return `\`${identifier(value, label)}\``; }
function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }
function noParent(key: Key): void { if (key.parent !== undefined) throw new UnsupportedError("Cloud Spanner nested collection keys"); }
function scalar(value: unknown, column: SpannerColumn): unknown {
  if (value === undefined) throw new TypeError("Cloud Spanner values cannot be undefined");
  if (value === null) return null;
  switch (column.type) {
    case "BOOL": if (typeof value !== "boolean") throw new TypeError("BOOL requires a boolean"); return value;
    case "INT64": if (typeof value === "string" && /^-?(?:0|[1-9]\d*)$/u.test(value)) return value; if (typeof value === "number" && Number.isSafeInteger(value)) return String(value); throw new TypeError("INT64 requires a decimal string or safe integer");
    case "FLOAT64": if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("FLOAT64 requires a finite number"); return value;
    case "JSON": return typeof value === "string" ? value : JSON.stringify(value);
    default: if (typeof value !== "string") throw new TypeError(`${column.type} requires a string`); return value;
  }
}
function parameter(name: string, value: unknown, column: SpannerColumn): Record<string, unknown> { return { [name]: scalar(value, column) }; }
function paramType(name: string, column: SpannerColumn): Record<string, unknown> { return { [name]: { code: column.type } }; }
function writeData<T>(data: T, codec: Codec<T>): Record<string, unknown> {
  const encoded = codec.encode(data);
  return object(encoded, "record data");
}

export class SpannerDatabase implements Database {
  readonly #database: string;
  readonly #tables: Readonly<Record<string, SpannerTable>>;
  readonly #accessToken: NonNullable<SpannerDatabaseOptions["accessToken"]>;
  readonly #fetch: NonNullable<SpannerDatabaseOptions["fetch"]>;
  readonly #timeout: number;
  readonly #maxRows: number;
  readonly #maxResponseBytes: number;

  public constructor(options: SpannerDatabaseOptions) {
    identifier(options.projectId, "projectId"); identifier(options.instanceId, "instanceId"); identifier(options.databaseId, "databaseId");
    if (typeof options.accessToken !== "function") throw new TypeError("accessToken must be a function");
    const tables: Record<string, SpannerTable> = {};
    for (const [collection, table] of Object.entries(options.tables)) {
      identifier(collection, "collection"); identifier(table.table, "table"); identifier(table.keyColumn.column, "key column");
      const names = new Set<string>([table.keyColumn.column]);
      for (const [field, column] of Object.entries(table.columns)) { identifier(field, "mapped field"); identifier(column.column, "mapped column"); if (names.has(column.column)) throw new TypeError(`duplicate mapped column: ${column.column}`); names.add(column.column); }
      tables[collection] = Object.freeze({ table: table.table, keyColumn: Object.freeze({ ...table.keyColumn }), columns: Object.freeze(Object.fromEntries(Object.entries(table.columns).map(([field, column]) => [field, Object.freeze({ ...column })]))) });
    }
    this.#database = `projects/${options.projectId}/instances/${options.instanceId}/databases/${options.databaseId}`;
    this.#tables = Object.freeze(tables); this.#accessToken = options.accessToken; this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = positive(options.timeoutMs, DEFAULT_TIMEOUT, "timeoutMs", 120_000); this.#maxRows = positive(options.maxRows, DEFAULT_ROWS, "maxRows", 1_000); this.#maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_RESPONSE_BYTES, "maxResponseBytes", 16_777_216);
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const table = this.table(key); const row = await this.select(table, `WHERE ${quoted(table.keyColumn.column, "key column")} = @key LIMIT 2`, parameter("key", key.id, table.keyColumn), paramType("key", table.keyColumn));
    if (row.length === 0) return { key, exists: false }; if (row.length !== 1) throw new UnsupportedError("Cloud Spanner key mapping returned more than one row");
    return this.snapshot(key, row[0] as Record<string, unknown>, codec);
  }
  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length === 0) return []; if (keys.length > this.#maxRows) throw new UnsupportedError("Cloud Spanner getMany exceeds maxRows");
    const first = keys[0]; if (first === undefined) return []; const table = this.table(first); for (const key of keys) if (this.table(key) !== table) throw new UnsupportedError("Cloud Spanner getMany across mappings");
    // Point reads preserve DALgo order and avoid a composite-key/array parameter approximation.
    return Promise.all(keys.map((key) => this.get(key, codec)));
  }
  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("Cloud Spanner collection-group or nested queries");
    if ((query.offset ?? 0) !== 0 || query.startAt !== undefined || query.startAfter !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("Cloud Spanner DALgo cursors and offsets");
    const table = this.tableForCollection(query.source.name); const requested = query.limit ?? this.#maxRows; if (!Number.isSafeInteger(requested) || requested < 1 || requested > this.#maxRows) throw new UnsupportedError("Cloud Spanner query limit exceeds maxRows");
    const clauses: string[] = []; const params: Record<string, unknown> = {}; const types: Record<string, unknown> = {};
    for (const [index, filter] of query.filters.entries()) {
      const field = filter.field === DOCUMENT_ID ? table.keyColumn : table.columns[String(filter.field)]; if (field === undefined) throw new UnsupportedError(`Cloud Spanner unmapped field: ${String(filter.field)}`);
      const name = `p${String(index)}`; const col = quoted(field.column, "query column");
      if (filter.value === null) { if (filter.operator === "==") clauses.push(`${col} IS NULL`); else if (filter.operator === "!=") clauses.push(`${col} IS NOT NULL`); else throw new UnsupportedError("Cloud Spanner null range filters"); continue; }
      const operator = ({ "==": "=", "!=": "!=", "<": "<", "<=": "<=", ">": ">", ">=": ">=" } as const)[filter.operator as "=="];
      if (operator === undefined) throw new UnsupportedError(`Cloud Spanner ${String(filter.operator)} filters`);
      Object.assign(params, parameter(name, filter.value, field)); Object.assign(types, paramType(name, field)); clauses.push(`${col} ${operator} @${name}`);
    }
    const orders = query.orders.map((order) => { const col = order.field === DOCUMENT_ID ? table.keyColumn : table.columns[String(order.field)]; if (col === undefined) throw new UnsupportedError(`Cloud Spanner unmapped order field: ${String(order.field)}`); if (order.direction !== "asc" && order.direction !== "desc") throw new TypeError("invalid Cloud Spanner order direction"); return `${quoted(col.column, "order column")} ${order.direction.toUpperCase()}`; });
    const rows = await this.select(table, `${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`} ${orders.length === 0 ? "" : `ORDER BY ${orders.join(", ")}`} LIMIT ${String(requested)}`, params, types);
    return { records: rows.map((row) => { const value = row.__dalgo_key; if (typeof value !== "string" && typeof value !== "number") throw new TypeError("Cloud Spanner key must be string or number"); return this.snapshot(new Key(query.source.name, String(value)), row, query.source.codec) as ExistingRecord<T>; }) };
  }
  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> { try { await this.mutate("insert", key, writeData(data, codecOrIdentity(codec)), true); } catch (error) { if (error instanceof SpannerHttpError && error.status === 409) throw new AlreadyExistsError(key, { cause: error }); throw error; } }
  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> { await this.mutate("replace", key, writeData(data, codecOrIdentity(codec)), true); }
  public async update(key: Key, data: Readonly<Record<string, unknown>>): Promise<void> { if (Object.keys(data).length === 0) return; try { await this.mutate("update", key, data, false); } catch (error) { if (error instanceof SpannerHttpError && error.status === 404) throw new NotFoundError(key, { cause: error }); throw error; } }
  public async delete(key: Key): Promise<void> { const table = this.table(key); await this.withSession(async (session, deadline) => { await this.request("POST", `${session}:commit`, { singleUseTransaction: { readWrite: {} }, mutations: [{ delete: { table: table.table, keySet: { keys: [[scalar(key.id, table.keyColumn)]] } } }] }, deadline); }); }
  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> { if (typeof callback !== "function") return Promise.reject(new TypeError("transaction callback is required")); return Promise.reject(new UnsupportedError("Cloud Spanner callback transactions; use the official client for retries")); }

  private table(key: Key): SpannerTable { noParent(key); return this.tableForCollection(key.collection); }
  private tableForCollection(collection: string): SpannerTable { const table = this.#tables[collection]; if (table === undefined) throw new UnsupportedError(`Cloud Spanner collection has no table mapping: ${collection}`); return table; }
  private async select(table: SpannerTable, suffix: string, params: Record<string, unknown>, types: Record<string, unknown>): Promise<readonly Record<string, unknown>[]> {
    const projection = [`${quoted(table.keyColumn.column, "key column")} AS __dalgo_key`, ...Object.entries(table.columns).map(([field, col]) => `${quoted(col.column, "mapped column")} AS ${quoted(field, "mapped field")}`)];
    return this.withSession(async (session, deadline) => this.rows(await this.request("POST", `${session}:executeSql`, { sql: `SELECT ${projection.join(", ")} FROM ${quoted(table.table, "table")} ${suffix}`.trim(), params, paramTypes: types }, deadline), table));
  }
  private snapshot<T>(key: Key, row: Record<string, unknown>, codec?: Codec<T>): RecordSnapshot<T> { const data = { ...row }; delete data.__dalgo_key; return { key, exists: true, data: codecOrIdentity(codec).decode(data) }; }
  private async mutate(operation: "insert" | "replace" | "update", key: Key, raw: Readonly<Record<string, unknown>>, requireComplete: boolean): Promise<void> {
    const table = this.table(key); const fields = Object.keys(raw); if (fields.some((field) => field === "__dalgo_key" || table.columns[field] === undefined)) throw new UnsupportedError("Cloud Spanner unmapped write field");
    if (requireComplete && fields.length !== Object.keys(table.columns).length) throw new UnsupportedError("Cloud Spanner insert/set requires every mapped data field");
    const columns = [table.keyColumn.column, ...fields.map((field) => (table.columns[field] as SpannerColumn).column)]; const values = [scalar(key.id, table.keyColumn), ...fields.map((field) => scalar(raw[field], table.columns[field] as SpannerColumn))];
    await this.withSession(async (session, deadline) => { await this.request("POST", `${session}:commit`, { singleUseTransaction: { readWrite: {} }, mutations: [{ [operation]: { table: table.table, columns, values: [values] } }] }, deadline); });
  }
  private rows(value: unknown, table: SpannerTable): readonly Record<string, unknown>[] {
    const result = object(value, "result"); const metadata = object(result.metadata, "result metadata"); const rowType = object(metadata.rowType, "result row type"); if (!Array.isArray(rowType.fields) || !Array.isArray(result.rows)) throw new TypeError("malformed Cloud Spanner result rows");
    const expected = ["__dalgo_key", ...Object.keys(table.columns)]; if (rowType.fields.length !== expected.length) throw new TypeError("malformed Cloud Spanner result projection");
    for (const [index, expectedName] of expected.entries()) { const field = rowType.fields[index]; if (typeof field !== "object" || field === null || (field as Field).name !== expectedName) throw new TypeError("malformed Cloud Spanner result projection"); }
    return result.rows.map((row, rowIndex) => { if (!Array.isArray(row) || row.length !== expected.length) throw new TypeError(`malformed Cloud Spanner row ${String(rowIndex)}`); return Object.fromEntries(expected.map((name, index) => [name, row[index]])); });
  }
  private async withSession<T>(callback: (session: string, deadline: number) => Promise<T>): Promise<T> {
    const deadline = Date.now() + this.#timeout; const created = object(await this.request("POST", `${this.#database}/sessions`, {}, deadline), "session"); if (typeof created.name !== "string" || !created.name.startsWith(`${this.#database}/sessions/`)) throw new TypeError("malformed Cloud Spanner session name");
    try { return await callback(created.name, deadline); } finally { void this.request("DELETE", created.name, undefined, deadline).catch(() => undefined); }
  }
  private async request(method: "POST" | "DELETE", resource: string, body: unknown, deadline: number): Promise<unknown> {
    const token = await this.deadline(Promise.resolve().then(this.#accessToken), deadline); if (typeof token !== "string" || token.trim() === "") throw new TypeError("accessToken must return a non-empty token");
    const controller = new AbortController(); const left = deadline - Date.now(); if (left <= 0) throw new SpannerRequestError(); const timer = setTimeout(() => controller.abort(), left);
    try { let response: Response; try { response = await this.deadline(Promise.resolve().then(() => this.#fetch(`${API}/${resource}`, { method, redirect: "error", signal: controller.signal, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })), deadline); } catch { throw new SpannerRequestError(); }
      const length = response.headers.get("content-length"); if (length !== null && (!/^\d+$/u.test(length) || Number(length) > this.#maxResponseBytes)) throw new SpannerRequestError(); let text: string; try { text = await this.deadline(response.text(), deadline); } catch { throw new SpannerRequestError(); } if (text.length > this.#maxResponseBytes) throw new SpannerRequestError(); if (!response.ok) throw new SpannerHttpError(response.status); if (text === "") return {}; try { return JSON.parse(text) as unknown; } catch { throw new TypeError("Cloud Spanner response was not JSON"); }
    } finally { clearTimeout(timer); }
  }
  private async deadline<T>(promise: Promise<T>, deadline: number): Promise<T> { const remaining = deadline - Date.now(); if (remaining <= 0) throw new SpannerRequestError(); return new Promise<T>((resolve, reject) => { const timer = setTimeout(() => reject(new SpannerRequestError()), remaining); void promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); reject(new SpannerRequestError()); }); }); }
}
