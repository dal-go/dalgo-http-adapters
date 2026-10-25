import {
  Key,
  NotFoundError,
  UnsupportedError,
  identityCodec,
  type CapabilityAware,
  type Codec,
  type Database,
  type DatabaseCapabilities,
  type ExistingRecord,
  type QueryPage,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type Resettable,
  type StructuredQuery,
  type UpdateData,
} from "@dalgo/core";
import { compileSqlQuery, quoteIdentifier, sqlValue, type SqlDialect, type SqlTable } from "@dalgo/sqlite-sql";
import type { SqliteBindValue, SqliteDriver } from "./driver.js";
import { mapSqliteError } from "./errors.js";
import { readSqliteSchema, type SqliteSchema, type SqliteTableSchema } from "./schema.js";
import type { SqliteExportOptions } from "./export.js";

/**
 * Restores the database to its initial state. It may replace the connection
 * (for example after overwriting an OPFS file) by returning the new driver.
 */
export type SqliteResetHandler = (driver: SqliteDriver) => SqliteDriver | undefined | Promise<SqliteDriver | undefined>;

export interface SqliteDatabaseOptions {
  /** Serializes the current connection as SQLite bytes, invoked after queued transactions complete. */
  readonly onExport?: (options: SqliteExportOptions) => Promise<Uint8Array>;
  /** Allow insert, set and update. Default `true`. */
  readonly write?: boolean;
  /** Allow delete. Default: the `write` value. Requires `write`. */
  readonly delete?: boolean;
  /** Whether writes survive a page reload (OPFS) rather than living in memory. Default `false`. */
  readonly persistent?: boolean;
  /** Makes the database {@link Resettable}; `reset()` calls it. */
  readonly onReset?: SqliteResetHandler;
}

const dialect: SqlDialect = { name: "SQLite", unsupported: (capability) => new UnsupportedError(capability) };

function codecOr<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer);
}

function writeValue(value: unknown): SqliteBindValue {
  return typeof value === "bigint" ? value : sqlValue(dialect, value, "record");
}

function recordId(value: unknown, table: string): string | number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string" && value.length > 0) return value;
  throw new UnsupportedError(`SQLite primary key value in ${table} must be a non-empty string or a finite number`);
}

/**
 * Query results use the single primary key value as the key id. Composite keys
 * use a JSON array of the key values (read-only), and keyless tables a JSON
 * array holding the row's ordinal in the result.
 */
function rowId(table: SqliteTableSchema, row: Readonly<Record<string, unknown>>, ordinal: number): string | number {
  const [first, ...rest] = table.primaryKey;
  if (first === undefined) return JSON.stringify([ordinal]);
  if (rest.length === 0) return recordId(row[first], table.name);
  return JSON.stringify(table.primaryKey.map((column) => {
    const value = row[column];
    return typeof value === "bigint" ? String(value) : value;
  }));
}

function mapping(table: SqliteTableSchema): SqlTable {
  return {
    table: table.name,
    columns: Object.fromEntries(table.columns.map((column) => [column.name, { column: column.name }])),
    primaryKey: table.primaryKey,
  };
}

function keyColumn(table: SqliteTableSchema): string {
  const [column, ...rest] = table.primaryKey;
  if (column === undefined) throw new UnsupportedError("table without primary key");
  if (rest.length > 0) throw new UnsupportedError("composite primary key");
  return column;
}

/** Shared operations, run either directly by a transaction or under the database's queue. */
class Engine {
  public driver: SqliteDriver;
  #schema: Promise<SqliteSchema> | undefined;

  public constructor(driver: SqliteDriver) { this.driver = driver; }

  public schema(): Promise<SqliteSchema> {
    this.#schema ??= readSqliteSchema(this.driver).catch((error: unknown) => {
      this.#schema = undefined;
      throw error;
    });
    return this.#schema;
  }

  public forgetSchema(): void { this.#schema = undefined; }

  public async table(key: Key): Promise<SqliteTableSchema> {
    if (key.parent !== undefined) throw new UnsupportedError("SQLite nested keys");
    return this.tableNamed(key.collection);
  }

  public async tableNamed(name: string): Promise<SqliteTableSchema> {
    const { tables } = await this.schema();
    const table = Object.hasOwn(tables, name) ? tables[name] : undefined;
    if (table === undefined) throw new UnsupportedError(`SQLite table is not in the database: ${name}`);
    return table;
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const table = await this.table(key);
    const column = keyColumn(table);
    const compiled = compileSqlQuery(dialect, mapping(table), {
      source: { kind: "collection", name: table.name },
      filters: [{ field: column, operator: "==", value: key.id }],
      orders: [],
    }, 1);
    const { rows } = await this.driver.exec(compiled.sql, compiled.args);
    const row = rows[0];
    return row === undefined ? { key, exists: false } : { key, exists: true, data: codecOr(codec).decode({ ...row }) };
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    const snapshots: RecordSnapshot<T>[] = [];
    for (const key of keys) snapshots.push(await this.get(key, codec));
    return snapshots;
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    const table = await this.tableNamed(query.source.name);
    const compiled = compileSqlQuery(dialect, mapping(table), query, query.limit ?? Number.MAX_SAFE_INTEGER);
    const { rows } = await this.driver.exec(compiled.sql, compiled.args);
    const offset = query.offset ?? 0;
    const records = rows.map((row, index): ExistingRecord<T> => {
      const key = new Key(table.name, rowId(table, row, offset + index));
      return { key, exists: true, data: codecOr(query.source.codec).decode({ ...row }) };
    });
    return { records };
  }

  /** Encodes a record and checks its fields against the table; the key column is always bound from `key`. */
  async #record(key: Key, data: unknown, partial: boolean): Promise<{ readonly table: SqliteTableSchema; readonly column: string; readonly values: Map<string, SqliteBindValue> }> {
    const table = await this.table(key);
    const column = keyColumn(table);
    if (!isPlainObject(data)) throw new TypeError(`SQLite record data for ${key.path} must be a plain object`);
    const declared = new Set(table.columns.map((item) => item.name));
    const values = new Map<string, SqliteBindValue>();
    if (!partial) values.set(column, writeValue(key.id));
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (!declared.has(field)) throw new UnsupportedError(`SQLite column is not in table ${table.name}: ${field}`);
      if (field === column) {
        const bound = writeValue(value);
        if (typeof bound === "object" || String(bound) !== String(key.id)) throw new TypeError(`SQLite record ${column} does not match key ${key.path}`);
        continue;
      }
      values.set(field, writeValue(value));
    }
    return { table, column, values };
  }

  async #run(key: Key, table: SqliteTableSchema, sql: string, binds: readonly SqliteBindValue[]): Promise<number> {
    try {
      return (await this.driver.exec(sql, binds)).changes;
    } catch (error) {
      throw mapSqliteError(error, key, table.primaryKey);
    }
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const { table, values } = await this.#record(key, codecOr(codec).encode(data), false);
    const columns = [...values.keys()];
    await this.#run(key, table,
      `INSERT INTO ${quoteIdentifier(table.name, "table name")} (${columns.map((name) => quoteIdentifier(name, "column name")).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      [...values.values()]);
  }

  /** Replaces the whole record: columns missing from `data` get their declared default, or NULL. */
  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const { table, column, values } = await this.#record(key, codecOr(codec).encode(data), false);
    const columns = [...values.keys()];
    const assignments = table.columns.filter((item) => item.name !== column).map((item) => {
      const name = quoteIdentifier(item.name, "column name");
      if (values.has(item.name)) return `${name} = excluded.${name}`;
      return `${name} = ${item.defaultValue === null ? "NULL" : `(${item.defaultValue})`}`;
    });
    const conflict = assignments.length === 0 ? "DO NOTHING" : `DO UPDATE SET ${assignments.join(", ")}`;
    await this.#run(key, table,
      `INSERT INTO ${quoteIdentifier(table.name, "table name")} (${columns.map((name) => quoteIdentifier(name, "column name")).join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT (${quoteIdentifier(column, "column name")}) ${conflict}`,
      [...values.values()]);
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    const { table, column, values } = await this.#record(key, data, true);
    const where = `${quoteIdentifier(column, "column name")} = ?`;
    const tableName = quoteIdentifier(table.name, "table name");
    const changes = values.size === 0
      ? (await this.driver.exec(`SELECT 1 AS found FROM ${tableName} WHERE ${where}`, [writeValue(key.id)])).rows.length
      : await this.#run(key, table,
        `UPDATE ${tableName} SET ${[...values.keys()].map((name) => `${quoteIdentifier(name, "column name")} = ?`).join(", ")} WHERE ${where}`,
        [...values.values(), writeValue(key.id)]);
    if (changes === 0) throw new NotFoundError(key);
  }

  public async delete(key: Key): Promise<void> {
    const table = await this.table(key);
    const column = keyColumn(table);
    const changes = await this.#run(key, table,
      `DELETE FROM ${quoteIdentifier(table.name, "table name")} WHERE ${quoteIdentifier(column, "column name")} = ?`,
      [writeValue(key.id)]);
    if (changes === 0) throw new NotFoundError(key);
  }
}

class Transaction implements ReadwriteTransaction {
  readonly #engine: Engine;
  readonly #capabilities: DatabaseCapabilities;
  #open = true;

  public constructor(engine: Engine, capabilities: DatabaseCapabilities) {
    this.#engine = engine;
    this.#capabilities = capabilities;
  }

  public close(): void { this.#open = false; }

  #check(capability?: "write" | "delete"): Engine {
    if (!this.#open) throw new Error("SQLite transaction is no longer active");
    if (capability !== undefined && !this.#capabilities[capability]) throw new UnsupportedError(capability);
    return this.#engine;
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> { return this.#check().get(key, codec); }
  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> { return this.#check().getMany(keys, codec); }
  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> { return this.#check("write").insert(key, data, codec); }
  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> { return this.#check("write").set(key, data, codec); }
  public async update(key: Key, data: UpdateData): Promise<void> { return this.#check("write").update(key, data); }
  public async delete(key: Key): Promise<void> { return this.#check("delete").delete(key); }
}

/**
 * A DALgo database over one SQLite connection. Every operation, including a
 * whole transaction, runs in order on one queue, so do not call the database
 * itself from inside a transaction callback: use the transaction argument.
 */
export class SqliteDatabase implements Database, CapabilityAware {
  readonly #engine: Engine;
  readonly #capabilities: DatabaseCapabilities;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #onExport: SqliteDatabaseOptions["onExport"];

  public constructor(driver: SqliteDriver, options: SqliteDatabaseOptions = {}) {
    this.#onExport = options.onExport;
    const write = options.write ?? true;
    const remove = options.delete ?? write;
    if (remove && !write) throw new TypeError("SQLite delete capability requires write");
    this.#engine = new Engine(driver);
    this.#capabilities = Object.freeze({
      read: true,
      query: true,
      write,
      delete: remove,
      reset: options.onReset !== undefined,
      persistent: options.persistent ?? false,
      joins: false,
      aggregation: false,
    });
  }

  public capabilities(): DatabaseCapabilities { return this.#capabilities; }

  /** Snapshots committed data after earlier queued work; unavailable without an export provider. */
  public export(options: SqliteExportOptions = {}): Promise<Uint8Array> {
    return this.exclusive(() => this.#onExport === undefined
      ? Promise.reject(new Error("This SQLite connection does not provide database export."))
      : this.#onExport(options));
  }

  /** The database's tables, columns with declared types, primary keys and foreign keys. Cached until `reset()`. */
  public schema(): Promise<SqliteSchema> { return this.exclusive(() => this.#engine.schema()); }

  public get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> { return this.exclusive(() => this.#engine.get(key, codec)); }

  public getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> { return this.exclusive(() => this.#engine.getMany(keys, codec)); }

  public query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> { return this.exclusive(() => this.#engine.query(query)); }

  /** Runs the callback in `BEGIN IMMEDIATE` (or `BEGIN` when read-only); any error rolls the whole batch back. */
  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    return this.exclusive(async () => {
      const driver = this.#engine.driver;
      await driver.exec(this.#capabilities.write ? "BEGIN IMMEDIATE" : "BEGIN");
      const transaction = new Transaction(this.#engine, this.#capabilities);
      try {
        const result = await callback(transaction);
        transaction.close();
        try {
          await driver.exec("COMMIT");
        } catch (error) {
          throw mapSqliteError(error);
        }
        return result;
      } catch (error) {
        transaction.close();
        try {
          await driver.exec("ROLLBACK");
        } catch {
          // SQLite already rolled back (for example after SQLITE_FULL); the original error matters.
        }
        throw error;
      }
    });
  }

  protected exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const run = this.#queue.then(operation);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  protected async replaceDriver(handler: SqliteResetHandler): Promise<void> {
    const next = await handler(this.#engine.driver);
    if (next !== undefined) this.#engine.driver = next;
    this.#engine.forgetSchema();
  }
}

class ResettableSqliteDatabase extends SqliteDatabase implements Resettable {
  readonly #onReset: SqliteResetHandler;

  public constructor(driver: SqliteDriver, options: SqliteDatabaseOptions, onReset: SqliteResetHandler) {
    super(driver, options);
    this.#onReset = onReset;
  }

  /** Waits for queued work, then calls `onReset` and forgets the cached schema. */
  public reset(): Promise<void> { return this.exclusive(() => this.replaceDriver(this.#onReset)); }
}

/** Creates a DALgo database over a SQLite driver. It is {@link Resettable} when `options.onReset` is given. */
export function createSqliteDatabase(driver: SqliteDriver, options: SqliteDatabaseOptions & { readonly onReset: SqliteResetHandler }): SqliteDatabase & Resettable;
export function createSqliteDatabase(driver: SqliteDriver, options?: SqliteDatabaseOptions): SqliteDatabase;
export function createSqliteDatabase(driver: SqliteDriver, options: SqliteDatabaseOptions = {}): SqliteDatabase {
  return options.onReset === undefined ? new SqliteDatabase(driver, options) : new ResettableSqliteDatabase(driver, options, options.onReset);
}
