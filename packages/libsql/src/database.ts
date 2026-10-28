import {
  QueryCancelledError,
  createAbortScope,
  type AbortScope,
} from "@dalgo/adapter-runtime";
import {
  AlreadyExistsError,
  DOCUMENT_ID,
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
} from "@dalgo/core";

import { LIBSQL_READ_CAPABILITIES } from "./capabilities.js";
import {
  LibSQLBatchSizeError,
  LibSQLCursorError,
  LibSQLHttpError,
  LibSQLPipelineError,
  LibSQLRequestError,
} from "./errors.js";
import {
  LIBSQL_CURSOR_ADAPTER,
  LIBSQL_CURSOR_VERSION,
  LibSQLCursorRegistry,
  libSQLCanonicalJson,
  type PreviewCursor,
} from "./cursor.js";
import {
  discoverLibSQL,
  discoveryFailure,
  discoveryUnavailable,
  type DiscoveryAllowlistEntry,
} from "./metadata.js";
import { affectedRows, decodeRows, rowKey } from "./rows.js";
import {
  compileLibSQLQuery,
  libSQLCursorPosition,
  libSQLScalar,
  validateIdentifier,
  type LibSQLKeyValue,
  type LibSQLScalar,
} from "./sql.js";
import {
  LibSQLTransport,
  requireStatement,
  validBaseUrl,
  type RequestContext,
} from "./transport.js";
import type {
  LibSQLColumn,
  LibSQLConnectionStatus,
  LibSQLDatabaseOptions,
  LibSQLDiscovery,
  LibSQLTable,
} from "./types.js";

const DEFAULT_MAX_ROWS = 1_000;
const DEFAULT_MAX_GET_MANY = 100;
const DEFAULT_MAX_PARALLEL_READS = 8;
const DEFAULT_MAX_GET_MANY_BYTES = 1_048_576;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_METADATA_TABLES = 100;
const DEFAULT_MAX_METADATA_FIELDS = 256;
const DEFAULT_MAX_METADATA_STATEMENTS = 512;
const DEFAULT_MAX_METADATA_BYTES = 1_048_576;
const DEFAULT_MAX_QUERY_PAGES = 10_000;
const DEFAULT_MAX_CURSOR_BYTES = 8_192;
const DEFAULT_MAX_ISSUED_CURSORS = 1_000;
const DEFAULT_MAX_CONSERVED_CURSORS = 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_KEY_CHARS = 4_096;

function positive(value: number | undefined, fallback: number, name: string, maximum = 16_777_216): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new TypeError(`${name} must be a safe integer from 1 to ${String(maximum)}`);
  }
  return result;
}

function identityOr<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }

/** Own-property maps: no prototype can shadow or silently swallow a configured name. */
function ownRecord<T>(): Record<string, T> { return Object.create(null) as Record<string, T>; }

/**
 * `__proto__` is a valid SQL identifier but never a safe object key: plain
 * property assignment would silently change a prototype instead of storing the
 * field. It is refused at configuration time, before any I/O, rather than
 * dropping data from a projection.
 */
function assertObjectKeyName(value: string, label: string): void {
  validateIdentifier(value, label);
  if (value === "__proto__") throw new TypeError(`${label} must not be __proto__`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function controlFree(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function identityScopeName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 256 || !controlFree(value)) {
    throw new TypeError("identityScope must be a non-empty, bounded, control-free string");
  }
  return value;
}

function freezeColumn(column: LibSQLColumn, label: string): LibSQLColumn {
  validateIdentifier(column.column, label);
  if (column.nullable !== undefined && typeof column.nullable !== "boolean") throw new TypeError("nullable must be a boolean");
  return Object.freeze({ column: column.column, ...(column.nullable === undefined ? {} : { nullable: column.nullable }) });
}

function freezeTables(tables: Readonly<Record<string, LibSQLTable>>): Readonly<Record<string, LibSQLTable>> {
  const result = ownRecord<LibSQLTable>();
  const physical = new Set<string>();
  for (const [collection, table] of Object.entries(tables)) {
    assertObjectKeyName(collection, "collection name");
    validateIdentifier(table.table, "table");
    if (physical.has(table.table)) throw new TypeError(`duplicate libSQL table mapping: ${table.table}`);
    physical.add(table.table);
    const names = new Set<string>();
    const keyColumn = freezeColumn(table.keyColumn, "mapped column");
    names.add(keyColumn.column);
    const columns = ownRecord<LibSQLColumn>();
    for (const [field, column] of Object.entries(table.columns)) {
      if (field === "__dalgo_key") throw new TypeError("__dalgo_key is reserved by the libSQL adapter");
      assertObjectKeyName(field, "mapped field");
      const copied = freezeColumn(column, "mapped column");
      if (names.has(copied.column)) throw new TypeError(`duplicate libSQL mapped column: ${copied.column}`);
      names.add(copied.column);
      columns[field] = copied;
    }
    if (Object.keys(columns).length === 0) throw new TypeError("libSQL table mappings require at least one mapped data column");
    if (table.uniqueKey !== undefined && typeof table.uniqueKey !== "boolean") throw new TypeError("uniqueKey must be a boolean");
    result[collection] = Object.freeze({
      table: table.table,
      ...(table.uniqueKey === undefined ? {} : { uniqueKey: table.uniqueKey }),
      keyColumn,
      columns: Object.freeze(columns),
    });
  }
  return Object.freeze(result);
}

/** DALgo adapter for the provider-neutral JSON Hrana `POST /v3/pipeline` protocol. */
export class LibSQLDatabase implements Database {
  readonly #transport: LibSQLTransport;
  readonly #tables: Readonly<Record<string, LibSQLTable>>;
  readonly #allowlist: ReadonlyMap<string, DiscoveryAllowlistEntry>;
  readonly #identityScope: string | undefined;
  readonly #maxRows: number;
  readonly #maxGetManyKeys: number;
  readonly #maxParallelReads: number;
  readonly #maxGetManyBytes: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #timeoutMs: number;
  readonly #maxQueryPages: number;
  readonly #maxCursorBytes: number;
  readonly #maxMetadataTables: number;
  readonly #maxMetadataFields: number;
  readonly #maxMetadataStatements: number;
  readonly #maxMetadataBytes: number;
  readonly #cursors: LibSQLCursorRegistry;

  public constructor(options: LibSQLDatabaseOptions) {
    if (options.headers !== undefined && typeof options.headers !== "function") throw new TypeError("headers must be a function returning request headers");
    this.#tables = freezeTables(options.tables);
    const allowlist = new Map<string, DiscoveryAllowlistEntry>();
    for (const [collection, table] of Object.entries(this.#tables)) {
      allowlist.set(table.table, { collection, keyColumn: table.keyColumn.column, uniqueKey: table.uniqueKey === true });
    }
    this.#allowlist = allowlist;
    this.#identityScope = identityScopeName(options.identityScope);
    this.#maxRows = positive(options.maxRows, DEFAULT_MAX_ROWS, "maxRows", 1_000_000);
    this.#maxGetManyKeys = positive(options.maxGetManyKeys, Math.min(DEFAULT_MAX_GET_MANY, this.#maxRows), "maxGetManyKeys", 1_000);
    this.#maxParallelReads = positive(options.maxParallelReads, Math.min(DEFAULT_MAX_PARALLEL_READS, this.#maxGetManyKeys), "maxParallelReads", this.#maxGetManyKeys);
    this.#maxGetManyBytes = positive(options.maxGetManyBytes, DEFAULT_MAX_GET_MANY_BYTES, "maxGetManyBytes");
    this.#maxRequestBytes = positive(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, "maxRequestBytes");
    this.#maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 120_000);
    this.#maxQueryPages = positive(options.maxQueryPages, DEFAULT_MAX_QUERY_PAGES, "maxQueryPages", 1_000_000);
    this.#maxCursorBytes = positive(options.maxCursorBytes, DEFAULT_MAX_CURSOR_BYTES, "maxCursorBytes", 65_536);
    this.#maxMetadataTables = positive(options.maxMetadataTables, DEFAULT_MAX_METADATA_TABLES, "maxMetadataTables", 10_000);
    this.#maxMetadataFields = positive(options.maxMetadataFieldsPerTable, DEFAULT_MAX_METADATA_FIELDS, "maxMetadataFieldsPerTable", 10_000);
    this.#maxMetadataStatements = positive(options.maxMetadataStatements, DEFAULT_MAX_METADATA_STATEMENTS, "maxMetadataStatements", 10_000);
    if (this.#maxMetadataStatements < 2) throw new TypeError("maxMetadataStatements must allow two statements per table");
    this.#maxMetadataBytes = positive(options.maxMetadataBytes, DEFAULT_MAX_METADATA_BYTES, "maxMetadataBytes");
    this.#cursors = new LibSQLCursorRegistry(
      positive(options.maxIssuedCursors, DEFAULT_MAX_ISSUED_CURSORS, "maxIssuedCursors", 1_000_000),
      positive(options.maxConservedCursors, DEFAULT_MAX_CONSERVED_CURSORS, "maxConservedCursors", 1_000_000),
    );
    this.#transport = new LibSQLTransport({
      origin: validBaseUrl(options.serverUrl, options.allowInsecureLoopbackHttp === true),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      fetch: options.fetch ?? globalThis.fetch,
      maxRequestBytes: this.#maxRequestBytes,
      maxResponseBytes: this.#maxResponseBytes,
    });
  }

  public get capabilities() { return LIBSQL_READ_CAPABILITIES; }

  public async get<T>(key: Key, codec?: Codec<T>, signal?: AbortSignal): Promise<RecordSnapshot<T>> {
    return this.within(signal, async (context) => (await this.readOne(key, codec, context)).snapshot);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>, signal?: AbortSignal): Promise<readonly RecordSnapshot<T>[]> {
    return this.within(signal, (context) => this.readMany(keys, codec, context));
  }

  /** Additive cancellable batch read: one deadline covers every key and response. */
  public async getManyWithSignal<T>(keys: readonly Key[], signal: AbortSignal, codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    return this.getMany(keys, codec, signal);
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    return this.within(undefined, (context) => this.runLegacyQuery(query, context));
  }

  /**
   * Cancellable query with adapter-issued opaque keyset cursors. The caller
   * signal and one deadline cover header resolution, fetch, body decoding and
   * page work. Legacy `query` keeps its open position-value cursor contract.
   */
  public async queryWithSignal<T>(query: StructuredQuery<T>, signal: AbortSignal): Promise<QueryPage<T>> {
    return this.within(signal, (context) => this.runModernQuery(query, context));
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const table = this.writableTable(key);
    const values = this.fullData(data, codec, table);
    const fields = Object.keys(table.columns);
    const dataValues = this.valuesFor(fields, values);
    await this.within(undefined, async (context) => {
      const columns = [table.keyColumn.column, ...fields.map((field) => table.columns[field]?.column)];
      const sql = `INSERT INTO ${this.quotedTable(table)} (${columns.map((column) => this.quotedColumn(column)).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
      try {
        this.assertSingleWrite(await this.mutate(sql, [this.keyScalar(key), ...dataValues], context));
      } catch (error) {
        if (error instanceof LibSQLPipelineError && this.isDuplicateKey(error)) throw new AlreadyExistsError(key, { cause: error });
        throw error;
      }
    });
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const table = this.writableTable(key);
    const values = this.fullData(data, codec, table);
    const fields = Object.keys(table.columns);
    const dataValues = this.valuesFor(fields, values);
    await this.within(undefined, async (context) => {
      const columns = [table.keyColumn.column, ...fields.map((field) => table.columns[field]?.column)];
      const assignments = fields.map((field) => `${this.quotedColumn(table.columns[field]?.column)} = excluded.${this.quotedColumn(table.columns[field]?.column)}`).join(", ");
      const sql = `INSERT INTO ${this.quotedTable(table)} (${columns.map((column) => this.quotedColumn(column)).join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT(${this.quotedColumn(table.keyColumn.column)}) DO UPDATE SET ${assignments}`;
      this.assertSingleWrite(await this.mutate(sql, [this.keyScalar(key), ...dataValues], context));
    });
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    const table = this.writableTable(key);
    const values = this.partialData(data, table);
    const fields = Object.keys(values);
    if (fields.length === 0) return;
    await this.within(undefined, async (context) => {
      const sql = `UPDATE ${this.quotedTable(table)} SET ${fields.map((field) => `${this.quotedColumn(table.columns[field]?.column)} = ?`).join(", ")} WHERE ${this.quotedColumn(table.keyColumn.column)} = ?`;
      await this.mutate(sql, [...this.valuesFor(fields, values), this.keyScalar(key)], context);
    });
  }

  public async delete(key: Key): Promise<void> {
    const table = this.writableTable(key);
    await this.within(undefined, async (context) => {
      await this.mutate(`DELETE FROM ${this.quotedTable(table)} WHERE ${this.quotedColumn(table.keyColumn.column)} = ?`, [this.keyScalar(key)], context);
    });
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    void callback;
    return Promise.reject(new UnsupportedError("libSQL callback transactions are not implemented"));
  }

  /** Read-only provider metadata; it never creates, alters or writes a table. */
  public async discover(signal?: AbortSignal): Promise<LibSQLDiscovery> {
    try {
      return await this.within(signal, (context) => discoverLibSQL(this.#transport, this.#allowlist, this.metadataBounds, context));
    } catch (error) {
      if (error instanceof QueryCancelledError) throw error;
      const failure = discoveryFailure(error);
      return discoveryUnavailable(this.#transport.origin, failure.reason, failure.detail, this.metadataBounds, failure.httpStatus);
    }
  }

  /** A safe UI-factory preflight: proves transport, identity and metadata access. */
  public async testConnection(signal?: AbortSignal): Promise<LibSQLConnectionStatus> {
    const discovery = await this.discover(signal);
    if (discovery.status === "available") {
      return { ok: true, status: "connected", tableCount: discovery.tableCount, detail: discovery.detail };
    }
    const status = discovery.reason === "unauthorized"
      ? "unauthorized"
      : discovery.reason === "forbidden"
        ? "forbidden"
        : discovery.reason === "malformed-metadata"
          ? "metadata-malformed"
          : discovery.reason === "metadata-unsupported" || discovery.reason === "metadata-too-large"
            ? "metadata-unsupported"
            : "unreachable";
    return {
      ok: false,
      status,
      ...(discovery.httpStatus === undefined ? {} : { httpStatus: discovery.httpStatus }),
      detail: discovery.detail,
    };
  }

  private get metadataBounds() {
    return {
      maxTables: this.#maxMetadataTables,
      maxFieldsPerTable: this.#maxMetadataFields,
      maxStatements: this.#maxMetadataStatements,
      maxMetadataBytes: this.#maxMetadataBytes,
    };
  }

  private async within<T>(callerSignal: AbortSignal | undefined, work: (context: RequestContext) => Promise<T>): Promise<T> {
    if (callerSignal?.aborted === true) throw new QueryCancelledError("caller");
    const scope: AbortScope = createAbortScope(callerSignal, this.#timeoutMs);
    const cancelled = (): Error => callerSignal === undefined
      ? new UnsupportedError("libSQL operation exceeded configured timeout")
      : new QueryCancelledError(scope.deadlineExceeded ? "deadline" : "caller");
    try {
      const result = await work({
        signal: scope.signal,
        cancelled,
        failed: () => new LibSQLRequestError(),
      });
      if (scope.signal.aborted) throw cancelled();
      return result;
    } catch (error) {
      if (scope.signal.aborted) throw cancelled();
      throw error;
    } finally {
      scope.dispose();
    }
  }

  private async readOne<T>(key: Key, codec: Codec<T> | undefined, context: RequestContext): Promise<{ readonly snapshot: RecordSnapshot<T>; readonly bytes: number }> {
    const table = this.tableFor(key);
    const compiled = compileLibSQLQuery(table, {
      source: { kind: "collection", name: key.collection },
      filters: [{ field: DOCUMENT_ID, operator: "==", value: key.id }],
      orders: [],
    }, 2);
    const { rows, bytes } = await this.select(compiled.sql, compiled.args, table, 2, context);
    if (rows.length === 0) return { snapshot: { key, exists: false }, bytes };
    if (rows.length !== 1) throw new UnsupportedError("libSQL key mapping returned more than one record");
    const row = rows[0];
    if (row === undefined || !Object.is(rowKey(row), key.id)) throw new UnsupportedError("libSQL key mapping returned a different record");
    return { snapshot: this.snapshot(key, row, codec), bytes };
  }

  private async readMany<T>(keys: readonly Key[], codec: Codec<T> | undefined, context: RequestContext): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#maxGetManyKeys) throw new UnsupportedError(`libSQL getMany above maxGetManyKeys (${String(this.#maxGetManyKeys)})`);
    const results: RecordSnapshot<T>[] = new Array(keys.length);
    if (keys.length === 0) return results;
    const first = keys[0];
    if (first === undefined) throw new Error("libSQL lost first key");
    const table = this.tableFor(first);
    for (const key of keys) {
      if (this.tableFor(key) !== table) throw new UnsupportedError("libSQL getMany across table mappings");
    }
    const batch = new AbortController();
    const forwardAbort = (): void => { batch.abort(); };
    if (context.signal.aborted) batch.abort();
    else context.signal.addEventListener("abort", forwardAbort, { once: true });
    const batchContext: RequestContext = { ...context, signal: batch.signal };
    let failure: { readonly error: unknown } | undefined;
    let acceptedBytes = 0;
    let next = 0;
    const stop = (error: unknown): void => {
      if (failure !== undefined) return;
      failure = { error };
      batch.abort();
    };
    const worker = async (): Promise<void> => {
      for (;;) {
        if (failure !== undefined || batch.signal.aborted) return;
        const index = next;
        next += 1;
        const key = keys[index];
        if (key === undefined) return;
        try {
          const { snapshot, bytes } = await this.readOne(key, codec, batchContext);
          if (failure !== undefined || batch.signal.aborted) return;
          if (acceptedBytes + bytes > this.#maxGetManyBytes) { stop(new LibSQLBatchSizeError()); return; }
          acceptedBytes += bytes;
          results[index] = snapshot;
        } catch (error) {
          stop(error);
          return;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(this.#maxParallelReads, keys.length) }, () => worker()));
      if (context.signal.aborted) throw context.cancelled();
      if (failure !== undefined) throw failure.error;
      return results;
    } finally {
      context.signal.removeEventListener("abort", forwardAbort);
    }
  }

  private async runLegacyQuery<T>(query: StructuredQuery<T>, context: RequestContext): Promise<QueryPage<T>> {
    const table = this.tableForCollection(query.source.name);
    const requested = this.legacyLimit(query);
    const compiled = compileLibSQLQuery(table, query, requested + 1, this.#maxCursorBytes);
    const { rows } = await this.select(compiled.sql, compiled.args, table, requested + 1, context);
    const selected = rows.slice(0, requested);
    const records = selected.map((row) => this.record(query.source.name, row, query.source.codec));
    const last = selected.at(-1);
    if (query.orders.length === 0 || rows.length <= requested || last === undefined) return { records };
    const values = compiled.cursorColumns.map((column) => {
      const value = column.column === table.keyColumn.column ? last.__dalgo_key : last[this.fieldForColumn(table, column.column)];
      if (typeof value === "string" && value.length > this.#maxCursorBytes) {
        throw new UnsupportedError("libSQL legacy cursor value exceeds maxCursorBytes");
      }
      return value;
    });
    return { records, nextCursor: { values } };
  }

  private async runModernQuery<T>(query: StructuredQuery<T>, context: RequestContext): Promise<QueryPage<T>> {
    const table = this.tableForCollection(query.source.name);
    this.assertModernQuery(query);
    const limit = query.limit ?? this.#maxRows;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("libSQL query limit must be positive");
    if (limit > this.#maxRows) throw new UnsupportedError(`libSQL query above configured maxRows (${String(this.#maxRows)})`);
    // An unordered modern page must still be deterministic. The configured key
    // is the only stable total order available, so it becomes the honest
    // implicit order instead of issuing a cursor that no continuation can use.
    const ordered: StructuredQuery<T> = query.orders.length === 0
      ? { ...query, orders: [{ field: DOCUMENT_ID, direction: "asc" }] }
      : query;
    const base: StructuredQuery<T> = {
      source: query.source,
      filters: query.filters,
      orders: ordered.orders,
      limit,
    };
    const baseCompiled = compileLibSQLQuery(table, base, limit, this.#maxCursorBytes);
    const fingerprint = this.queryFingerprint(table, ordered, baseCompiled.cursorColumns, limit);
    let stored: PreviewCursor | undefined;
    let token: string | undefined;
    let observed: Record<string, string> | undefined;
    if (query.startAfter !== undefined) {
      if (query.startAfter.values.length !== 1) throw new TypeError("libSQL query cursor must contain exactly one adapter handle");
      const value = query.startAfter.values[0];
      if (typeof value !== "string") throw new LibSQLCursorError("malformed");
      token = value;
      stored = this.#cursors.reserve(token, fingerprint);
      if (stored.page < 1 || stored.page >= this.#maxQueryPages) {
        this.#cursors.release(token);
        throw new UnsupportedError(`libSQL query cursor page above maxQueryPages (${String(this.#maxQueryPages)})`);
      }
    }
    const nextPage = stored === undefined ? 1 : stored.page + 1;
    const continuation = stored === undefined
      ? undefined
      : compileLibSQLQuery(table, { ...base, startAfter: { values: stored.values } }, limit, this.#maxCursorBytes);
    let committed = false;
    try {
      const outcome = await this.#transport.pipeline(
        [{ sql: (continuation ?? baseCompiled).sql, args: (continuation ?? baseCompiled).args, wantRows: true }],
        context,
        (headers) => {
          observed = headers;
          if (stored !== undefined && this.scopeFor(headers) !== stored.scope) {
            throw new LibSQLCursorError("changed-query");
          }
        },
      );
      if (stored !== undefined && token !== undefined) {
        this.#cursors.commit(token);
        committed = true;
      }
      const first = outcome.outcomes[0];
      if (first === undefined) throw new TypeError("libSQL statement outcome missing");
      const result = requireStatement(first);
      const rows = decodeRows(result, ["__dalgo_key", ...Object.keys(table.columns)], limit, "select");
      const records = rows.map((row) => this.record(query.source.name, row, query.source.codec));
      this.assertDistinctKeys(records);
      if (observed === undefined) throw new TypeError("libSQL request headers were not observed");
      if (rows.length === 0) return { records };
      const scope = stored?.scope ?? this.scopeFor(observed);
      // Positions are checked against this instance's cursor budget BEFORE a
      // handle exists: an over-budget or unsafe position fails the whole
      // operation instead of publishing a cursor that can never be consumed.
      const values = baseCompiled.cursorColumns.map((column) => this.cursorPosition(table, rows[rows.length - 1], column));
      const issued = this.#cursors.issue({ query: fingerprint, scope }, nextPage, values);
      return { records, nextCursor: { values: [issued] } };
    } catch (error) {
      if (!committed && token !== undefined) this.#cursors.release(token);
      throw error;
    }
  }

  private assertModernQuery<T>(query: StructuredQuery<T>): void {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) {
      throw new UnsupportedError("libSQL collection-group or nested-collection queries");
    }
    for (const key of ["projection", "select", "columns", "fields"]) {
      if (Object.hasOwn(query, key)) throw new UnsupportedError("libSQL query projection");
    }
    if (query.offset !== undefined) throw new UnsupportedError("libSQL query offsets");
    if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
      throw new UnsupportedError("libSQL inclusive or end cursors");
    }
  }

  private legacyLimit<T>(query: StructuredQuery<T>): number {
    const requested = query.limit ?? this.#maxRows;
    if (!Number.isSafeInteger(requested) || requested < 1) throw new TypeError("libSQL query limit must be positive");
    if (requested > this.#maxRows) throw new UnsupportedError(`libSQL query above configured maxRows (${String(this.#maxRows)})`);
    return requested;
  }

  private queryFingerprint<T>(
    table: LibSQLTable,
    query: StructuredQuery<T>,
    columns: readonly LibSQLColumn[],
    limit: number,
  ): string {
    return this.#cursors.binding({
      adapter: LIBSQL_CURSOR_ADAPTER,
      version: LIBSQL_CURSOR_VERSION,
      endpoint: this.#transport.origin,
      collection: query.source.name,
      table: table.table,
      keyColumn: table.keyColumn.column,
      filters: query.filters.map((filter) => [String(filter.field), filter.operator, filter.value]),
      orders: columns.map((column, index) => [column.column, query.orders[index]?.direction ?? "asc"]),
      limit,
    });
  }

  private scopeFor(headers: Readonly<Record<string, string>>): string {
    if (this.#identityScope !== undefined) return this.#cursors.scope(`explicit:${this.#identityScope}`);
    const entries = Object.entries(headers).map(([name, value]) => `${name.toLowerCase()}:${value}`).sort();
    return this.#cursors.scope(`headers:${libSQLCanonicalJson(entries)}`);
  }

  private cursorPosition(table: LibSQLTable, row: Readonly<Record<string, LibSQLScalar>> | undefined, column: LibSQLColumn): string | number | null {
    if (row === undefined) throw new Error("libSQL cursor row missing");
    const value = column.column === table.keyColumn.column
      ? row.__dalgo_key
      : row[this.fieldForColumn(table, column.column)];
    if (value === undefined) throw new TypeError("libSQL cursor column is not projected");
    return libSQLCursorPosition(value, this.#maxCursorBytes, "query");
  }

  private assertDistinctKeys<T>(records: readonly ExistingRecord<T>[]): void {
    const seen = new Set<string | number>();
    for (const record of records) {
      if (seen.has(record.key.id)) throw new UnsupportedError("libSQL query returned duplicate record keys");
      seen.add(record.key.id);
    }
  }

  private tableFor(key: Key): LibSQLTable {
    if (key.parent !== undefined) throw new UnsupportedError("libSQL nested collection keys");
    this.assertKey(key);
    return this.tableForCollection(key.collection);
  }

  private writableTable(key: Key): LibSQLTable {
    const table = this.tableFor(key);
    if (table.uniqueKey !== true) throw new UnsupportedError("libSQL writes require a table mapping with uniqueKey: true");
    return table;
  }

  private assertKey(key: Key): asserts key is Key<LibSQLKeyValue> {
    if (typeof key.id === "string") {
      if (key.id.length === 0 || key.id.length > MAX_KEY_CHARS) throw new UnsupportedError("libSQL string keys must be bounded and non-empty");
      return;
    }
    if (typeof key.id === "number") {
      if (!Number.isFinite(key.id) || Object.is(key.id, -0)) {
        throw new UnsupportedError("libSQL numeric keys must be finite and not negative zero");
      }
      if (Number.isInteger(key.id) && !Number.isSafeInteger(key.id)) {
        throw new UnsupportedError("libSQL integral keys must be JavaScript safe integers");
      }
      return;
    }
    throw new UnsupportedError("libSQL DALgo keys must be strings or finite numbers");
  }

  private keyScalar(key: Key): LibSQLKeyValue {
    this.assertKey(key);
    return key.id;
  }

  private tableForCollection(collection: string): LibSQLTable {
    const table = this.#tables[collection];
    if (table === undefined) throw new UnsupportedError(`libSQL collection is not mapped: ${collection}`);
    return table;
  }

  private fieldForColumn(table: LibSQLTable, column: string): string {
    for (const [field, mapped] of Object.entries(table.columns)) if (mapped.column === column) return field;
    throw new Error("libSQL cursor column is not mapped");
  }

  private record<T>(collection: string, row: Readonly<Record<string, LibSQLScalar>>, codec?: Codec<T>): ExistingRecord<T> {
    return { key: new Key(collection, rowKey(row)), exists: true, data: this.snapshotData(row, codec) };
  }

  private snapshot<T>(key: Key, row: Readonly<Record<string, LibSQLScalar>>, codec?: Codec<T>): RecordSnapshot<T> {
    return { key, exists: true, data: this.snapshotData(row, codec) };
  }

  private snapshotData<T>(row: Readonly<Record<string, LibSQLScalar>>, codec?: Codec<T>): T {
    const data = { ...row };
    delete data.__dalgo_key;
    return identityOr(codec).decode(data);
  }

  private quotedTable(table: LibSQLTable): string { return `"${table.table}"`; }
  private quotedColumn(column: string | undefined): string {
    if (column === undefined) throw new Error("libSQL mapped column missing");
    return `"${column}"`;
  }

  private fullData<T>(data: T, codec: Codec<T> | undefined, table: LibSQLTable): Record<string, LibSQLScalar> {
    const encoded = identityOr(codec).encode(data);
    if (!isObject(encoded)) throw new UnsupportedError("libSQL DALgo data must encode to a top-level object");
    const fields = Object.keys(table.columns);
    if (Object.keys(encoded).length !== fields.length || fields.some((field) => !Object.hasOwn(encoded, field))) {
      throw new UnsupportedError("libSQL insert and set data must exactly match the declared table projection");
    }
    return this.partialData(encoded, table);
  }

  private partialData(data: unknown, table: LibSQLTable): Record<string, LibSQLScalar> {
    if (!isObject(data)) throw new UnsupportedError("libSQL update data must be a top-level object");
    const result = ownRecord<LibSQLScalar>();
    for (const [field, value] of Object.entries(data)) {
      if (field === "__dalgo_key") throw new UnsupportedError("libSQL updates cannot change the DALgo key");
      if (table.columns[field] === undefined) throw new UnsupportedError(`libSQL field is not declared in the table mapping: ${field}`);
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

  private assertSingleWrite(affected: number): void {
    if (affected !== 1) throw new UnsupportedError("libSQL insert or set did not affect exactly one record");
  }

  private isDuplicateKey(error: LibSQLPipelineError): boolean {
    return [error.code, error.extendedCode].some((code) => code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY");
  }

  private async select(
    sql: string,
    args: readonly LibSQLScalar[],
    table: LibSQLTable,
    maximumRows: number,
    context: RequestContext,
  ): Promise<{ readonly rows: readonly Record<string, LibSQLScalar>[]; readonly bytes: number }> {
    const outcome = await this.#transport.pipeline([{ sql, args, wantRows: true }], context);
    if (outcome.outcomes[0] === undefined) throw new TypeError("libSQL statement outcome missing");
    const result = requireStatement(outcome.outcomes[0]);
    return { rows: decodeRows(result, ["__dalgo_key", ...Object.keys(table.columns)], maximumRows, "select"), bytes: outcome.bytes };
  }

  private async mutate(sql: string, args: readonly LibSQLScalar[], context: RequestContext): Promise<number> {
    const outcome = await this.#transport.pipeline([{ sql, args, wantRows: false }], context);
    if (outcome.outcomes[0] === undefined) throw new TypeError("libSQL statement outcome missing");
    return affectedRows(requireStatement(outcome.outcomes[0]));
  }
}

export { LibSQLBatchSizeError, LibSQLCursorError, LibSQLHttpError, LibSQLPipelineError, LibSQLRequestError };
