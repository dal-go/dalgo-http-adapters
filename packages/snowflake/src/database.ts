import { DOCUMENT_ID, Key, identityCodec, type Codec, type Database,
  type QueryPage, type ReadwriteTransaction, type RecordSnapshot, type StructuredQuery } from "@dalgo/core";
import { Transport, integer, type Binding, type TransportOptions } from "./transport.js";
import { failure, unsupported } from "./errors.js";
import type { Operation } from "./operation.js";

export interface SnowflakeTable {
  /** Exact, case-sensitive SQL table name within the configured database/schema. */
  readonly table: string;
  /** Unique, non-null column. Snowflake standard tables do not enforce uniqueness. */
  readonly idColumn: string;
  readonly idType?: "string" | "number";
}

export interface SnowflakeOptions extends TransportOptions {
  readonly tables: Readonly<Record<string, SnowflakeTable>>;
  readonly maxRows?: number;
}

function identifier(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) throw failure("Invalid SQL identifier");
  return `"${value.replaceAll('"', '""')}"`;
}

function binding(value: unknown): Binding {
  if (typeof value === "string") return { type: "TEXT", value };
  if (typeof value === "boolean") return { type: "BOOLEAN", value: String(value) };
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw failure("Unsafe integer query value; use a string");
    return { type: Number.isInteger(value) ? "FIXED" : "REAL", value: String(value) };
  }
  throw unsupported("Snowflake non-scalar query values");
}
/** Admit bounded data elements without invoking caller iterators or accessors. */
function copiedArray<T>(value: readonly T[], maximum: number): T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw failure("Invalid Snowflake input array");
  const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || length > maximum) throw failure("Snowflake input work budget exceeded");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== length + 1) throw failure("Invalid Snowflake input array");
  const result: T[] = [];
  for (let i = 0; i < length; i++) {
    const entry = descriptors[String(i)];
    if (entry === undefined || !Object.hasOwn(entry, "value")) throw failure("Invalid Snowflake input array");
    result.push(entry.value as T);
  }
  return result;
}

export class SnowflakeDatabase implements Database {
  readonly #transport: Transport;
  readonly #tables: ReadonlyMap<string, SnowflakeTable>;
  readonly #maxRows: number;

  public constructor(options: SnowflakeOptions) {
    identifier(options.database); identifier(options.schema);
    if (options.warehouse !== undefined) identifier(options.warehouse);
    if (options.role !== undefined) identifier(options.role);
    this.#transport = new Transport(options);
    this.#maxRows = integer(options.maxRows ?? 10_000, 2, "maxRows", 100_000);
    if (Object.keys(options.tables).length > 256) throw failure("Snowflake mapping budget exceeded");
    this.#tables = new Map(Object.entries(options.tables).map(([name, table]) => {
      identifier(table.table); identifier(table.idColumn);
      if (table.idType !== undefined && table.idType !== "string" && table.idType !== "number") throw failure("Invalid idType");
      return [name, { ...table }];
    }));
  }

  #table(name: string, parent?: Key): SnowflakeTable {
    if (parent !== undefined) throw unsupported("Snowflake parent keys");
    const table = this.#tables.get(name);
    if (!table) throw unsupported("Snowflake unmapped collection");
    return table;
  }

  #id(table: SnowflakeTable, id: unknown): string | number {
    if ((table.idType ?? "string") === "number") {
      if (typeof id !== "number" || !Number.isSafeInteger(id)) throw failure("Expected a safe integer key");
    } else if (typeof id !== "string" || !id.length) throw failure("Expected a non-empty string key");
    return id as string | number;
  }

  public close(): void { this.#transport.close(); }
  public get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> { return this.getWithSignal(key, undefined, codec); }
  public getWithSignal<T>(key: Key, signal: AbortSignal | undefined, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    return this.#transport.run(signal, async op => this.#get(op, this.#admitKey(key), codec));
  }
  #admitKey(key: Key): { key: Key; table: SnowflakeTable; id: string | number } {
    const name = key.collection; const parent = key.parent; const originalId = key.id;
    const table = this.#table(name, parent); const id = this.#id(table, originalId);
    if (typeof id === "string" && id.length > 16_384) throw failure("Snowflake key budget exceeded");
    return { key: new Key(name, id), table, id };
  }
  async #get<T>(op: Operation, admitted: { key: Key; table: SnowflakeTable; id: string | number }, codec: Codec<T> | undefined): Promise<RecordSnapshot<T>> {
    const { key, table, id } = admitted;
    const rows = await this.#transport.read(op, `SELECT * FROM ${identifier(table.table)} WHERE ${identifier(table.idColumn)} = ? LIMIT 2`, { "1": binding(id) }, 2, this.#maxRows);
    if (rows.length > 1) throw failure("Snowflake key is not unique");
    const row = rows[0];
    if (!row) return { key, exists: false };
    if (typeof row[table.idColumn] !== "string" || row[table.idColumn] !== String(id)) throw failure("Snowflake returned a mismatched key");
    const data = op.call(() => (codec ?? identityCodec).decode(row)) as T;
    return { key, exists: true, data };
  }
  public getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> { return this.getManyWithSignal(keys, undefined, codec); }
  public getManyWithSignal<T>(keys: readonly Key[], signal: AbortSignal | undefined, codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    return this.#transport.run(signal, async op => {
      const copied = copiedArray(keys, Math.min(op.limits.maxKeys, this.#maxRows));
      const admitted = copied.map(key => { op.check(); return this.#admitKey(key); });
      const result: RecordSnapshot<T>[] = [];
      for (const key of admitted) { op.check(); result.push(await this.#get(op, key, codec)); }
      return result;
    });
  }

  public query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> { return this.queryWithSignal(query, undefined); }
  public queryWithSignal<T>(query: StructuredQuery<T>, signal: AbortSignal | undefined): Promise<QueryPage<T>> {
    return this.#transport.run(signal, async op => this.#query(op, query));
  }
  async #query<T>(op: Operation, query: StructuredQuery<T>): Promise<QueryPage<T>> {
    op.check();
    const admittedFilters = copiedArray(query.filters, 64); const admittedOrders = copiedArray(query.orders, 16);
    const source = query.source;
    if (source.kind !== "collection") throw unsupported("Snowflake collection groups");
    const sourceName = source.name; const codec = source.codec ?? identityCodec;
    const table = this.#table(sourceName, source.parent);
    if ([query.startAt, query.startAfter, query.endAt, query.endBefore].some(value => value !== undefined)) {
      throw unsupported("Snowflake query cursors");
    }
    const bindings: Record<string, Binding> = {};
    const bind = (value: unknown) => { if (Object.keys(bindings).length >= 1024) throw failure("Snowflake binding budget exceeded"); bindings[String(Object.keys(bindings).length + 1)] = binding(value); return "?"; };
    const column = (field: string) => {
      if (field.includes(".")) throw unsupported("Snowflake nested field paths");
      return identifier(field === DOCUMENT_ID ? table.idColumn : field);
    };
    const idValue = (value: unknown): unknown => {
      if (value instanceof Key) {
        if (value.collection !== sourceName || value.parent) throw failure("Document key belongs to another collection");
        value = value.id;
      }
      return this.#id(table, value);
    };
    const filters = admittedFilters.map(filter => {
      const field = column(filter.field);
      let value = filter.value;
      if (filter.operator === "in" || filter.operator === "not-in") {
        if (!Array.isArray(value) || value.length === 0) throw unsupported("Snowflake empty or null-containing membership filters");
        const members = copiedArray<unknown>(value, 1000);
        if (members.some(item => item === null)) throw unsupported("Snowflake empty or null-containing membership filters");
        return `${field} ${filter.operator === "in" ? "IN" : "NOT IN"} (${members.map(item => bind(filter.field === DOCUMENT_ID ? idValue(item) : item)).join(", ")})`;
      }
      if (filter.field === DOCUMENT_ID) value = idValue(value);
      if (value === null) {
        if (filter.operator === "==") return `${field} IS NULL`;
        if (filter.operator === "!=") return `${field} IS NOT NULL`;
        throw unsupported("Snowflake ordered null comparisons");
      }
      const operators: Record<string, string> = { "==": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=" };
      if (!Object.hasOwn(operators, filter.operator)) throw unsupported("Snowflake query operator");
      return `${field} ${operators[filter.operator]} ${bind(value)}`;
    });
    const orders = admittedOrders.map(order => {
      if (order.direction !== "asc" && order.direction !== "desc") throw failure("Invalid query order direction");
      return `${column(order.field)} ${order.direction.toUpperCase()} NULLS LAST`;
    });
    if (!admittedOrders.some(order => order.field === DOCUMENT_ID || order.field === table.idColumn)) orders.push(`${identifier(table.idColumn)} ASC`);
    const limit = query.limit === undefined ? this.#maxRows + 1 : integer(query.limit, 1, "limit");
    if (query.limit !== undefined && limit > this.#maxRows) throw failure("limit exceeds maxRows");
    const offset = integer(query.offset ?? 0, 0, "offset");
    const sql = `SELECT * FROM ${identifier(table.table)}${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""} ORDER BY ${orders.join(", ")} LIMIT ${limit} OFFSET ${offset}`;
    const rows = await this.#transport.read(op, sql, bindings, this.#maxRows);
    const ids = new Set<string | number>();
    const records = rows.map(row => {
      const rawId = row[table.idColumn];
      if (rawId === null || rawId === undefined || rawId === "") throw failure("Snowflake row lacks a key");
      let id: string | number = rawId;
      if (table.idType === "number") {
        if (!/^-?\d+$/.test(rawId)) throw failure("Snowflake numeric key is not an integer");
        id = this.#id(table, Number(rawId));
      }
      if (ids.has(id)) throw failure("Snowflake key is not unique");
      ids.add(id);
      return { key: new Key(sourceName, id), exists: true as const, data: op.call(() => codec.decode(row)) as T };
    });
    return { records };
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    void callback;
    return Promise.reject(unsupported("Snowflake interactive read-write transactions"));
  }
}
