import type { SqliteBindValue, SqliteDriver } from "./driver.js";

/** A bind value accepted by the `@sqlite.org/sqlite-wasm` oo1 API. */
export type Oo1BindValue = string | number | bigint | null | Uint8Array | ArrayBuffer;

/**
 * The subset of `@sqlite.org/sqlite-wasm`'s `sqlite3.oo1.DB` (and its OPFS
 * subclasses) used by {@link fromOo1Db}. Declared structurally so this
 * package does not import sqlite-wasm at runtime.
 */
export interface Oo1DatabaseLike {
  exec(options: {
    sql: string;
    bind?: Oo1BindValue[];
    rowMode: "object";
    returnValue: "resultRows";
  }): Record<string, unknown>[];
  changes(): number;
}

function oo1Bind(value: SqliteBindValue): Oo1BindValue {
  if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return value;
}

/** Wraps an open sqlite-wasm oo1 database (in-memory, OPFS or any VFS) as a {@link SqliteDriver}. */
export function fromOo1Db(db: Oo1DatabaseLike): SqliteDriver {
  return {
    exec(sql, binds = []) {
      const rows = db.exec({
        sql,
        ...(binds.length === 0 ? {} : { bind: binds.map(oo1Bind) }),
        rowMode: "object",
        returnValue: "resultRows",
      });
      // oo1 returns null-prototype row objects; hand out plain objects.
      return { rows: rows.map((row) => ({ ...row })), changes: db.changes() };
    },
  };
}
