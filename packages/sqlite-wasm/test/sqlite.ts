import { readFileSync } from "node:fs";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { fromOo1Db, type SqliteDriver } from "../src/index.js";

const sqlite3 = await sqlite3InitModule();
// oo1 logs every failed sqlite3_step(); constraint failures are expected in these tests.
(sqlite3.config as { warn: (...args: unknown[]) => void }).warn = () => undefined;

export type Oo1Db = InstanceType<typeof sqlite3.oo1.DB>;

/** A fresh in-memory database with the given DDL applied, wrapped as a driver. */
export function memoryDriver(ddl = ""): { readonly db: Oo1Db; readonly driver: SqliteDriver } {
  const db = new sqlite3.oo1.DB(":memory:");
  if (ddl !== "") db.exec(ddl);
  return { db, driver: fromOo1Db(db) };
}

/** Loads a SQLite file into a private in-memory copy, so the source file is never modified. */
export function fileCopyDriver(path: string): { readonly db: Oo1Db; readonly driver: SqliteDriver } {
  const bytes = new Uint8Array(readFileSync(path));
  const db = new sqlite3.oo1.DB(":memory:");
  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
  const rc = sqlite3.capi.sqlite3_deserialize(db, "main", pointer, bytes.length, bytes.length, flags);
  if (rc !== 0) throw new Error(`sqlite3_deserialize failed: ${String(rc)}`);
  return { db, driver: fromOo1Db(db) };
}
