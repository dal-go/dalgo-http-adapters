import {
  AlreadyExistsError,
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
import { compileLibSQLQuery, libSQLScalar, validateIdentifier, type LibSQLScalar } from "./sql.js";
import type { LibSQLColumn, LibSQLDatabaseOptions, LibSQLTable } from "./types.js";

type HranaValue =
  | { readonly type: "null" }
  | { readonly type: "integer"; readonly value: string }
  | { readonly type: "float"; readonly value: number | null }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "blob"; readonly base64: string };

interface HranaColumn { readonly name?: unknown; }
interface HranaStatementResult { readonly cols?: unknown; readonly rows?: unknown; }
interface PipelineError { readonly code?: unknown; readonly extended_code?: unknown; }
interface PipelineResult { readonly type?: unknown; readonly response?: unknown; readonly error?: unknown; }
interface PipelineResponse { readonly baton?: unknown; readonly results?: unknown; }

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return result;
}
function identityOr<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }

function validBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("serverUrl must be an absolute URL"); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new TypeError("serverUrl must use HTTPS except for loopback HTTP");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.pathname !== "" && url.pathname !== "/")) {
    throw new TypeError("serverUrl must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

function freezeColumn(column: LibSQLColumn): LibSQLColumn {
  validateIdentifier(column.column, "mapped column");
  return Object.freeze({ column: column.column, ...(column.nullable === undefined ? {} : { nullable: column.nullable }) });
}

function freezeTables(tables: Readonly<Record<string, LibSQLTable>>): Readonly<Record<string, LibSQLTable>> {
  const result: Record<string, LibSQLTable> = {};
  for (const [collection, table] of Object.entries(tables)) {
    validateIdentifier(collection, "collection name");
    validateIdentifier(table.table, "table");
    const names = new Set<string>();
    const keyColumn = freezeColumn(table.keyColumn); names.add(keyColumn.column);
    const columns: Record<string, LibSQLColumn> = {};
    for (const [field, column] of Object.entries(table.columns)) {
      if (field === "__dalgo_key") throw new TypeError("__dalgo_key is reserved by the libSQL adapter");
      validateIdentifier(field, "mapped field");
      const copied = freezeColumn(column);
      if (names.has(copied.column)) throw new TypeError(`duplicate libSQL mapped column: ${copied.column}`);
      names.add(copied.column); columns[field] = copied;
    }
    if (Object.keys(columns).length === 0) throw new TypeError("libSQL table mappings require at least one mapped data column");
    if (table.uniqueKey !== undefined && table.uniqueKey !== true && table.uniqueKey !== false) throw new TypeError("uniqueKey must be a boolean");
    result[collection] = Object.freeze({ table: table.table, ...(table.uniqueKey === undefined ? {} : { uniqueKey: table.uniqueKey }), keyColumn, columns: Object.freeze(columns) });
  }
  return Object.freeze(result);
}

function encodedValue(value: LibSQLScalar): HranaValue {
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "text", value };
  if (typeof value === "boolean") return { type: "integer", value: value ? "1" : "0" };
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) throw new UnsupportedError("libSQL integral values must be JavaScript safe integers");
    return { type: "integer", value: String(value) };
  }
  return { type: "float", value };
}

function decodedValue(value: unknown): LibSQLScalar {
  if (!isObject(value) || typeof value.type !== "string") throw new TypeError("malformed libSQL result value");
  switch (value.type) {
    case "null": return null;
    case "text": if (typeof value.value === "string") return value.value; break;
    case "integer": {
      if (typeof value.value !== "string" || !/^-?(0|[1-9][0-9]*)$/u.test(value.value)) break;
      const integer = Number(value.value);
      if (Number.isSafeInteger(integer)) return integer;
      throw new UnsupportedError("libSQL result integer is outside JavaScript safe-integer range");
    }
    case "float": if (typeof value.value === "number" && Number.isFinite(value.value)) return value.value; break;
  }
  throw new TypeError("libSQL returned an unsupported mapped value");
}

function pipelineResult(value: unknown): HranaStatementResult {
  if (!isObject(value)) throw new TypeError("malformed libSQL pipeline response");
  const response = value as PipelineResponse;
  if (response.baton !== null) throw new TypeError("malformed libSQL pipeline baton");
  const results = response.results;
  if (!Array.isArray(results) || results.length !== 2) throw new TypeError("malformed libSQL pipeline response");
  const close = results[1] as PipelineResult | undefined;
  if (!isObject(close) || close.type !== "ok" || !isObject(close.response) || close.response.type !== "close") {
    throw new TypeError("malformed libSQL close response");
  }
  const first = results[0] as PipelineResult | undefined;
  if (!isObject(first)) throw new TypeError("malformed libSQL pipeline result");
  if (first.type === "error") {
    const error = isObject(first.error) ? first.error as PipelineError : {};
    throw new LibSQLPipelineError(safeCode(error.code), safeCode(error.extended_code));
  }
  if (first.type !== "ok" || !isObject(first.response) || first.response.type !== "execute" || !isObject(first.response.result)) {
    throw new TypeError("malformed libSQL execute response");
  }
  return first.response.result as HranaStatementResult;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z0-9_]{1,64}$/u.test(value) ? value : undefined;
}

function resultRows(value: HranaStatementResult, table: LibSQLTable): readonly Record<string, LibSQLScalar>[] {
  if (!Array.isArray(value.cols) || !Array.isArray(value.rows)) throw new TypeError("malformed libSQL statement result");
  const expected = ["__dalgo_key", ...Object.keys(table.columns)];
  if (value.cols.length !== expected.length || value.cols.some((column, index) => !isObject(column) || (column as HranaColumn).name !== expected[index])) {
    throw new TypeError("malformed libSQL SQL projection");
  }
  return value.rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== expected.length) throw new TypeError(`malformed libSQL SQL row ${String(rowIndex)}`);
    const output: Record<string, LibSQLScalar> = {};
    for (let index = 0; index < expected.length; index += 1) {
      const name = expected[index]; if (name === undefined) throw new Error("libSQL projection name missing");
      output[name] = decodedValue(row[index]);
    }
    if (typeof output.__dalgo_key !== "string") throw new TypeError("libSQL key column must return a string");
    return output;
  });
}

function affectedRows(value: HranaStatementResult): number {
  const count = (value as Record<string, unknown>).affected_row_count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("malformed libSQL affected-row count");
  }
  return count;
}

function headersFrom(value: Readonly<Record<string, string>>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || typeof headerValue !== "string" || /[\r\n]/u.test(headerValue)) throw new TypeError("headers must have valid names and newline-free values");
    headers[name] = headerValue;
  }
  return headers;
}

export class LibSQLHttpError extends Error {
  public readonly status: number;
  public constructor(status: number) { super(`libSQL pipeline request failed with HTTP ${String(status)}`); this.name = "LibSQLHttpError"; this.status = status; }
}

/** A server-side statement failure with a bounded machine code but no echoed SQL, headers, or error body. */
export class LibSQLPipelineError extends Error {
  public readonly code: string | undefined;
  public readonly extendedCode: string | undefined;
  public constructor(code: string | undefined, extendedCode?: string) {
    const visibleCode = extendedCode ?? code;
    super(visibleCode === undefined ? "libSQL pipeline statement failed" : `libSQL pipeline statement failed (${visibleCode})`);
    this.name = "LibSQLPipelineError"; this.code = code; this.extendedCode = extendedCode;
  }
}

/** DALgo adapter for the provider-neutral JSON Hrana `POST /v3/pipeline` protocol. */
export class LibSQLDatabase implements Database {
  readonly #origin: string;
  readonly #tables: Readonly<Record<string, LibSQLTable>>;
  readonly #headers: LibSQLDatabaseOptions["headers"];
  readonly #maxRows: number;
  readonly #maxResponseBytes: number;
  readonly #timeoutMs: number;
  readonly #fetch: NonNullable<LibSQLDatabaseOptions["fetch"]>;

  public constructor(options: LibSQLDatabaseOptions) {
    this.#origin = validBaseUrl(options.serverUrl);
    this.#tables = freezeTables(options.tables);
    if (options.headers !== undefined && typeof options.headers !== "function") throw new TypeError("headers must be a function returning request headers");
    this.#headers = options.headers;
    this.#maxRows = positive(options.maxRows, 1000, "maxRows");
    this.#maxResponseBytes = positive(options.maxResponseBytes, 1024 * 1024, "maxResponseBytes");
    this.#timeoutMs = positive(options.timeoutMs, 30_000, "timeoutMs");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    this.assertStringKey(key);
    const table = this.tableFor(key);
    const compiled = compileLibSQLQuery(table, { source: { kind: "collection", name: key.collection }, filters: [{ field: "__name__", operator: "==", value: key.id }], orders: [] }, 2);
    const rows = await this.select(compiled.sql, compiled.args, table);
    if (rows.length === 0) return { key, exists: false };
    if (rows.length !== 1 || rows[0]?.__dalgo_key !== key.id) throw new UnsupportedError("libSQL key mapping returned more than one record");
    return this.snapshot(key, rows[0] ?? {}, codec);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length === 0) return [];
    if (keys.length > this.#maxRows) throw new UnsupportedError(`libSQL getMany above configured maxRows (${String(this.#maxRows)})`);
    const first = keys[0]; if (first === undefined) throw new Error("libSQL lost first key");
    for (const key of keys) this.assertStringKey(key);
    const table = this.tableFor(first);
    if (keys.some((key) => this.tableFor(key) !== table)) throw new UnsupportedError("libSQL getMany across table mappings");
    return Promise.all(keys.map((key) => this.get(key, codec)));
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    const table = this.tableForCollection(query.source.name);
    const requested = query.limit ?? this.#maxRows;
    if (!Number.isSafeInteger(requested) || requested < 1) throw new TypeError("libSQL query limit must be positive");
    if (requested > this.#maxRows) throw new UnsupportedError(`libSQL query above configured maxRows (${String(this.#maxRows)})`);
    const compiled = compileLibSQLQuery(table, query, requested + 1);
    const rows = await this.select(compiled.sql, compiled.args, table);
    const selected = rows.slice(0, requested);
    const records = selected.map((row) => this.snapshot(new Key(query.source.name, String(row.__dalgo_key)), row, query.source.codec) as ExistingRecord<T>);
    const last = selected.at(-1);
    const nextCursor = query.orders.length > 0 && rows.length > requested && last !== undefined
      ? { values: compiled.cursorColumns.map((column) => last[column.column === table.keyColumn.column ? "__dalgo_key" : this.fieldForColumn(table, column.column)]) }
      : undefined;
    return nextCursor === undefined ? { records } : { records, nextCursor };
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    this.assertStringKey(key); const table = this.writableTable(key); const values = this.fullData(data, codec, table);
    const fields = Object.keys(table.columns);
    const dataValues = this.valuesFor(fields, values);
    try {
      this.assertSingleWrite(await this.mutate(`INSERT INTO ${this.quotedTable(table)} (${[table.keyColumn.column, ...fields.map((field) => table.columns[field]?.column)].map((column) => this.quotedColumn(column)).join(", ")}) VALUES (${[key.id, ...dataValues].map(() => "?").join(", ")})`, [key.id, ...dataValues]));
    } catch (error) {
      if (error instanceof LibSQLPipelineError && this.isDuplicateKey(error)) throw new AlreadyExistsError(key, { cause: error });
      throw error;
    }
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    this.assertStringKey(key); const table = this.writableTable(key); const values = this.fullData(data, codec, table);
    const fields = Object.keys(table.columns);
    const dataValues = this.valuesFor(fields, values);
    const columns = [table.keyColumn.column, ...fields.map((field) => table.columns[field]?.column)];
    const assignments = fields.map((field) => `${this.quotedColumn(table.columns[field]?.column)} = excluded.${this.quotedColumn(table.columns[field]?.column)}`).join(", ");
    this.assertSingleWrite(await this.mutate(`INSERT INTO ${this.quotedTable(table)} (${columns.map((column) => this.quotedColumn(column)).join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT(${this.quotedColumn(table.keyColumn.column)}) DO UPDATE SET ${assignments}`, [key.id, ...dataValues]));
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    this.assertStringKey(key); const table = this.writableTable(key); const values = this.partialData(data, table);
    const fields = Object.keys(values);
    if (fields.length === 0) return;
    await this.mutate(`UPDATE ${this.quotedTable(table)} SET ${fields.map((field) => `${this.quotedColumn(table.columns[field]?.column)} = ?`).join(", ")} WHERE ${this.quotedColumn(table.keyColumn.column)} = ?`, [...this.valuesFor(fields, values), key.id]);
  }

  public async delete(key: Key): Promise<void> {
    this.assertStringKey(key); const table = this.writableTable(key);
    await this.mutate(`DELETE FROM ${this.quotedTable(table)} WHERE ${this.quotedColumn(table.keyColumn.column)} = ?`, [key.id]);
  }
  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> { void callback; return Promise.reject(new UnsupportedError("libSQL callback transactions are not implemented")); }

  private tableFor(key: Key): LibSQLTable { if (key.parent !== undefined) throw new UnsupportedError("libSQL nested collection keys"); return this.tableForCollection(key.collection); }
  private writableTable(key: Key): LibSQLTable { const table = this.tableFor(key); if (table.uniqueKey !== true) throw new UnsupportedError("libSQL writes require a table mapping with uniqueKey: true"); return table; }
  private assertStringKey(key: Key): asserts key is Key<string> { if (typeof key.id !== "string") throw new UnsupportedError("libSQL DALgo keys must be strings"); }
  private tableForCollection(collection: string): LibSQLTable { const table = this.#tables[collection]; if (table === undefined) throw new UnsupportedError(`libSQL collection is not mapped: ${collection}`); return table; }
  private fieldForColumn(table: LibSQLTable, column: string): string { for (const [field, mapped] of Object.entries(table.columns)) if (mapped.column === column) return field; throw new Error("libSQL cursor column is not mapped"); }
  private snapshot<T>(key: Key, row: Readonly<Record<string, LibSQLScalar>>, codec?: Codec<T>): RecordSnapshot<T> { const data = { ...row }; delete data.__dalgo_key; return { key, exists: true, data: identityOr(codec).decode(data) }; }
  private quotedTable(table: LibSQLTable): string { return `"${table.table}"`; }
  private quotedColumn(column: string | undefined): string { if (column === undefined) throw new Error("libSQL mapped column missing"); return `"${column}"`; }
  private fullData<T>(data: T, codec: Codec<T> | undefined, table: LibSQLTable): Record<string, LibSQLScalar> {
    const encoded = identityOr(codec).encode(data);
    if (!isObject(encoded)) throw new UnsupportedError("libSQL DALgo data must encode to a top-level object");
    const fields = Object.keys(table.columns);
    if (Object.keys(encoded).length !== fields.length || fields.some((field) => !Object.hasOwn(encoded, field))) throw new UnsupportedError("libSQL insert and set data must exactly match the declared table projection");
    return this.partialData(encoded, table);
  }
  private partialData(data: unknown, table: LibSQLTable): Record<string, LibSQLScalar> {
    if (!isObject(data)) throw new UnsupportedError("libSQL update data must be a top-level object");
    const result: Record<string, LibSQLScalar> = {};
    for (const [field, value] of Object.entries(data)) {
      if (table.columns[field] === undefined) throw new UnsupportedError(`libSQL field is not declared in the table mapping: ${field}`);
      if (field === "__dalgo_key") throw new UnsupportedError("libSQL updates cannot change the DALgo key");
      result[field] = this.scalar(value);
    }
    return result;
  }
  private valuesFor(fields: readonly string[], values: Readonly<Record<string, LibSQLScalar>>): readonly LibSQLScalar[] {
    return fields.map((field) => {
      const value = values[field];
      if (value === undefined) throw new Error(`libSQL mapped value missing: ${field}`);
      return value;
    });
  }
  private scalar(value: unknown): LibSQLScalar { return libSQLScalar(value, "mapped"); }
  private assertSingleWrite(affected: number): void { if (affected !== 1) throw new UnsupportedError("libSQL insert or set did not affect exactly one record"); }
  private isDuplicateKey(error: LibSQLPipelineError): boolean {
    return [error.code, error.extendedCode].some((code) => code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY");
  }

  private async select(sql: string, args: readonly LibSQLScalar[], table: LibSQLTable): Promise<readonly Record<string, LibSQLScalar>[]> {
    const result = await this.pipeline(sql, args, true);
    return resultRows(result, table);
  }
  private async mutate(sql: string, args: readonly LibSQLScalar[]): Promise<number> { return affectedRows(await this.pipeline(sql, args, false)); }

  private async pipeline(sql: string, args: readonly LibSQLScalar[], wantRows: boolean): Promise<HranaStatementResult> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const supplied = this.#headers === undefined
        ? {}
        : await this.awaitWithinDeadline(Promise.resolve().then(() => this.#headers?.()), controller, "libSQL request headers could not be obtained");
      if (!isObject(supplied)) throw new TypeError("headers must return an object");
      const headers = headersFrom(supplied as Readonly<Record<string, string>>);
      this.throwIfAborted(controller);
      const body = JSON.stringify({ baton: null, requests: [{ type: "execute", stmt: { sql, args: args.map(encodedValue), want_rows: wantRows } }, { type: "close" }] });
      this.throwIfAborted(controller);
      const response = await this.awaitWithinDeadline(this.#fetch(`${this.#origin}/v3/pipeline`, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { ...headers, accept: "application/json", "content-type": "application/json" }, body,
      }), controller, "libSQL pipeline request failed");
      if (!response.ok) throw new LibSQLHttpError(response.status);
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > this.#maxResponseBytes)) throw new UnsupportedError("libSQL response exceeds maxResponseBytes");
      const responseBody = await this.readBoundedBody(response, controller);
      return pipelineResult(this.parsePipelineJson(responseBody));
    } finally { clearTimeout(timer); }
  }

  private parsePipelineJson(body: string): unknown {
    try { return JSON.parse(body) as unknown; } catch { throw new TypeError("malformed libSQL JSON response"); }
  }

  private throwIfAborted(controller: AbortController): void {
    if (controller.signal.aborted) throw new UnsupportedError("libSQL operation exceeded configured timeout");
  }

  private async awaitWithinDeadline<T>(operation: Promise<T>, controller: AbortController, failureMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(new UnsupportedError("libSQL operation exceeded configured timeout"));
      if (controller.signal.aborted) { onAbort(); return; }
      controller.signal.addEventListener("abort", onAbort, { once: true });
      void operation.then(
        (value) => { controller.signal.removeEventListener("abort", onAbort); resolve(value); },
        () => { controller.signal.removeEventListener("abort", onAbort); reject(new Error(failureMessage)); },
      );
    });
  }

  private async readBoundedBody(response: Response, controller: AbortController): Promise<string> {
    if (response.body === null) throw new TypeError("libSQL response was unexpectedly empty");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const next = await this.awaitWithinDeadline(reader.read(), controller, "libSQL response body could not be read"); if (next.done) break;
        size += next.value.byteLength;
        if (size > this.#maxResponseBytes) {
          void reader.cancel().catch(() => undefined);
          throw new UnsupportedError("libSQL response exceeds maxResponseBytes");
        }
        chunks.push(next.value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* A mocked stream can retain a pending read after deadline expiry. */ }
    }
    const output = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(output);
  }
}
