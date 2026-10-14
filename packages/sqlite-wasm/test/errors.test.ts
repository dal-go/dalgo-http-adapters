import { describe, expect, it } from "vitest";
import { AlreadyExistsError, DalgoError, Key } from "@dalgo/core";
import { ConstraintViolationError, fromOo1Db, mapSqliteError, sqliteConstraint } from "../src/index.js";
import { memoryDriver } from "./sqlite.js";

function coded(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), fields);
}

describe("sqliteConstraint", () => {
  it("prefers extended result codes from sqlite-wasm and node:sqlite", () => {
    expect(sqliteConstraint(coded("x", { resultCode: 1555 }))).toBe("unique");
    expect(sqliteConstraint(coded("x", { resultCode: 2067 }))).toBe("unique");
    expect(sqliteConstraint(coded("x", { errcode: 787 }))).toBe("foreign_key");
    expect(sqliteConstraint(coded("x", { errcode: 1299 }))).toBe("not_null");
    expect(sqliteConstraint(coded("x", { resultCode: 275 }))).toBe("check");
    expect(sqliteConstraint(coded("x", { resultCode: 19 }))).toBe("other");
    expect(sqliteConstraint(coded("x", { resultCode: 2323 }))).toBe("other");
    expect(sqliteConstraint(coded("x", { resultCode: "787" }))).toBeUndefined();
    expect(sqliteConstraint(coded("no such table: t", { resultCode: 1 }))).toBeUndefined();
  });

  it("falls back to SQLite's portable message text", () => {
    expect(sqliteConstraint(new Error("D1_ERROR: UNIQUE constraint failed: t.a"))).toBe("unique");
    expect(sqliteConstraint(new Error("FOREIGN KEY constraint failed"))).toBe("foreign_key");
    expect(sqliteConstraint(new Error("NOT NULL constraint failed: t.a"))).toBe("not_null");
    expect(sqliteConstraint(new Error("CHECK constraint failed: positive"))).toBe("check");
    expect(sqliteConstraint(new Error("TRIGGER constraint failed"))).toBe("other");
    expect(sqliteConstraint({ message: "UNIQUE constraint failed" })).toBeUndefined();
    expect(sqliteConstraint("UNIQUE constraint failed")).toBeUndefined();
    expect(sqliteConstraint(null)).toBeUndefined();
  });
});

describe("mapSqliteError", () => {
  const key = new Key("Artist", 1);

  it("maps unique conflicts on a key to AlreadyExistsError with the cause", () => {
    const cause = new Error("UNIQUE constraint failed: Artist.ArtistId");
    const mapped = mapSqliteError(cause, key);
    expect(mapped).toBeInstanceOf(AlreadyExistsError);
    expect((mapped as AlreadyExistsError).cause).toBe(cause);
  });

  it("maps other constraints to ConstraintViolationError", () => {
    const keyless = mapSqliteError(new Error("UNIQUE constraint failed: Artist.Name")) as ConstraintViolationError;
    expect(keyless).toBeInstanceOf(ConstraintViolationError);
    expect(keyless).toBeInstanceOf(DalgoError);
    expect(keyless).toMatchObject({ name: "ConstraintViolationError", code: "constraint_violation", constraint: "unique", key: undefined, message: "constraint violation (unique): UNIQUE constraint failed: Artist.Name" });
    const bare = mapSqliteError({ resultCode: 787 }, key) as ConstraintViolationError;
    expect(bare.message).toBe("constraint violation (foreign_key) on Artist/1: SQLite constraint failed");
    const generic = mapSqliteError(coded("constraint violated somewhere", { resultCode: 19 })) as ConstraintViolationError;
    expect(generic.message).toBe("constraint violation (other): constraint violated somewhere");
  });

  it("returns non-constraint errors unchanged", () => {
    const error = new Error("database is locked");
    expect(mapSqliteError(error, key)).toBe(error);
    expect(mapSqliteError("text")).toBe("text");
  });
});

describe("fromOo1Db", () => {
  it("executes statements with and without binds and returns plain rows", async () => {
    const { driver } = memoryDriver("CREATE TABLE t(a INTEGER, b BLOB)");
    expect(await driver.exec("INSERT INTO t VALUES (?, ?)", [1, new DataView(new Uint8Array([9]).buffer)])).toEqual({ rows: [], changes: 1 });
    expect(await driver.exec("INSERT INTO t VALUES (2, NULL)")).toMatchObject({ changes: 1 });
    const { rows } = await driver.exec("SELECT a, b FROM t ORDER BY a");
    expect(rows).toEqual([{ a: 1, b: new Uint8Array([9]) }, { a: 2, b: null }]);
    expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
  });

  it("passes the oo1 call shape through unchanged", () => {
    const calls: unknown[] = [];
    const driver = fromOo1Db({ exec: (options) => { calls.push(options); return []; }, changes: () => 0 });
    void driver.exec("SELECT 1");
    void driver.exec("SELECT ?", ["x"]);
    expect(calls).toEqual([
      { sql: "SELECT 1", rowMode: "object", returnValue: "resultRows" },
      { sql: "SELECT ?", bind: ["x"], rowMode: "object", returnValue: "resultRows" },
    ]);
  });
});
