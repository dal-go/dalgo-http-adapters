/** A value SQLite can bind to a `?` parameter. Booleans are bound as 1/0 by the database layer. */
export type SqliteBindValue = string | number | bigint | null | ArrayBuffer | ArrayBufferView;

/** One statement's outcome. */
export interface SqliteExecResult {
  /** Result rows keyed by column name, with values exactly as SQLite returned them. */
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  /** Rows changed by an INSERT, UPDATE or DELETE (`sqlite3_changes()`); unspecified for other statements. */
  readonly changes: number;
}

/**
 * The minimal connection a SQLite DALgo database needs: execute one SQL
 * statement with positional binds. Errors must be thrown as-is; the database
 * maps SQLite constraint failures to DALgo errors. One driver is one
 * connection: the database serializes its own operations and runs
 * transactions with `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` through `exec`.
 */
export interface SqliteDriver {
  exec(sql: string, binds?: readonly SqliteBindValue[]): SqliteExecResult | Promise<SqliteExecResult>;
}

/**
 * Turns on foreign key enforcement for the driver's connection and verifies it
 * took effect. SQLite leaves enforcement off by default and ignores the pragma
 * inside a transaction, so call this right after opening the connection.
 */
export async function enableForeignKeys(driver: SqliteDriver): Promise<void> {
  await driver.exec("PRAGMA foreign_keys = ON");
  const { rows } = await driver.exec("PRAGMA foreign_keys");
  if (rows[0]?.foreign_keys !== 1) throw new Error("SQLite foreign key enforcement could not be enabled");
}
