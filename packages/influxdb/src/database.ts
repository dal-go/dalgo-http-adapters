import {
  Key,
  UnsupportedError,
  identityCodec,
  type Codec,
  type Database,
  type ExistingRecord,
  type QueryPage,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
} from "@dal-go/dalgo";
import { compileInfluxDB3Query, validateIdentifier } from "./sql.js";
import type { InfluxDB3Column, InfluxDB3DatabaseOptions, InfluxDB3Table } from "./types.js";

type Scalar = boolean | number | string | null;

interface InfluxSeries { readonly columns?: readonly unknown[]; readonly values?: readonly unknown[]; }
interface InfluxResult { readonly series?: readonly unknown[]; }
interface InfluxResponse { readonly results?: readonly unknown[]; }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return result;
}

function identityOr<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }

function validBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("serverUrl must be an absolute URL"); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new TypeError("serverUrl must use HTTPS except for loopback HTTP");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.pathname !== "" && url.pathname !== "/")) {
    throw new TypeError("serverUrl must be an origin without credentials, path, query, or fragment");
  }
  return url;
}

function freezeColumn(column: InfluxDB3Column): InfluxDB3Column {
  validateIdentifier(column.column, "mapped column");
  return Object.freeze({ column: column.column, ...(column.nullable === undefined ? {} : { nullable: column.nullable }) });
}

function freezeTables(tables: Readonly<Record<string, InfluxDB3Table>>): Readonly<Record<string, InfluxDB3Table>> {
  const result: Record<string, InfluxDB3Table> = {};
  for (const [collection, table] of Object.entries(tables)) {
    validateIdentifier(collection, "collection name");
    validateIdentifier(table.table, "table");
    const names = new Set<string>();
    const keyColumn = freezeColumn(table.keyColumn);
    names.add(keyColumn.column);
    const columns: Record<string, InfluxDB3Column> = {};
    for (const [field, column] of Object.entries(table.columns)) {
      if (field === "__dalgo_key") throw new TypeError("__dalgo_key is reserved by the InfluxDB 3 adapter");
      validateIdentifier(field, "mapped field");
      const copied = freezeColumn(column);
      if (names.has(copied.column)) throw new TypeError(`duplicate InfluxDB 3 mapped column: ${copied.column}`);
      names.add(copied.column);
      columns[field] = copied;
    }
    result[collection] = Object.freeze({ table: table.table, keyColumn, columns: Object.freeze(columns) });
  }
  return Object.freeze(result);
}

function responseRows(value: unknown, table: InfluxDB3Table): readonly Record<string, Scalar>[] {
  if (Array.isArray(value)) return objectRows(value, table);
  const results = isObject(value) ? (value as InfluxResponse).results : undefined;
  if (!Array.isArray(results) || results.length !== 1) {
    throw new TypeError("malformed InfluxDB 3 SQL response");
  }
  const result = results[0];
  if (!isObject(result)) throw new TypeError("malformed InfluxDB 3 SQL result");
  const series = (result as InfluxResult).series;
  if (series === undefined) return [];
  if (!Array.isArray(series) || series.length !== 1 || !isObject(series[0])) throw new TypeError("malformed InfluxDB 3 SQL series");
  const selected = series[0] as InfluxSeries;
  const expected = ["__dalgo_key", ...Object.keys(table.columns)];
  if (!Array.isArray(selected.columns) || selected.columns.length !== expected.length || selected.columns.some((name, index) => name !== expected[index])) {
    throw new TypeError("malformed InfluxDB 3 SQL projection");
  }
    if (selected.values === undefined) return [];
  if (!Array.isArray(selected.values)) throw new TypeError("malformed InfluxDB 3 SQL values");
  return selected.values.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== expected.length) throw new TypeError(`malformed InfluxDB 3 SQL row ${String(rowIndex)}`);
    const output: Record<string, Scalar> = {};
    for (let index = 0; index < expected.length; index += 1) {
      const name = expected[index]; const cell = row[index];
      if (name === undefined || (cell !== null && typeof cell !== "boolean" && typeof cell !== "number" && typeof cell !== "string")) throw new TypeError("InfluxDB 3 SQL returned a non-scalar mapped value");
      output[name] = cell;
    }
    if (typeof output.__dalgo_key !== "string") throw new TypeError("InfluxDB 3 key column must return a string");
    return output;
  });
}

/** Current v3 JSON output is a top-level array of objects; reject unprojected server columns. */
function objectRows(rows: readonly unknown[], table: InfluxDB3Table): readonly Record<string, Scalar>[] {
  const expected = ["__dalgo_key", ...Object.keys(table.columns)];
  return rows.map((row, rowIndex) => {
    if (!isObject(row)) throw new TypeError(`malformed InfluxDB 3 SQL row ${String(rowIndex)}`);
    const names = Object.keys(row);
    if (names.length !== expected.length || expected.some((name) => !Object.hasOwn(row, name))) throw new TypeError("malformed InfluxDB 3 SQL projection");
    const output: Record<string, Scalar> = {};
    for (const name of expected) {
      const cell = row[name];
      if (cell !== null && typeof cell !== "boolean" && typeof cell !== "number" && typeof cell !== "string") throw new TypeError("InfluxDB 3 SQL returned a non-scalar mapped value");
      output[name] = cell;
    }
    if (typeof output.__dalgo_key !== "string") throw new TypeError("InfluxDB 3 key column must return a string");
    return output;
  });
}

export class InfluxDB3HttpError extends Error {
  public readonly status: number;
  public constructor(status: number) { super(`InfluxDB 3 request failed with HTTP ${String(status)}`); this.name = "InfluxDB3HttpError"; this.status = status; }
}

/** DALgo adapter for the InfluxDB 3 `/api/v3/query_sql` JSON HTTP API. */
export class InfluxDB3Database implements Database {
  readonly #database: string;
  readonly #origin: string;
  readonly #tables: Readonly<Record<string, InfluxDB3Table>>;
  readonly #accessToken: InfluxDB3DatabaseOptions["accessToken"];
  readonly #maxRows: number;
  readonly #maxResponseBytes: number;
  readonly #maxWriteBytes: number;
  readonly #timeoutMs: number;
  readonly #fetch: NonNullable<InfluxDB3DatabaseOptions["fetch"]>;

  public constructor(options: InfluxDB3DatabaseOptions) {
    validateIdentifier(options.database, "database");
    if (typeof options.accessToken !== "function") throw new TypeError("accessToken must be a function returning a bearer token");
    const url = validBaseUrl(options.serverUrl);
    this.#database = options.database;
    this.#origin = url.origin;
    this.#tables = freezeTables(options.tables);
    this.#accessToken = options.accessToken;
    this.#maxRows = positive(options.maxRows, 1000, "maxRows");
    this.#maxResponseBytes = positive(options.maxResponseBytes, 1024 * 1024, "maxResponseBytes");
    this.#maxWriteBytes = positive(options.maxWriteBytes, 1024 * 1024, "maxWriteBytes");
    this.#timeoutMs = positive(options.timeoutMs, 30_000, "timeoutMs");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    this.assertStringKey(key);
    const table = this.tableFor(key);
    const compiled = compileInfluxDB3Query(table, { source: { kind: "collection", name: key.collection }, filters: [{ field: "__name__", operator: "==", value: key.id }], orders: [] }, 2);
    const rows = await this.select(compiled.sql, compiled.params, table);
    if (rows.length === 0) return { key, exists: false };
    if (rows.length !== 1 || rows[0]?.__dalgo_key !== key.id) throw new UnsupportedError("InfluxDB 3 key mapping returned more than one record");
    return this.snapshot(key, rows[0] ?? {}, codec);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length === 0) return [];
    if (keys.length > this.#maxRows) throw new UnsupportedError(`InfluxDB 3 getMany above configured maxRows (${String(this.#maxRows)})`);
    const first = keys[0]; if (first === undefined) throw new Error("InfluxDB 3 lost first key");
    for (const key of keys) this.assertStringKey(key);
    const table = this.tableFor(first);
    if (keys.some((key) => this.tableFor(key) !== table)) throw new UnsupportedError("InfluxDB 3 getMany across table mappings");
    const records = await Promise.all(keys.map((key) => this.get(key, codec)));
    return records;
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    const table = this.tableForCollection(query.source.name);
    if (query.offset !== undefined) throw new UnsupportedError("InfluxDB 3 query offsets");
    const requested = query.limit ?? this.#maxRows;
    if (!Number.isSafeInteger(requested) || requested < 1) throw new TypeError("InfluxDB 3 query limit must be positive");
    if (requested > this.#maxRows) throw new UnsupportedError(`InfluxDB 3 query above configured maxRows (${String(this.#maxRows)})`);
    const compiled = compileInfluxDB3Query(table, query, requested + 1);
    const rows = await this.select(compiled.sql, compiled.params, table);
    const hasMore = rows.length > requested;
    const pageRows = hasMore ? rows.slice(0, requested) : rows;
    const records = pageRows.map((row) => {
      if (typeof row.__dalgo_key !== "string") throw new TypeError("InfluxDB 3 key column must return a string");
      const key = new Key(query.source.name, row.__dalgo_key);
      return this.snapshot(key, row, query.source.codec) as ExistingRecord<T>;
    });
    const last = pageRows.at(-1);
    const nextCursor = hasMore && last !== undefined
      ? { values: compiled.cursorColumns.map((column) => last[column.column === table.keyColumn.column ? "__dalgo_key" : this.fieldForColumn(table, column.column)]) }
      : undefined;
    return nextCursor === undefined ? { records } : { records, nextCursor };
  }

  /** Appends complete InfluxDB line-protocol points through native v3 `write_lp`; it is not DALgo record CRUD. */
  public async appendLineProtocol(lines: readonly string[], precision: "auto" | "second" | "millisecond" | "microsecond" | "nanosecond" = "auto"): Promise<void> {
    if (!Array.isArray(lines) || lines.length === 0) throw new TypeError("appendLineProtocol requires at least one line");
    if (lines.some((line) => typeof line !== "string" || line.length === 0 || line.includes("\n") || line.includes("\r"))) throw new TypeError("each line-protocol point must be one non-empty line without CR or LF");
    const body = lines.join("\n");
    if (new TextEncoder().encode(body).byteLength > this.#maxWriteBytes) throw new UnsupportedError(`InfluxDB 3 line-protocol request exceeds maxWriteBytes (${String(this.#maxWriteBytes)})`);
    const url = new URL("/api/v3/write_lp", this.#origin);
    url.searchParams.set("db", this.#database); url.searchParams.set("precision", precision);
    await this.request(url, { method: "POST", headers: { "content-type": "text/plain; charset=utf-8" }, body }, false);
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> { void key; void data; void codec; throw new UnsupportedError("InfluxDB 3 point insert semantics; use appendLineProtocol"); }
  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> { void key; void data; void codec; throw new UnsupportedError("InfluxDB 3 point replacement semantics; use appendLineProtocol"); }
  public async update(key: Key, data: UpdateData): Promise<void> { void key; void data; throw new UnsupportedError("InfluxDB 3 point update semantics"); }
  public async delete(key: Key): Promise<void> { void key; throw new UnsupportedError("InfluxDB 3 point delete semantics"); }
  public async runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> { void callback; throw new UnsupportedError("InfluxDB 3 callback transactions"); }

  private tableFor(key: Key): InfluxDB3Table {
    if (key.parent !== undefined) throw new UnsupportedError("InfluxDB 3 nested collection keys");
    return this.tableForCollection(key.collection);
  }

  private assertStringKey(key: Key): asserts key is Key<string> {
    if (typeof key.id !== "string") throw new UnsupportedError("InfluxDB 3 DALgo keys must be strings");
  }

  private tableForCollection(collection: string): InfluxDB3Table {
    const table = this.#tables[collection];
    if (table === undefined) throw new UnsupportedError(`InfluxDB 3 collection is not mapped: ${collection}`);
    return table;
  }

  private fieldForColumn(table: InfluxDB3Table, column: string): string {
    for (const [field, mapped] of Object.entries(table.columns)) if (mapped.column === column) return field;
    throw new Error("InfluxDB 3 cursor column is not mapped");
  }

  private snapshot<T>(key: Key, row: Readonly<Record<string, Scalar>>, codec?: Codec<T>): RecordSnapshot<T> {
    const data = { ...row }; delete data.__dalgo_key;
    return { key, exists: true, data: identityOr(codec).decode(data) };
  }

  private async select(sql: string, params: Readonly<Record<string, Scalar>>, table: InfluxDB3Table): Promise<readonly Record<string, Scalar>[]> {
    const response = await this.request(new URL("/api/v3/query_sql", this.#origin), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ db: this.#database, q: sql, params, format: "json" }),
    }, true);
    return responseRows(response, table);
  }

  private async request(url: URL, init: RequestInit, parseJson: boolean): Promise<unknown> {
    const token = await this.#accessToken();
    if (typeof token !== "string" || token.trim().length === 0 || /[\r\n]/u.test(token)) throw new TypeError("accessToken must return a non-empty header-safe token");
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` }, redirect: "error", signal: abort.signal });
      if (!response.ok) throw new InfluxDB3HttpError(response.status);
      if (!parseJson) return undefined;
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > this.#maxResponseBytes)) throw new UnsupportedError("InfluxDB 3 response exceeds maxResponseBytes");
      const body = await this.readBoundedBody(response);
      try { return JSON.parse(body) as unknown; } catch { throw new TypeError("malformed InfluxDB 3 JSON response"); }
    } finally { clearTimeout(timer); }
  }

  private async readBoundedBody(response: Response): Promise<string> {
    if (response.body === null) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const bytes = next.value;
        size += bytes.byteLength;
        if (size > this.#maxResponseBytes) {
          await reader.cancel();
          throw new UnsupportedError("InfluxDB 3 response exceeds maxResponseBytes");
        }
        chunks.push(bytes);
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(result);
  }
}
