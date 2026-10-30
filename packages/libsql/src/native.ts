import {
  QueryCancelledError,
  createAbortScope,
  type AbortScope,
} from "@dalgo/adapter-runtime";
import {
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

import { NATIVE_LIBSQL_READ_CAPABILITIES } from "./capabilities.js";
import {
  LIBSQL_CURSOR_ADAPTER,
  LIBSQL_CURSOR_VERSION,
  LibSQLCursorRegistry,
  libSQLCanonicalJson,
  type PreviewCursor,
} from "./cursor.js";
import {
  LibSQLBatchSizeError,
  LibSQLCursorError,
  LibSQLRequestError,
} from "./errors.js";
import {
  discoverLibSQL,
  discoveryFailure,
  discoveryUnavailable,
  type DiscoveryAllowlistEntry,
} from "./metadata.js";
import { decodeRows, rowKey } from "./rows.js";
import {
  compileNativeLibSQLQuery,
  libSQLCursorPosition,
  libSQLNativeKey,
  validateIdentifier,
  type CompiledNativeLibSQLQuery,
  type LibSQLCursorScalar,
  type LibSQLScalar,
} from "./sql.js";
import {
  LibSQLTransport,
  requireStatement,
  validBaseUrl,
  type RequestContext,
} from "./transport.js";
import type {
  LibSQLConnectionStatus,
  LibSQLDiscovery,
  LibSQLKeyType,
  NativeLibSQLDatabaseOptions,
  NativeLibSQLDescribe,
  NativeLibSQLTable,
} from "./types.js";

const DEFAULT_MAX_GET_MANY = 100;
const DEFAULT_MAX_PARALLEL_READS = 8;
const DEFAULT_MAX_GET_MANY_BYTES = 1_048_576;
const DEFAULT_MAX_QUERY_LIMIT = 100;
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

/** `__proto__` is a valid SQL identifier but never a safe object key. */
function assertObjectKeyName(value: string, label: string): void {
  validateIdentifier(value, label);
  if (value === "__proto__") throw new TypeError(`${label} must not be __proto__`);
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

function keyType(value: unknown): LibSQLKeyType {
  if (value !== "text" && value !== "integer" && value !== "real") throw new TypeError("native key type must be text, integer or real");
  return value;
}

function freezeTables(tables: Readonly<Record<string, NativeLibSQLTable>>): Readonly<Record<string, NativeLibSQLTable>> {
  const result = ownRecord<NativeLibSQLTable>();
  const physical = new Set<string>();
  for (const [collection, table] of Object.entries(tables)) {
    assertObjectKeyName(collection, "collection name");
    validateIdentifier(table.table, "table");
    if (physical.has(table.table)) throw new TypeError(`duplicate native libSQL table mapping: ${table.table}`);
    physical.add(table.table);
    validateIdentifier(table.key.column, "native key column");
    const type = keyType(table.key.type);
    const columns = ownRecord<{ column: string; nullable: boolean }>();
    const names = new Set<string>([table.key.column]);
    for (const [field, column] of Object.entries(table.columns)) {
      if (field === "__dalgo_key") throw new TypeError("__dalgo_key is reserved by the libSQL adapter");
      assertObjectKeyName(field, "mapped field");
      validateIdentifier(column.column, "mapped column");
      if (typeof column.nullable !== "boolean") throw new TypeError("native column nullable must be an explicit boolean");
      if (names.has(column.column)) throw new TypeError(`duplicate native libSQL mapped column: ${column.column}`);
      names.add(column.column);
      columns[field] = Object.freeze({ column: column.column, nullable: column.nullable });
    }
    if (table.uniqueKey !== true) throw new TypeError("native libSQL table allowlist entries require uniqueKey: true");
    result[collection] = Object.freeze({
      table: table.table,
      key: Object.freeze({ column: table.key.column, type }),
      uniqueKey: true,
      columns: Object.freeze(columns),
    });
  }
  return Object.freeze(result);
}

/**
 * Read-only adapter for pre-existing SQLite/libSQL tables and views.
 *
 * The constructor takes an explicit table and field allowlist. Native rows are
 * never rewritten into a `__dalgo_*`/`data` envelope: the configured key column
 * becomes `Key.id` with its original string or safe-number type, the data object
 * contains only allowlisted non-key fields, and metadata repeats the native ID.
 * Every mutation entry point refuses before I/O.
 */
export class NativeLibSQLDatabase implements Database {
  public readonly readOnly = true as const;

  readonly #transport: LibSQLTransport;
  readonly #tables: Readonly<Record<string, NativeLibSQLTable>>;
  readonly #allowlist: ReadonlyMap<string, DiscoveryAllowlistEntry>;
  readonly #identityScope: string | undefined;
  readonly #maxGetManyKeys: number;
  readonly #maxParallelReads: number;
  readonly #maxGetManyBytes: number;
  readonly #maxQueryLimit: number;
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

  public constructor(options: NativeLibSQLDatabaseOptions) {
    if (options.headers !== undefined && typeof options.headers !== "function") throw new TypeError("headers must be a function returning request headers");
    this.#tables = freezeTables(options.tables);
    const allowlist = new Map<string, DiscoveryAllowlistEntry>();
    for (const [collection, table] of Object.entries(this.#tables)) {
      allowlist.set(table.table, {
        collection,
        keyColumn: table.key.column,
        keyType: table.key.type,
        uniqueKey: true,
      });
    }
    this.#allowlist = allowlist;
    this.#identityScope = identityScopeName(options.identityScope);
    this.#maxGetManyKeys = positive(options.maxGetManyKeys, DEFAULT_MAX_GET_MANY, "maxGetManyKeys", 1_000);
    this.#maxParallelReads = positive(options.maxParallelReads, Math.min(DEFAULT_MAX_PARALLEL_READS, this.#maxGetManyKeys), "maxParallelReads", this.#maxGetManyKeys);
    this.#maxGetManyBytes = positive(options.maxGetManyBytes, DEFAULT_MAX_GET_MANY_BYTES, "maxGetManyBytes");
    this.#maxQueryLimit = positive(options.maxQueryLimit, DEFAULT_MAX_QUERY_LIMIT, "maxQueryLimit", 1_000);
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

  public get capabilities() { return NATIVE_LIBSQL_READ_CAPABILITIES; }

  public async get<T>(key: Key, codec?: Codec<T>, signal?: AbortSignal): Promise<RecordSnapshot<T>> {
    return this.within(signal, async (context) => (await this.readOne(key, codec, context)).snapshot);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>, signal?: AbortSignal): Promise<readonly RecordSnapshot<T>[]> {
    return this.within(signal, (context) => this.readMany(keys, codec, context));
  }

  public async getManyWithSignal<T>(keys: readonly Key[], signal: AbortSignal, codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    return this.getMany(keys, codec, signal);
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    return this.within(undefined, (context) => this.runQuery(query, context));
  }

  public async queryWithSignal<T>(query: StructuredQuery<T>, signal: AbortSignal): Promise<QueryPage<T>> {
    return this.within(signal, (context) => this.runQuery(query, context));
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    void callback;
    return Promise.reject(new UnsupportedError("Native libSQL mode is read-only: callback transactions"));
  }

  public insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    void key; void data; void codec;
    return Promise.reject(new UnsupportedError("Native libSQL mode is read-only: insert"));
  }

  public set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    void key; void data; void codec;
    return Promise.reject(new UnsupportedError("Native libSQL mode is read-only: set"));
  }

  public update(key: Key, data: UpdateData): Promise<void> {
    void key; void data;
    return Promise.reject(new UnsupportedError("Native libSQL mode is read-only: update"));
  }

  public delete(key: Key): Promise<void> {
    void key;
    return Promise.reject(new UnsupportedError("Native libSQL mode is read-only: delete"));
  }

  public async discover(signal?: AbortSignal): Promise<LibSQLDiscovery> {
    try {
      return await this.within(signal, (context) => discoverLibSQL(this.#transport, this.#allowlist, this.metadataBounds, context));
    } catch (error) {
      if (error instanceof QueryCancelledError) throw error;
      const failure = discoveryFailure(error);
      return discoveryUnavailable(this.#transport.origin, failure.reason, failure.detail, this.metadataBounds, failure.httpStatus);
    }
  }

  public async testConnection(signal?: AbortSignal): Promise<LibSQLConnectionStatus> {
    return this.connectionStatus(await this.discover(signal));
  }

  private connectionStatus(discovery: LibSQLDiscovery): LibSQLConnectionStatus {
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

  /** A read-only UI-factory preflight that combines connection and metadata. */
  public async describe(signal?: AbortSignal): Promise<NativeLibSQLDescribe> {
    const discovery = await this.discover(signal);
    const connection = this.connectionStatus(discovery);
    return {
      adapter: "@dalgo/dalgo2libsql",
      storage: "native-rows",
      readOnly: true,
      endpoint: this.#transport.origin,
      connection,
      discovery,
      limits: {
        maxGetManyKeys: this.#maxGetManyKeys,
        maxGetManyBytes: this.#maxGetManyBytes,
        maxParallelReads: this.#maxParallelReads,
        maxQueryLimit: this.#maxQueryLimit,
        maxRequestBytes: this.#maxRequestBytes,
        maxResponseBytes: this.#maxResponseBytes,
        maxMetadataTables: this.#maxMetadataTables,
        maxMetadataFieldsPerTable: this.#maxMetadataFields,
        maxMetadataStatements: this.#maxMetadataStatements,
        maxMetadataBytes: this.#maxMetadataBytes,
        maxQueryPages: this.#maxQueryPages,
        maxCursorBytes: this.#maxCursorBytes,
        maxIssuedCursors: this.#cursors.maxIssued,
        maxConservedCursors: this.#cursors.maxConserved,
      },
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
      const result = await work({ signal: scope.signal, cancelled, failed: () => new LibSQLRequestError() });
      if (scope.signal.aborted) throw cancelled();
      return result;
    } catch (error) {
      if (scope.signal.aborted) throw cancelled();
      throw error;
    } finally {
      scope.dispose();
    }
  }

  private tableFor(key: Key): NativeLibSQLTable {
    if (key.parent !== undefined) throw new UnsupportedError("Native libSQL nested collection keys");
    const table = this.#tables[key.collection];
    if (table === undefined) throw new UnsupportedError(`Native libSQL collection is not allowlisted: ${key.collection}`);
    libSQLNativeKey(key.id, table.key.type, "DALgo");
    return table;
  }

  private async readOne<T>(key: Key, codec: Codec<T> | undefined, context: RequestContext): Promise<{ readonly snapshot: RecordSnapshot<T>; readonly bytes: number }> {
    const table = this.tableFor(key);
    const compiled = compileNativeLibSQLQuery(table, {
      source: { kind: "collection", name: key.collection },
      filters: [{ field: DOCUMENT_ID, operator: "==", value: key.id }],
      orders: [],
    }, 2);
    const { rows, bytes } = await this.select(compiled, table, 2, context);
    if (rows.length === 0) return { snapshot: { key, exists: false }, bytes };
    if (rows.length !== 1) throw new UnsupportedError("Native libSQL key mapping returned more than one record");
    const row = rows[0];
    if (row === undefined || !Object.is(rowKey(row), key.id)) throw new UnsupportedError("Native libSQL key mapping returned a different record");
    return { snapshot: this.record(key.collection, row, codec), bytes };
  }

  private async readMany<T>(keys: readonly Key[], codec: Codec<T> | undefined, context: RequestContext): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#maxGetManyKeys) throw new UnsupportedError(`Native libSQL getMany above maxGetManyKeys (${String(this.#maxGetManyKeys)})`);
    const results: RecordSnapshot<T>[] = new Array(keys.length);
    if (keys.length === 0) return results;
    const first = keys[0];
    if (first === undefined) throw new Error("Native libSQL lost first key");
    const table = this.tableFor(first);
    for (const key of keys) {
      if (this.tableFor(key) !== table) throw new UnsupportedError("Native libSQL getMany across table allowlist entries");
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

  private async runQuery<T>(query: StructuredQuery<T>, context: RequestContext): Promise<QueryPage<T>> {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) {
      throw new UnsupportedError("Native libSQL collection-group or nested-collection queries");
    }
    const table = this.#tables[query.source.name];
    if (table === undefined) throw new UnsupportedError(`Native libSQL collection is not allowlisted: ${query.source.name}`);
    for (const key of ["projection", "select", "columns", "fields"]) {
      if (Object.hasOwn(query, key)) throw new UnsupportedError("Native libSQL query projection");
    }
    if (query.offset !== undefined) throw new UnsupportedError("Native libSQL query offsets");
    if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
      throw new UnsupportedError("Native libSQL inclusive or end cursors");
    }
    const limit = query.limit ?? this.#maxQueryLimit;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Native libSQL query limit must be positive");
    if (limit > this.#maxQueryLimit) throw new UnsupportedError(`Native libSQL query above maxQueryLimit (${String(this.#maxQueryLimit)})`);
    // Unordered native pages get the same honest deterministic key order that
    // the cursor continuation compiles, so every non-empty page is resumable.
    const ordered: StructuredQuery<T> = query.orders.length === 0
      ? { ...query, orders: [{ field: DOCUMENT_ID, direction: "asc" }] }
      : query;
    const base: StructuredQuery<T> = { source: query.source, filters: query.filters, orders: ordered.orders, limit };
    const baseCompiled = compileNativeLibSQLQuery(table, base, limit, this.#maxCursorBytes);
    const fingerprint = this.fingerprint(table, ordered, baseCompiled, limit);
    let stored: PreviewCursor | undefined;
    let token: string | undefined;
    let observed: Record<string, string> | undefined;
    if (query.startAfter !== undefined) {
      if (query.startAfter.values.length !== 1) throw new TypeError("Native libSQL query cursor must contain exactly one adapter handle");
      const value = query.startAfter.values[0];
      if (typeof value !== "string") throw new LibSQLCursorError("malformed");
      token = value;
      stored = this.#cursors.reserve(token, fingerprint);
      if (stored.page < 1 || stored.page >= this.#maxQueryPages) {
        this.#cursors.release(token);
        throw new UnsupportedError(`Native libSQL query cursor page above maxQueryPages (${String(this.#maxQueryPages)})`);
      }
    }
    const nextPage = stored === undefined ? 1 : stored.page + 1;
    const continuation = stored === undefined
      ? undefined
      : compileNativeLibSQLQuery(table, { ...base, startAfter: { values: stored.values } }, limit, this.#maxCursorBytes);
    let committed = false;
    try {
      const outcome = await this.#transport.pipeline(
        [{ sql: (continuation ?? baseCompiled).sql, args: (continuation ?? baseCompiled).args, wantRows: true }],
        context,
        (headers) => {
          observed = headers;
          if (stored !== undefined && this.scopeFor(headers) !== stored.scope) throw new LibSQLCursorError("changed-query");
        },
      );
      if (stored !== undefined && token !== undefined) {
        this.#cursors.commit(token);
        committed = true;
      }
      const first = outcome.outcomes[0];
      if (first === undefined) throw new TypeError("Native libSQL statement outcome missing");
      const result = requireStatement(first);
      const rows = decodeRows(result, ["__dalgo_key", ...Object.keys(table.columns)], limit, "native select");
      const records = rows.map((row) => this.record(query.source.name, row, query.source.codec));
      this.assertDistinctKeys(records);
      if (observed === undefined) throw new TypeError("Native libSQL request headers were not observed");
      if (rows.length === 0) return { records };
      const scope = stored?.scope ?? this.scopeFor(observed);
      const last = rows[rows.length - 1];
      // Positions are checked against this instance's cursor budget BEFORE a
      // handle exists, so a published native cursor is always consumable.
      const values = baseCompiled.orders.map((order) => this.cursorPosition(table, last, order.column));
      const issued = this.#cursors.issue({ query: fingerprint, scope }, nextPage, values);
      return { records, nextCursor: { values: [issued] } };
    } catch (error) {
      if (!committed && token !== undefined) this.#cursors.release(token);
      throw error;
    }
  }

  private fingerprint<T>(table: NativeLibSQLTable, query: StructuredQuery<T>, compiled: CompiledNativeLibSQLQuery, limit: number): string {
    return this.#cursors.binding({
      adapter: LIBSQL_CURSOR_ADAPTER,
      version: LIBSQL_CURSOR_VERSION,
      endpoint: this.#transport.origin,
      collection: query.source.name,
      table: table.table,
      keyColumn: table.key.column,
      keyType: table.key.type,
      filters: query.filters.map((filter) => [String(filter.field), filter.operator, filter.value]),
      orders: compiled.orders.map((order) => [order.column, order.direction]),
      limit,
    });
  }

  private scopeFor(headers: Readonly<Record<string, string>>): string {
    if (this.#identityScope !== undefined) return this.#cursors.scope(`explicit:${this.#identityScope}`);
    const entries = Object.entries(headers).map(([name, value]) => `${name.toLowerCase()}:${value}`).sort();
    return this.#cursors.scope(`headers:${libSQLCanonicalJson(entries)}`);
  }

  private cursorPosition(table: NativeLibSQLTable, row: Readonly<Record<string, LibSQLScalar>> | undefined, column: string): LibSQLCursorScalar {
    if (row === undefined) throw new Error("Native libSQL cursor row missing");
    const value = column === table.key.column ? row.__dalgo_key : row[this.fieldForColumn(table, column)];
    if (value === undefined) throw new TypeError("Native libSQL cursor column is not projected");
    if (column === table.key.column) libSQLNativeKey(value, table.key.type, "cursor");
    return libSQLCursorPosition(value, this.#maxCursorBytes, "native");
  }

  private assertDistinctKeys<T>(records: readonly ExistingRecord<T>[]): void {
    const seen = new Set<string | number>();
    for (const record of records) {
      if (seen.has(record.key.id)) throw new UnsupportedError("Native libSQL query returned duplicate record keys");
      seen.add(record.key.id);
    }
  }

  private fieldForColumn(table: NativeLibSQLTable, column: string): string {
    for (const [field, mapped] of Object.entries(table.columns)) if (mapped.column === column) return field;
    throw new Error("Native libSQL cursor column is not mapped");
  }

  private record<T>(collection: string, row: Readonly<Record<string, LibSQLScalar>>, codec?: Codec<T>): ExistingRecord<T> {
    const id = rowKey(row);
    const table = this.#tables[collection];
    if (table === undefined) throw new Error("Native libSQL table mapping disappeared");
    libSQLNativeKey(id, table.key.type, "result");
    const data = { ...row };
    delete data.__dalgo_key;
    return {
      key: new Key(collection, id),
      exists: true,
      data: identityOr(codec).decode(data),
      metadata: { id },
    };
  }

  private async select(
    compiled: CompiledNativeLibSQLQuery,
    table: NativeLibSQLTable,
    maximumRows: number,
    context: RequestContext,
  ): Promise<{ readonly rows: readonly Record<string, LibSQLScalar>[]; readonly bytes: number }> {
    const outcome = await this.#transport.pipeline([{ sql: compiled.sql, args: compiled.args, wantRows: true }], context);
    const first = outcome.outcomes[0];
    if (first === undefined) throw new TypeError("Native libSQL statement outcome missing");
    const result = requireStatement(first);
    const rows = decodeRows(result, ["__dalgo_key", ...Object.keys(table.columns)], maximumRows, "native select");
    for (const row of rows) libSQLNativeKey(row.__dalgo_key, table.key.type, "result");
    return { rows, bytes: outcome.bytes };
  }
}
