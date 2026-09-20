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
} from "@dal-go/dalgo";
import { compileBigQueryQuery, parameter, quoteTable, validateIdentifier, validateProjectId, type BigQueryParameter } from "./sql.js";
import type { BigQueryColumn, BigQueryDatabaseOptions, BigQueryQueryMetadata, BigQueryTable } from "./types.js";

interface BigQueryField {
  readonly name: string;
  readonly type?: string;
}

interface BigQueryCell {
  readonly v: unknown;
}

interface BigQueryRow {
  readonly f: readonly BigQueryCell[];
}

interface BigQueryResult {
  readonly jobComplete?: boolean;
  readonly jobReference?: { readonly jobId?: string; readonly location?: string };
  readonly schema?: { readonly fields?: readonly BigQueryField[] };
  readonly rows?: readonly BigQueryRow[];
  readonly pageToken?: string;
  readonly totalBytesProcessed?: string;
  readonly totalBytesBilled?: string;
  readonly cacheHit?: boolean;
  readonly errors?: readonly unknown[];
}

interface BigQueryJobReference {
  readonly jobId: string;
  readonly location?: string;
}

interface QueryRun {
  readonly result: BigQueryResult;
  readonly metadata: BigQueryQueryMetadata;
  readonly reference?: BigQueryJobReference;
  readonly deadline: number;
}

const apiBase = "https://bigquery.googleapis.com/bigquery/v2";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asResult(value: unknown, context: string): BigQueryResult {
  if (!isObject(value)) throw new TypeError(`malformed BigQuery ${context} response`);
  if (value.jobComplete !== undefined && typeof value.jobComplete !== "boolean") {
    throw new TypeError(`malformed BigQuery ${context} jobComplete`);
  }
  if (value.rows !== undefined && !Array.isArray(value.rows)) throw new TypeError(`malformed BigQuery ${context} rows`);
  if (value.pageToken !== undefined && typeof value.pageToken !== "string") throw new TypeError(`malformed BigQuery ${context} pageToken`);
  if (value.errors !== undefined && !Array.isArray(value.errors)) throw new TypeError(`malformed BigQuery ${context} errors`);
  return value as unknown as BigQueryResult;
}

function identityOr<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function exactPositiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return result;
}

function optionalBytes(value: BigQueryDatabaseOptions["maximumBytesBilled"]): string | undefined {
  if (value === undefined) return undefined;
  const asString = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^\d+$/u.test(asString)) throw new TypeError("maximumBytesBilled must be a non-negative integer");
  return asString;
}

function metadata(result: BigQueryResult): BigQueryQueryMetadata {
  return {
    ...(result.jobReference?.jobId === undefined ? {} : { jobId: result.jobReference.jobId }),
    ...(result.totalBytesProcessed === undefined ? {} : { totalBytesProcessed: result.totalBytesProcessed }),
    ...(result.totalBytesBilled === undefined ? {} : { totalBytesBilled: result.totalBytesBilled }),
    ...(result.cacheHit === undefined ? {} : { cacheHit: result.cacheHit }),
  };
}

function schemaTypeMatches(expected: BigQueryColumn, actual: string | undefined): boolean {
  const normalized = actual?.toUpperCase();
  if (expected.type === "BOOL") return normalized === "BOOL" || normalized === "BOOLEAN";
  if (expected.type === "INT64") return normalized === "INT64" || normalized === "INTEGER";
  if (expected.type === "FLOAT64") return normalized === "FLOAT64" || normalized === "FLOAT";
  return normalized === expected.type;
}

function rowsFrom(result: BigQueryResult, context: string, table: BigQueryTable): readonly Record<string, unknown>[] {
  const fields = result.schema?.fields;
  if (!Array.isArray(fields)) throw new TypeError(`BigQuery ${context} response omitted result schema`);
  const expected = [
    { name: "__dalgo_key", column: table.keyColumn },
    ...Object.entries(table.columns).map(([name, column]) => ({ name, column })),
  ];
  if (fields.length !== expected.length) throw new TypeError(`malformed BigQuery ${context} projection`);
  const names = new Set<string>();
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const expectedField = expected[index];
    if (field === undefined || expectedField === undefined || typeof field.name !== "string" || names.has(field.name)
      || field.name !== expectedField.name || !schemaTypeMatches(expectedField.column, field.type)) {
      throw new TypeError(`malformed BigQuery ${context} schema`);
    }
    names.add(field.name);
  }
  const rows = result.rows ?? [];
  return rows.map((row, rowIndex) => {
    if (!isObject(row) || !Array.isArray(row.f) || row.f.length !== fields.length) {
      throw new TypeError(`malformed BigQuery ${context} row ${String(rowIndex)}`);
    }
    const decoded: Record<string, unknown> = {};
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index];
      const cell = row.f[index];
      if (field === undefined || cell === undefined || !isObject(cell) || !("v" in cell)) {
        throw new TypeError(`malformed BigQuery ${context} cell ${String(index)}`);
      }
      // Deliberately preserve BigQuery's JSON wire value (for example INT64 stays a string).
      decoded[field.name] = cell.v;
    }
    return decoded;
  });
}

function keyWireValue(row: Readonly<Record<string, unknown>>): string {
  const value = row.__dalgo_key;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError("BigQuery key column must produce a string or number wire value");
  }
  return String(value);
}

function recordData(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const data = { ...row };
  delete data.__dalgo_key;
  return data;
}

function assertNoParent(key: Key): void {
  if (key.parent !== undefined) throw new UnsupportedError("BigQuery nested collection keys");
}

function validateTable(table: BigQueryTable): void {
  validateIdentifier(table.datasetId, "datasetId");
  validateIdentifier(table.tableId, "tableId");
  validateIdentifier(table.keyColumn.column, "key column");
  const columns = new Set<string>([table.keyColumn.column]);
  for (const [field, column] of Object.entries(table.columns)) {
    if (field === "__dalgo_key") throw new TypeError("__dalgo_key is reserved by the BigQuery adapter");
    validateIdentifier(field, "mapped field");
    validateIdentifier(column.column, "mapped column");
    if (columns.has(column.column)) throw new TypeError(`duplicate BigQuery mapped column: ${column.column}`);
    columns.add(column.column);
  }
}

function frozenColumn(column: BigQueryColumn): BigQueryColumn {
  return Object.freeze({ column: column.column, type: column.type, ...(column.nullable === undefined ? {} : { nullable: column.nullable }) });
}

function frozenTables(tables: Readonly<Record<string, BigQueryTable>>): Readonly<Record<string, BigQueryTable>> {
  const copy: Record<string, BigQueryTable> = {};
  for (const [collection, table] of Object.entries(tables)) {
    validateIdentifier(collection, "collection name");
    validateTable(table);
    const columns: Record<string, BigQueryColumn> = {};
    for (const [field, column] of Object.entries(table.columns)) columns[field] = frozenColumn(column);
    copy[collection] = Object.freeze({
      datasetId: table.datasetId,
      tableId: table.tableId,
      keyColumn: frozenColumn(table.keyColumn),
      columns: Object.freeze(columns),
    });
  }
  return Object.freeze(copy);
}

export class BigQueryHttpError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super(`BigQuery request failed with HTTP ${String(status)}`);
    this.name = "BigQueryHttpError";
    this.status = status;
  }
}

/** A completed BigQuery job reported a failure. The API error body is intentionally not retained. */
/**
 * DALgo adapter over BigQuery's REST jobs.query and jobs.getQueryResults APIs.
 * It intentionally never accepts a service-account key or embeds access tokens.
 */
export class BigQueryDatabase implements Database {
  readonly #projectId: string;
  readonly #tables: Readonly<Record<string, BigQueryTable>>;
  readonly #accessToken: BigQueryDatabaseOptions["accessToken"];
  readonly #location: string | undefined;
  readonly #maximumBytesBilled: string | undefined;
  readonly #maxRows: number;
  readonly #pageSize: number;
  readonly #timeoutMs: number;
  readonly #initialWaitMs: number;
  readonly #fetch: NonNullable<BigQueryDatabaseOptions["fetch"]>;

  public constructor(options: BigQueryDatabaseOptions) {
    validateProjectId(options.projectId);
    if (typeof options.accessToken !== "function") throw new TypeError("accessToken must be a function returning an OAuth token");
    if (options.location !== undefined && options.location.trim().length === 0) throw new TypeError("location must not be empty");
    this.#projectId = options.projectId;
    this.#tables = frozenTables(options.tables);
    this.#accessToken = options.accessToken;
    this.#location = options.location;
    this.#maximumBytesBilled = optionalBytes(options.maximumBytesBilled);
    this.#maxRows = exactPositiveInteger(options.maxRows, 1000, "maxRows");
    this.#pageSize = exactPositiveInteger(options.pageSize, 500, "pageSize");
    this.#timeoutMs = exactPositiveInteger(options.timeoutMs, 30_000, "timeoutMs");
    this.#initialWaitMs = exactPositiveInteger(options.initialWaitMs, 1000, "initialWaitMs");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const table = this.tableFor(key);
    const query = this.selectForTable(table, `WHERE t.\`${table.keyColumn.column}\` = @key LIMIT 2`, [parameter("key", table.keyColumn, key.id)]);
    const run = await this.runQuery(query, this.#pageSize);
    const rows = await this.allRows(run, table);
    if (rows.length === 0) return { key, exists: false };
    if (rows.length !== 1) throw new UnsupportedError("BigQuery key mapping returned more than one row");
    const row = rows[0];
    if (row === undefined) throw new Error("BigQuery query lost its only row");
    if (keyWireValue(row) !== String(key.id)) throw new TypeError("BigQuery point read returned a different key");
    return this.snapshot(key, row, codec, run.metadata);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length === 0) return [];
    if (keys.length > this.#maxRows) throw new UnsupportedError(`BigQuery getMany above configured maxRows (${String(this.#maxRows)})`);
    const firstKey = keys[0];
    if (firstKey === undefined) throw new Error("BigQuery getMany lost its first key");
    const table = this.tableFor(firstKey);
    for (const key of keys) {
      if (this.tableFor(key) !== table) throw new UnsupportedError("BigQuery getMany across different table mappings");
    }
    const values = keys.map((key) => key.id);
    const arrayParameter: BigQueryParameter = {
      name: "keys",
      parameterType: { type: "ARRAY", arrayType: { type: table.keyColumn.type } },
      parameterValue: { arrayValues: values.map((value) => parameter("value", table.keyColumn, value).parameterValue) },
    };
    const query = this.selectForTable(table, `WHERE t.\`${table.keyColumn.column}\` IN UNNEST(@keys) LIMIT ${String(this.#maxRows + 1)}`, [arrayParameter]);
    const run = await this.runQuery(query, Math.min(this.#pageSize, keys.length));
    const rows = await this.allRows(run, table);
    if (rows.length > keys.length) throw new UnsupportedError("BigQuery key mapping returned duplicate rows");
    const returnedKeys = rows.map((row) => keyWireValue(row));
    if (new Set(returnedKeys).size !== returnedKeys.length) {
      throw new UnsupportedError("BigQuery key mapping returned duplicate rows");
    }
    const returned = new Map(rows.map((row) => [keyWireValue(row), row]));
    const requestedKeys = new Set(keys.map((key) => String(key.id)));
    if (returnedKeys.some((key) => !requestedKeys.has(key))) throw new TypeError("BigQuery getMany returned an unrequested key");
    return keys.map((key) => {
      const row = returned.get(String(key.id));
      return row === undefined ? { key, exists: false } : this.snapshot(key, row, codec, run.metadata);
    });
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) {
      throw new UnsupportedError("BigQuery collection-group or nested collection queries");
    }
    const table = this.tableForCollection(query.source.name);
    if ((query.offset ?? 0) !== 0) throw new UnsupportedError("BigQuery offset queries");
    const requested = query.limit ?? this.#maxRows;
    if (requested > this.#maxRows) throw new UnsupportedError(`BigQuery query limit above configured maxRows (${String(this.#maxRows)})`);
    const compiled = compileBigQueryQuery(this.#projectId, table, query, requested + 1);
    const run = await this.runQuery({ sql: compiled.sql, parameters: compiled.parameters }, Math.min(this.#pageSize, requested + 1));
    const rows = await this.allRows(run, table);
    const hasMore = rows.length > requested;
    const selected = rows.slice(0, requested);
    const records = selected.map((row): ExistingRecord<T> => {
      const key = new Key(query.source.name, keyWireValue(row));
      return this.snapshot(key, row, query.source.codec, run.metadata) as ExistingRecord<T>;
    });
    const last = selected.at(-1);
    const nextCursor = hasMore && last !== undefined && query.orders.length > 0
      ? { values: compiled.cursorColumns.map((column) => last[column.column === table.keyColumn.column ? "__dalgo_key" : this.fieldForColumn(table, column.column)]) }
      : undefined;
    if (nextCursor?.values.some((value) => value === null || value === undefined)) {
      throw new UnsupportedError("BigQuery pagination over null cursor values");
    }
    return { records, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  /** BigQuery cannot atomically enforce a unique key, so DALgo insert is rejected. */
  public insert<T>(_key: Key, _data: T, _codec?: Codec<T>): Promise<void> {
    void [_key, _data, _codec];
    return Promise.reject(new UnsupportedError("BigQuery insert without an enforced unique-key constraint"));
  }

  /** BigQuery MERGE cannot prove DALgo replacement semantics for non-unique keys. */
  public set<T>(_key: Key, _data: T, _codec?: Codec<T>): Promise<void> {
    void [_key, _data, _codec];
    return Promise.reject(new UnsupportedError("BigQuery set/upsert without an enforced unique-key constraint"));
  }

  public update(_key: Key, _data: Readonly<Record<string, unknown>>): Promise<void> {
    void [_key, _data];
    return Promise.reject(new UnsupportedError("BigQuery update without an atomically enforced unique-key constraint"));
  }

  public delete(_key: Key): Promise<void> {
    void _key;
    return Promise.reject(new UnsupportedError("BigQuery delete without an atomically enforced unique-key constraint"));
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    if (typeof callback !== "function") return Promise.reject(new TypeError("transaction callback is required"));
    return Promise.reject(new UnsupportedError("BigQuery callback transactions"));
  }

  private tableFor(key: Key): BigQueryTable {
    assertNoParent(key);
    return this.tableForCollection(key.collection);
  }

  private tableForCollection(collection: string): BigQueryTable {
    const table = this.#tables[collection];
    if (table === undefined) throw new UnsupportedError(`BigQuery collection has no table mapping: ${collection}`);
    return table;
  }

  private fieldForColumn(table: BigQueryTable, column: string): string {
    const field = Object.entries(table.columns).find(([, mapped]) => mapped.column === column)?.[0];
    if (field === undefined) throw new TypeError(`BigQuery cursor column is not mapped: ${column}`);
    return field;
  }

  private selectForTable(table: BigQueryTable, suffix: string, parameters: readonly BigQueryParameter[]): { readonly sql: string; readonly parameters: readonly BigQueryParameter[] } {
    const columns = [
      `t.\`${table.keyColumn.column}\` AS \`__dalgo_key\``,
      ...Object.entries(table.columns).map(([field, column]) => `t.\`${column.column}\` AS \`${field}\``),
    ];
    return { sql: `SELECT ${columns.join(", ")} FROM ${quoteTable(this.#projectId, table)} AS t ${suffix}`, parameters };
  }

  private snapshot<T>(key: Key, row: Readonly<Record<string, unknown>>, codec: Codec<T> | undefined, queryMetadata: BigQueryQueryMetadata): RecordSnapshot<T> {
    return { key, exists: true, data: identityOr(codec).decode(recordData(row)), metadata: { ...queryMetadata } };
  }


  private async runQuery(query: { readonly sql: string; readonly parameters: readonly BigQueryParameter[] }, maxResults: number): Promise<QueryRun> {
    const deadline = Date.now() + this.#timeoutMs;
    const first = asResult(await this.request("POST", `/projects/${encodeURIComponent(this.#projectId)}/queries`, {
      query: query.sql,
      useLegacySql: false,
      parameterMode: "NAMED",
      queryParameters: query.parameters,
      timeoutMs: Math.min(this.#initialWaitMs, this.#timeoutMs),
      jobTimeoutMs: String(this.#timeoutMs),
      maxResults,
      ...(this.#location === undefined ? {} : { location: this.#location }),
      ...(this.#maximumBytesBilled === undefined ? {} : { maximumBytesBilled: this.#maximumBytesBilled }),
    }, deadline), "jobs.query");
    if (first.jobComplete === true) {
      const reference = first.jobReference?.jobId === undefined ? undefined : { jobId: first.jobReference.jobId, ...(first.jobReference.location === undefined ? {} : { location: first.jobReference.location }) };
      return { result: first, metadata: metadata(first), deadline, ...(reference === undefined ? {} : { reference }) };
    }
    const reference = first.jobReference;
    if (reference?.jobId === undefined) throw new TypeError("BigQuery unfinished query omitted job reference");
    let delay = 100;
    let result = first;
    while (result.jobComplete !== true) {
      if (Date.now() >= deadline) throw new UnsupportedError("BigQuery query exceeded configured polling timeout");
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
      delay = Math.min(delay * 2, 1000);
      const params = new URLSearchParams({ maxResults: String(maxResults) });
      const location = reference.location ?? this.#location;
      if (location !== undefined) params.set("location", location);
      result = asResult(await this.request("GET", `/projects/${encodeURIComponent(this.#projectId)}/queries/${encodeURIComponent(reference.jobId)}?${params.toString()}`, undefined, deadline), "jobs.getQueryResults");
    }
    return {
      result,
      metadata: { ...metadata(result), jobId: reference.jobId },
      deadline,
      reference: { jobId: reference.jobId, ...(reference.location === undefined ? {} : { location: reference.location }) },
    };
  }

  private async allRows(run: QueryRun, table: BigQueryTable): Promise<readonly Record<string, unknown>[]> {
    const rows = [...rowsFrom(run.result, "query", table)];
    let pageToken = run.result.pageToken === "" ? undefined : run.result.pageToken;
    const reference = run.reference;
    const seenTokens = new Set<string>();
    while (pageToken !== undefined && rows.length < this.#maxRows + 1) {
      if (reference === undefined) throw new TypeError("BigQuery paged response omitted job reference");
      if (seenTokens.has(pageToken)) throw new TypeError("BigQuery result paging repeated a page token");
      seenTokens.add(pageToken);
      const params = new URLSearchParams({ pageToken, maxResults: String(this.#pageSize) });
      const location = reference.location ?? this.#location;
      if (location !== undefined) params.set("location", location);
      const page = asResult(await this.request("GET", `/projects/${encodeURIComponent(this.#projectId)}/queries/${encodeURIComponent(reference.jobId)}?${params.toString()}`, undefined, run.deadline), "jobs.getQueryResults page");
      if (page.jobComplete !== true) throw new TypeError("BigQuery result page was not complete");
      rows.push(...rowsFrom(page, "query page", table));
      pageToken = page.pageToken === "" ? undefined : page.pageToken;
    }
    return rows;
  }

  private async request(method: "GET" | "POST", path: string, body: unknown | undefined, deadline: number): Promise<unknown> {
    const token = await this.withDeadline(Promise.resolve().then(this.#accessToken), deadline, "BigQuery access token provider failed");
    if (typeof token !== "string" || token.trim().length === 0) throw new TypeError("accessToken must return a non-empty OAuth token");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new UnsupportedError("BigQuery operation exceeded configured timeout");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      let response: Response;
      try {
        response = await this.withDeadline(this.#fetch(`${apiBase}${path}`, {
          method,
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }), deadline, "BigQuery request failed");
      } catch {
        throw new Error("BigQuery request failed");
      }
      let text: string;
      try {
        text = await this.withDeadline(response.text(), deadline, "BigQuery response could not be read");
      } catch {
        throw new Error("BigQuery response could not be read");
      }
      if (!response.ok) throw new BigQueryHttpError(response.status);
      if (text.length === 0) throw new TypeError("BigQuery response was unexpectedly empty");
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new TypeError("BigQuery response was not JSON");
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async withDeadline<T>(promise: Promise<T>, deadline: number, failureMessage: string): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new UnsupportedError("BigQuery operation exceeded configured timeout");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new UnsupportedError("BigQuery operation exceeded configured timeout")), remaining);
      void promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        () => { clearTimeout(timer); reject(new Error(failureMessage)); },
      );
    });
  }
}
