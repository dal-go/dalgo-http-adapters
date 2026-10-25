import { Key, UnsupportedError, identityCodec, type Codec, type ExistingRecord, type QueryPage, type QueryExecutor, type QueryRelation, type ReadSession, type RecordSnapshot, type StructuredQuery } from "@dalgo/core";
import { compileD1Query, validateIdentifier } from "./sql.js";
import type { D1Binding, D1DatabaseOptions, D1PreparedStatement, D1Table } from "./types.js";

const defaultQueryLimit = 100;
const defaultGetManyKeys = 100;

function positive(value: number | undefined, fallback: number, field: string, max = 10_000): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new TypeError(`${field} must be a safe integer from 1 to ${String(max)}`);
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identityOr<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }

export function validateD1Schema(tables: D1DatabaseOptions["tables"]): Readonly<Record<string, D1Table>> {
  const result: Record<string, D1Table> = Object.create(null) as Record<string, D1Table>;
  const names = Object.keys(tables);
  if (names.length === 0) throw new TypeError("D1 tables must declare at least one collection");
  for (const collection of Object.keys(tables)) {
    const table = Object.hasOwn(tables, collection) ? tables[collection] : undefined;
    if (table === undefined) throw new TypeError(`D1 table configuration disappeared: ${collection}`);
    validateIdentifier(collection, "collection name");
    if (collection.includes("/")) throw new TypeError("D1 collection names must be a single DALgo path segment");
    validateIdentifier(table.table, "table name");
    if (!Array.isArray(table.primaryKey)) throw new TypeError(`D1 primaryKey must be an array for ${collection}`);
    const fields = Object.keys(table.columns);
    if (fields.length === 0) throw new TypeError(`D1 table ${collection} must declare at least one field`);
    const physical = new Set<string>();
    const columns: Record<string, { readonly column: string }> = {};
    for (const [field, column] of Object.entries(table.columns)) {
      validateIdentifier(field, "field name");
      if (field === "__name__") throw new TypeError("D1 field name __name__ is reserved for DOCUMENT_ID");
      validateIdentifier(column.column, "column name");
      if (physical.has(column.column)) throw new TypeError(`duplicate D1 physical column mapping: ${column.column}`);
      physical.add(column.column);
      columns[field] = Object.freeze({ column: column.column });
    }
    const rawPrimaryKey: readonly unknown[] = table.primaryKey;
    const primaryKey: string[] = [];
    for (const field of rawPrimaryKey) {
      if (typeof field !== "string") throw new TypeError(`D1 primaryKey fields must be strings for ${collection}`);
      primaryKey.push(field);
    }
    if (new Set<string>(primaryKey).size !== primaryKey.length || primaryKey.some((field: string) => !Object.hasOwn(columns, field))) {
      throw new TypeError(`D1 primaryKey fields must be unique declared fields for ${collection}`);
    }
    result[collection] = Object.freeze({ table: table.table, columns: Object.freeze(columns), primaryKey: Object.freeze(primaryKey) });
  }
  return Object.freeze(result);
}

function dbRows<T>(result: { readonly results?: readonly T[]; readonly success?: boolean }): readonly T[] {
  if (result.success === false || !Array.isArray(result.results)) throw new Error("D1 query failed");
  return result.results as readonly T[];
}

/** Converts the D1 binding API's Array.from()-encoded BLOB reads to byte views. */
export function normalizeD1Row(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const normalized: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(row)) {
    if (!Array.isArray(value)) {
      normalized[field] = value;
      continue;
    }
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const byte: unknown = value[index];
      if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error("D1 returned an invalid BLOB byte array");
      bytes[index] = byte;
    }
    normalized[field] = bytes;
  }
  return normalized;
}

function bind(statement: D1PreparedStatement, values: readonly (string | number | null | ArrayBuffer | ArrayBufferView)[]): D1PreparedStatement {
  return values.length === 0 ? statement : statement.bind(...values);
}

function pkValues(table: D1Table, row: Readonly<Record<string, unknown>>): readonly unknown[] {
  return table.primaryKey.map((field) => row[field]);
}

function keyId(values: readonly unknown[], collection: string): string | number {
  if (values.length === 1) {
    const value = values[0];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    throw new UnsupportedError(`D1 primary key for ${collection} must contain a non-empty string or safe integer`);
  }
  if (values.length === 0) throw new UnsupportedError(`D1 collection ${collection} has no primary key`);
  for (const value of values) {
    if (value === null || value === undefined || (typeof value !== "string" && typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))))) {
      throw new UnsupportedError(`D1 composite key for ${collection} contains an unsupported value`);
    }
  }
  return JSON.stringify(values);
}

function valuesForKey(table: D1Table, key: Key): readonly unknown[] {
  if (table.primaryKey.length === 0) throw new UnsupportedError(`D1 collection ${key.collection} has no primary key`);
  if (table.primaryKey.length === 1) return [key.id];
  if (typeof key.id !== "string") throw new UnsupportedError(`D1 composite key for ${key.collection} must use its JSON-array string form`);
  let parsed: unknown;
  try { parsed = JSON.parse(key.id) as unknown; } catch { throw new TypeError(`invalid D1 composite key for ${key.collection}`); }
  if (!Array.isArray(parsed) || parsed.length !== table.primaryKey.length) throw new TypeError(`invalid D1 composite key for ${key.collection}`);
  if (parsed.some((value) => value === null || value === undefined || (typeof value !== "string" && typeof value !== "boolean" &&
    !(typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)))))) throw new TypeError(`invalid D1 composite key for ${key.collection}`);
  return parsed;
}

function rowData<T>(table: D1Table, row: Readonly<Record<string, unknown>>, codec?: Codec<T>, includePrimaryKey = false): T {
  const data = Object.fromEntries(Object.entries(row).filter(([field]) => includePrimaryKey || !table.primaryKey.includes(field)));
  return identityOr(codec).decode(data);
}

/** Read-only DALgo executor backed by the Cloudflare Workers D1 binding API. */
export class D1QueryDatabase implements QueryExecutor, ReadSession {
  readonly #db: D1Binding;
  readonly #tables: Readonly<Record<string, D1Table>>;
  readonly #maxQueryLimit: number;
  readonly #maxGetManyKeys: number;
  readonly #maxScanRows: number;
  readonly #scanPageSize: number;

  public constructor(db: D1Binding, options: D1DatabaseOptions) {
    this.#db = db;
    this.#tables = validateD1Schema(options.tables);
    this.#maxQueryLimit = positive(options.maxQueryLimit, defaultQueryLimit, "maxQueryLimit", 1_000);
    this.#maxGetManyKeys = positive(options.maxGetManyKeys, defaultGetManyKeys, "maxGetManyKeys", 1_000);
    this.#maxScanRows = positive(options.maxScanRows, 10_000, "maxScanRows", 100_000);
    this.#scanPageSize = positive(options.scanPageSize, Math.min(500, this.#maxQueryLimit), "scanPageSize", this.#maxQueryLimit);
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    this.tableFor(query.source.name);
    if (query.limit !== undefined) {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > this.#maxScanRows + 1) throw new UnsupportedError(`D1 query limit above ${String(this.#maxScanRows + 1)}`);
      if (query.limit <= this.#maxQueryLimit) return this.readPage(query, query.limit, query.offset ?? 0);
    }
    const records: ExistingRecord<T>[] = [];
    for await (const page of this.scanPages({ name: query.source.name, joins: [] }, query)) {
      records.push(...page.records);
      if (records.length > this.#maxScanRows) throw new RangeError(`D1 scan exceeds maxScanRows ${String(this.#maxScanRows)}`);
    }
    return { records };
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    if (key.parent !== undefined) throw new UnsupportedError("D1 nested keys");
    const table = this.tableFor(key.collection);
    const values = valuesForKey(table, key);
    const filters = table.primaryKey.map((field, index) => ({ field, operator: "==" as const, value: values[index] }));
    const query: StructuredQuery<Record<string, unknown>> = {
      source: { kind: "collection", name: key.collection }, filters, orders: [], limit: 2,
    };
    const compiled = compileD1Query(table, query, 2);
    const rows = dbRows(await bind(this.#db.prepare(compiled.sql), compiled.args).all());
    if (rows.length > 1) throw new Error("D1 primary key query returned duplicate rows");
    const row = rows[0];
    if (row === undefined) return { key, exists: false };
    return { key, exists: true, data: rowData(table, normalizeD1Row(row), codec) };
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#maxGetManyKeys) throw new UnsupportedError(`D1 getMany above ${String(this.#maxGetManyKeys)} keys`);
    return Promise.all(keys.map((key) => this.get(key, codec)));
  }

  /** Pages a full leaf scan for DALgo's streaming joined-query executor. */
  public async *scanPages<T>(_relation: QueryRelation, query: StructuredQuery<T>): AsyncIterable<QueryPage<T>> {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("D1 nested or collection-group queries");
    const table = this.tableFor(query.source.name);
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > this.#maxScanRows + 1)) {
      throw new UnsupportedError(`D1 scan limit above ${String(this.#maxScanRows + 1)}`);
    }
    const sourceOffset = query.offset ?? 0;
    const requested = query.limit;
    const budget = requested ?? this.#maxScanRows;
    const pageSize = Math.min(this.#scanPageSize, budget);
    let collected = 0;
    let offset = sourceOffset;
    for (;;) {
      const remaining = budget - collected;
      const limit = Math.min(pageSize, requested === undefined ? remaining + 1 : remaining);
      const pageQuery: StructuredQuery<T> = {
        ...query,
        orders: query.orders.length === 0 && table.primaryKey.length > 0
          ? table.primaryKey.map((field) => ({ field, direction: "asc" as const }))
          : query.orders,
        limit,
        offset,
      };
      const page = await this.readPage(pageQuery, limit, offset);
      if (page.records.length > remaining) throw new RangeError(`D1 scan exceeds maxScanRows ${String(this.#maxScanRows)}`);
      if (page.records.length === 0) return;
      yield page;
      collected += page.records.length;
      offset += page.records.length;
      if (requested !== undefined && collected >= requested) return;
      if (page.records.length < limit) return;
      if (requested === undefined && collected === budget) {
        const probe = await this.readPage({ ...pageQuery, offset, limit: 1 }, 1, offset);
        if (probe.records.length > 0) throw new RangeError(`D1 scan exceeds maxScanRows ${String(this.#maxScanRows)}`);
        return;
      }
    }
  }

  private async readPage<T>(query: StructuredQuery<T>, limit: number, offset: number): Promise<QueryPage<T>> {
    const table = this.tableFor(query.source.name);
    const compiled = compileD1Query(table, query, limit);
    const raw = await bind(this.#db.prepare(compiled.sql), compiled.args).all();
    const records: ExistingRecord<T>[] = dbRows(raw).map((row, index) => {
      const normalized = normalizeD1Row(row);
      const id = table.primaryKey.length === 0 ? JSON.stringify([offset + index, normalized]) : keyId(pkValues(table, normalized), query.source.name);
      const key = new Key(query.source.name, id);
      return { key, exists: true, data: rowData(table, normalized, query.source.codec, true) };
    });
    return { records };
  }

  private tableFor(collection: string): D1Table {
    const table = Object.hasOwn(this.#tables, collection) ? this.#tables[collection] : undefined;
    if (table === undefined) throw new UnsupportedError(`D1 collection is not configured: ${collection}`);
    return table;
  }
}

export interface D1ScanPageExecutor {
  scanPages<T>(relation: QueryRelation, query: StructuredQuery<T>): AsyncIterable<QueryPage<T>>;
}

/** Exposes a D1 adapter's bounded leaf pages to DALgo's joined-query executor. */
export function scanPages<T>(executor: D1ScanPageExecutor, relation: QueryRelation, query: StructuredQuery<T>): AsyncIterable<QueryPage<T>> {
  return executor.scanPages(relation, query);
}

export function isD1Record(value: unknown): value is Readonly<Record<string, unknown>> { return isObject(value); }
