import { AlreadyExistsError, DalgoError, type Key } from "@dalgo/core";

/** The SQLite constraint that rejected a statement. */
export type SqliteConstraint = "foreign_key" | "not_null" | "check" | "unique" | "other";

/**
 * A SQLite constraint rejected a write. `@dalgo/core` has no constraint error
 * yet, so this adapter defines one with the stable code `constraint_violation`.
 */
export class ConstraintViolationError extends DalgoError {
  public readonly code = "constraint_violation" as const;
  public readonly constraint: SqliteConstraint;
  /** The record being written, when the failure belongs to one statement. */
  public readonly key: Key | undefined;

  public constructor(constraint: SqliteConstraint, detail: string, key?: Key, options?: ErrorOptions) {
    super(`constraint violation (${constraint})${key === undefined ? "" : ` on ${key.path}`}: ${detail}`, options);
    this.constraint = constraint;
    this.key = key;
  }
}

const SQLITE_CONSTRAINT = 19;
const extendedCodes: Readonly<Record<number, SqliteConstraint>> = {
  275: "check",
  787: "foreign_key",
  1299: "not_null",
  1555: "unique", // SQLITE_CONSTRAINT_PRIMARYKEY
  2067: "unique",
};
const messagePatterns: readonly (readonly [RegExp, SqliteConstraint])[] = [
  [/UNIQUE constraint failed/u, "unique"],
  [/FOREIGN KEY constraint failed/u, "foreign_key"],
  [/NOT NULL constraint failed/u, "not_null"],
  [/CHECK constraint failed/u, "check"],
];

function resultCode(error: object): number | undefined {
  const code: unknown = (error as { readonly resultCode?: unknown; readonly errcode?: unknown }).resultCode ??
    (error as { readonly errcode?: unknown }).errcode;
  return typeof code === "number" ? code : undefined;
}

/**
 * Classifies a SQLite driver error. Uses the extended result code
 * (`resultCode` from sqlite-wasm, `errcode` from node:sqlite) when present and
 * the portable message text otherwise. Returns `undefined` for non-constraint errors.
 */
export function sqliteConstraint(error: unknown): SqliteConstraint | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = resultCode(error);
  if (code !== undefined && Object.hasOwn(extendedCodes, code)) return extendedCodes[code];
  const message = error instanceof Error ? error.message : "";
  for (const [pattern, constraint] of messagePatterns) if (pattern.test(message)) return constraint;
  if ((code !== undefined && (code & 0xff) === SQLITE_CONSTRAINT) || message.includes("constraint failed")) return "other";
  return undefined;
}

const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/**
 * Whether a UNIQUE failure is a conflict on the primary key. The extended
 * result code decides when there is one; otherwise the columns SQLite names
 * ("UNIQUE constraint failed: T.a, T.b") are compared with `primaryKey`, and
 * without `primaryKey` the conflict is taken to be on the key.
 */
function primaryKeyConflict(error: object, primaryKey: readonly string[] | undefined): boolean {
  const code = resultCode(error);
  if (code === SQLITE_CONSTRAINT_PRIMARYKEY) return true;
  if (code === SQLITE_CONSTRAINT_UNIQUE || primaryKey === undefined) return code !== SQLITE_CONSTRAINT_UNIQUE;
  // Only an Error's message can name a UNIQUE failure without an extended code.
  const failed = /UNIQUE constraint failed: ([^\n]+)/u.exec((error as Error).message)?.[1];
  if (failed === undefined) return true;
  const columns = failed.split(", ").map((column) => column.slice(column.lastIndexOf(".") + 1).trim());
  return columns.length === primaryKey.length && columns.every((column) => primaryKey.includes(column));
}

/**
 * Maps a SQLite constraint failure to a DALgo error: a PRIMARY KEY conflict
 * while writing `key` becomes `AlreadyExistsError`; every other constraint,
 * including a UNIQUE column other than the key, becomes
 * {@link ConstraintViolationError}. Pass the table's `primaryKey` so drivers
 * without extended result codes are classified by the columns SQLite names.
 * Other errors are returned unchanged.
 */
export function mapSqliteError(error: unknown, key?: Key, primaryKey?: readonly string[]): unknown {
  const constraint = sqliteConstraint(error);
  if (constraint === undefined) return error;
  if (constraint === "unique" && key !== undefined && primaryKeyConflict(error as object, primaryKey)) return new AlreadyExistsError(key, { cause: error });
  const message = error instanceof Error ? error.message : "";
  const detail = /[A-Z][A-Z ]* constraint failed.*$/u.exec(message)?.[0] ?? (message === "" ? "SQLite constraint failed" : message);
  return new ConstraintViolationError(constraint, detail, key, { cause: error });
}
