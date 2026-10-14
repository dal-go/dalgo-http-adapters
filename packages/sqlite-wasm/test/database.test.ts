import { describe, expect, it } from "vitest";
import { AlreadyExistsError, DOCUMENT_ID, Key, NotFoundError, UnsupportedError, isCapabilityAware, isResettable, type Codec, type StructuredQuery } from "@dalgo/core";
import {
  ConstraintViolationError,
  createSqliteDatabase,
  enableForeignKeys,
  SqliteDatabase,
  type SqliteBindValue,
  type SqliteDriver,
  type SqliteExecResult,
} from "../src/index.js";
import { memoryDriver } from "./sqlite.js";

const ddl = `
CREATE TABLE Artist(ArtistId INTEGER PRIMARY KEY, Name TEXT NOT NULL UNIQUE, Rating NUMERIC(10,2) DEFAULT 0, Note TEXT);
CREATE TABLE Album(AlbumId INTEGER PRIMARY KEY, Title TEXT NOT NULL CHECK (length(Title) > 0), ArtistId INTEGER NOT NULL REFERENCES Artist(ArtistId));
CREATE TABLE Review(ReviewId INTEGER PRIMARY KEY, ArtistId INTEGER REFERENCES Artist DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE PlaylistTrack(PlaylistId INTEGER NOT NULL, TrackId INTEGER NOT NULL, PRIMARY KEY (TrackId, PlaylistId));
CREATE TABLE Log(Message TEXT, Level INTEGER);
CREATE TABLE Tag(Code TEXT PRIMARY KEY NOT NULL);
CREATE TABLE Asset(Id TEXT PRIMARY KEY, Data BLOB, Flag INTEGER, Big INTEGER);
INSERT INTO Artist VALUES (1, 'AC/DC', 4.5, 'rock'), (2, 'Accept', 3, NULL), (3, 'Aerosmith', 4.25, NULL);
INSERT INTO Album VALUES (10, 'Highway to Hell', 1), (11, 'Balls to the Wall', 2);
INSERT INTO PlaylistTrack VALUES (1, 100), (1, 101), (2, 100);
INSERT INTO Log VALUES ('a', 1), ('b', 2), ('c', 3);
`;

async function open(options: Parameters<typeof createSqliteDatabase>[1] = {}): Promise<{ readonly db: SqliteDatabase; readonly driver: SqliteDriver }> {
  const { driver } = memoryDriver(ddl);
  await enableForeignKeys(driver);
  return { db: createSqliteDatabase(driver, options), driver };
}

function q(name: string, rest: Partial<StructuredQuery<Record<string, unknown>>> = {}): StructuredQuery<Record<string, unknown>> {
  return { source: { kind: "collection", name }, filters: [], orders: [], ...rest };
}

/** Records every statement and lets a test fail chosen ones. */
function recording(inner: SqliteDriver, fail?: (sql: string) => Error | undefined): { readonly driver: SqliteDriver; readonly statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    driver: {
      exec(sql: string, binds?: readonly SqliteBindValue[]): SqliteExecResult | Promise<SqliteExecResult> {
        statements.push(sql);
        const failure = fail?.(sql);
        if (failure !== undefined) throw failure;
        return inner.exec(sql, binds);
      },
    },
  };
}

describe("capabilities", () => {
  it("reports read-write in-memory capabilities by default", async () => {
    const { db } = await open();
    expect(isCapabilityAware(db)).toBe(true);
    expect(isResettable(db)).toBe(false);
    expect(db.capabilities()).toEqual({ read: true, query: true, write: true, delete: true, reset: false, persistent: false, joins: false, aggregation: false });
  });

  it("computes capabilities from options", async () => {
    const { db: readOnly } = await open({ write: false });
    expect(readOnly.capabilities()).toMatchObject({ write: false, delete: false });
    const { db: noDelete } = await open({ delete: false, persistent: true, onReset: () => undefined });
    expect(noDelete.capabilities()).toMatchObject({ write: true, delete: false, persistent: true, reset: true });
    expect(isResettable(noDelete)).toBe(true);
    expect(() => new SqliteDatabase(memoryDriver().driver, { write: false, delete: true })).toThrow("SQLite delete capability requires write");
  });
});

describe("schema", () => {
  it("introspects tables, declared types, defaults, primary keys and foreign keys", async () => {
    const { db } = await open();
    const schema = await db.schema();
    expect(Object.keys(schema.tables)).toEqual(["Album", "Artist", "Asset", "Log", "PlaylistTrack", "Review", "Tag"]);
    expect(schema.tables.Artist).toEqual({
      name: "Artist",
      primaryKey: ["ArtistId"],
      foreignKeys: [],
      columns: [
        { name: "ArtistId", declaredType: "INTEGER", notNull: false, defaultValue: null, primaryKeyPosition: 1 },
        { name: "Name", declaredType: "TEXT", notNull: true, defaultValue: null, primaryKeyPosition: 0 },
        { name: "Rating", declaredType: "NUMERIC(10,2)", notNull: false, defaultValue: "0", primaryKeyPosition: 0 },
        { name: "Note", declaredType: "TEXT", notNull: false, defaultValue: null, primaryKeyPosition: 0 },
      ],
    });
    expect(schema.tables.Album?.foreignKeys).toEqual([{ columns: ["ArtistId"], referencedTable: "Artist", referencedColumns: ["ArtistId"], onUpdate: "NO ACTION", onDelete: "NO ACTION" }]);
    expect(schema.tables.Review?.foreignKeys[0]?.referencedColumns).toEqual([null]);
    expect(schema.tables.PlaylistTrack?.primaryKey).toEqual(["TrackId", "PlaylistId"]);
    expect(schema.tables.Log?.primaryKey).toEqual([]);
    expect(await db.schema()).toBe(schema);
  });

  it("groups multi-column foreign keys and retries a failed schema read", async () => {
    const { driver } = memoryDriver(`
      CREATE TABLE P(A INTEGER, B INTEGER, PRIMARY KEY (A, B));
      CREATE TABLE C(Id INTEGER PRIMARY KEY, A INTEGER, B INTEGER, X INTEGER, FOREIGN KEY (A, B) REFERENCES P(A, B) ON DELETE CASCADE, FOREIGN KEY (X) REFERENCES P(A));`);
    let failures = 1;
    const db = createSqliteDatabase(recording(driver, () => (failures-- > 0 ? new Error("disk I/O error") : undefined)).driver);
    await expect(db.schema()).rejects.toThrow("disk I/O error");
    const schema = await db.schema();
    expect(schema.tables.C?.foreignKeys).toEqual([
      { columns: ["X"], referencedTable: "P", referencedColumns: ["A"], onUpdate: "NO ACTION", onDelete: "NO ACTION" },
      { columns: ["A", "B"], referencedTable: "P", referencedColumns: ["A", "B"], onUpdate: "NO ACTION", onDelete: "CASCADE" },
    ]);
  });

  it("tolerates drivers that return non-text pragma values", async () => {
    const driver: SqliteDriver = {
      exec(sql) {
        if (sql.startsWith("SELECT name FROM sqlite_schema")) return { rows: [{ name: 7 }], changes: 0 };
        if (sql.includes("pragma_table_info")) return { rows: [{ name: null, type: null, notnull: 0, dflt_value: null, pk: 0 }], changes: 0 };
        return { rows: [{ id: 0, table: null, from: null, to: null, on_update: null, on_delete: null }], changes: 0 };
      },
    };
    const schema = await createSqliteDatabase(driver).schema();
    expect(schema.tables[""]).toEqual({
      name: "",
      columns: [{ name: "", declaredType: "", notNull: false, defaultValue: null, primaryKeyPosition: 0 }],
      primaryKey: [],
      foreignKeys: [{ columns: [""], referencedTable: "", referencedColumns: [null], onUpdate: "", onDelete: "" }],
    });
  });
});

describe("reads", () => {
  it("gets records by key with every column and NUMERIC values as SQLite returns them", async () => {
    const { db } = await open();
    expect(await db.get(new Key("Artist", 1))).toEqual({ key: new Key("Artist", 1), exists: true, data: { ArtistId: 1, Name: "AC/DC", Rating: 4.5, Note: "rock" } });
    expect((await db.get(new Key("Artist", "2"))).data).toMatchObject({ ArtistId: 2, Rating: 3 });
    expect(await db.get(new Key("Artist", 99))).toEqual({ key: new Key("Artist", 99), exists: false });
    const upper: Codec<string> = { encode: (value) => value, decode: (value) => (value as { Name: string }).Name.toUpperCase() };
    expect((await db.get(new Key("Artist", 3), upper)).data).toBe("AEROSMITH");
  });

  it("gets many records in key order", async () => {
    const { db } = await open();
    const snapshots = await db.getMany([new Key("Artist", 3), new Key("Artist", 42), new Key("Artist", 1)]);
    expect(snapshots.map((snapshot) => snapshot.exists)).toEqual([true, false, true]);
    expect(snapshots[2]?.data).toMatchObject({ Name: "AC/DC" });
  });

  it("rejects key reads it cannot express", async () => {
    const { db } = await open();
    await expect(db.get(new Key("PlaylistTrack", "[100,1]"))).rejects.toThrow(new UnsupportedError("composite primary key"));
    await expect(db.get(new Key("Log", 1))).rejects.toThrow(new UnsupportedError("table without primary key"));
    await expect(db.get(new Key("Nope", 1))).rejects.toThrow(UnsupportedError);
    await expect(db.get(new Key("Album", 10, new Key("Artist", 1)))).rejects.toThrow("SQLite nested keys");
  });

  it("queries with filters, orders, limits, offsets and DOCUMENT_ID", async () => {
    const { db } = await open();
    const page = await db.query(q("Artist", {
      filters: [{ field: "Rating", operator: ">=", value: 3 }, { field: "ArtistId", operator: "in", value: [1, 2, 3] }],
      orders: [{ field: "Rating", direction: "desc" }],
      limit: 2,
      offset: 1,
    }));
    expect(page.records.map((record) => record.key.path)).toEqual(["Artist/3", "Artist/2"]);
    expect(page.records[0]?.data).toEqual({ ArtistId: 3, Name: "Aerosmith", Rating: 4.25, Note: null });
    const byId = await db.query(q("Artist", { filters: [{ field: DOCUMENT_ID, operator: "==", value: 2 }] }));
    expect(byId.records.map((record) => record.data.Name)).toEqual(["Accept"]);
    const nullNotes = await db.query(q("Artist", { filters: [{ field: "Note", operator: "==", value: null }] }));
    expect(nullNotes.records).toHaveLength(2);
    const names: Codec<string> = { encode: (value) => value, decode: (value) => (value as { Name: string }).Name };
    const decoded = await db.query<string>({ source: { kind: "collection", name: "Artist", codec: names }, filters: [], orders: [] });
    expect(decoded.records.map((record) => record.data)).toEqual(["AC/DC", "Accept", "Aerosmith"]);
  });

  it("queries composite-key and keyless tables with opaque record ids", async () => {
    const { db } = await open();
    const tracks = await db.query(q("PlaylistTrack", { filters: [{ field: "TrackId", operator: "==", value: 100 }] }));
    expect(tracks.records.map((record) => record.key.id)).toEqual(["[100,1]", "[100,2]"]);
    const logs = await db.query(q("Log", { offset: 1 }));
    expect(logs.records.map((record) => record.key.id)).toEqual(["[1]", "[2]"]);
    expect(logs.records[0]?.data).toEqual({ Message: "b", Level: 2 });
  });

  it("keeps 64-bit integers and blobs exactly as SQLite returns them", async () => {
    const { db, driver } = await open();
    await driver.exec("INSERT INTO PlaylistTrack VALUES (?, ?)", [9007199254740993n, 5]);
    await driver.exec("CREATE TABLE Wide(Id INTEGER PRIMARY KEY, V INTEGER)");
    await driver.exec("INSERT INTO Wide VALUES (?, ?)", [9007199254740993n, 9007199254740993n]);
    const fresh = createSqliteDatabase(driver);
    const wide = await fresh.query(q("Wide"));
    expect(wide.records[0]?.key.id).toBe("9007199254740993");
    expect(wide.records[0]?.data.V).toBe(9007199254740993n);
    const tracks = await fresh.query(q("PlaylistTrack", { filters: [{ field: "TrackId", operator: "==", value: 5 }] }));
    expect(tracks.records[0]?.key.id).toBe('[5,"9007199254740993"]');
    await db.runReadwriteTransaction((tx) => tx.insert(new Key("Asset", "a"), { Data: new Uint8Array([1, 2, 3]) }));
    expect((await db.get(new Key("Asset", "a"))).data).toMatchObject({ Data: new Uint8Array([1, 2, 3]) });
  });

  it("rejects primary key values that cannot form a DALgo key", async () => {
    const { db, driver } = await open();
    await driver.exec("INSERT INTO Asset(Id) VALUES ('')");
    await expect(db.query(q("Asset"))).rejects.toThrow("SQLite primary key value in Asset must be a non-empty string or a finite number");
  });

  it("rejects queries on unknown tables", async () => {
    const { db } = await open();
    await expect(db.query(q("Nope"))).rejects.toThrow("SQLite table is not in the database: Nope");
  });
});

describe("writes", () => {
  it("inserts, updates, replaces and deletes records", async () => {
    const { db } = await open();
    await db.runReadwriteTransaction(async (tx) => {
      await tx.insert(new Key("Artist", 4), { Name: "Alanis", Rating: 4, Note: undefined });
      await tx.update(new Key("Artist", 4), { Note: "90s", ArtistId: 4 });
    });
    expect((await db.get(new Key("Artist", 4))).data).toEqual({ ArtistId: 4, Name: "Alanis", Rating: 4, Note: "90s" });

    await db.runReadwriteTransaction((tx) => tx.set(new Key("Artist", 1), { ArtistId: 1, Name: "AC-DC" }));
    expect((await db.get(new Key("Artist", 1))).data).toEqual({ ArtistId: 1, Name: "AC-DC", Rating: 0, Note: null });
    await db.runReadwriteTransaction((tx) => tx.set(new Key("Artist", 5), { Name: "Audioslave", Note: "new" }));
    expect((await db.get(new Key("Artist", 5))).data).toEqual({ ArtistId: 5, Name: "Audioslave", Rating: 0, Note: "new" });

    await db.runReadwriteTransaction((tx) => tx.delete(new Key("Artist", 5)));
    expect((await db.get(new Key("Artist", 5))).exists).toBe(false);
  });

  it("encodes values through a codec and binds booleans, blobs and bigint", async () => {
    const { db } = await open();
    const codec: Codec<{ readonly flag: boolean }> = { encode: (value) => ({ Flag: value.flag, Big: 2n ** 62n, Data: new ArrayBuffer(2) }), decode: (value) => ({ flag: (value as { Flag: number }).Flag === 1 }) };
    await db.runReadwriteTransaction(async (tx) => {
      await tx.insert(new Key("Asset", "x"), { flag: true }, codec);
      await tx.set(new Key("Asset", "y"), { flag: false }, codec);
      await tx.insert(new Key("Asset", "z"), { Data: new DataView(new Uint8Array([7, 8]).buffer), Flag: { $type: "blob", base64: "AQ==" } });
    });
    expect((await db.get(new Key("Asset", "x"), codec)).data).toEqual({ flag: true });
    expect((await db.get(new Key("Asset", "y"))).data).toEqual({ Id: "y", Data: new Uint8Array(2), Flag: 0, Big: 2n ** 62n });
    expect((await db.get(new Key("Asset", "z"))).data).toMatchObject({ Data: new Uint8Array([7, 8]), Flag: new Uint8Array([1]) });
  });

  it("set on a key-only table is an idempotent upsert", async () => {
    const { db } = await open();
    await db.runReadwriteTransaction(async (tx) => {
      await tx.set(new Key("Tag", "jazz"), {});
      await tx.set(new Key("Tag", "jazz"), { Code: "jazz" });
    });
    expect((await db.query(q("Tag"))).records.map((record) => record.key.id)).toEqual(["jazz"]);
  });

  it("maps UNIQUE and PRIMARY KEY conflicts to AlreadyExistsError", async () => {
    const { db } = await open();
    const duplicateKey = db.runReadwriteTransaction((tx) => tx.insert(new Key("Artist", 1), { Name: "Other" }));
    await expect(duplicateKey).rejects.toBeInstanceOf(AlreadyExistsError);
    await expect(duplicateKey).rejects.toThrow("record already exists: Artist/1");
    const duplicateName = db.runReadwriteTransaction((tx) => tx.insert(new Key("Artist", 9), { Name: "Accept" }));
    await expect(duplicateName).rejects.toBeInstanceOf(AlreadyExistsError);
    const renamed = db.runReadwriteTransaction((tx) => tx.update(new Key("Artist", 1), { Name: "Accept" }));
    await expect(renamed).rejects.toBeInstanceOf(AlreadyExistsError);
  });

  it("maps NOT NULL, CHECK and FOREIGN KEY failures to ConstraintViolationError", async () => {
    const { db } = await open();
    const notNull = db.runReadwriteTransaction((tx) => tx.insert(new Key("Artist", 9), { Rating: 1 }));
    await expect(notNull).rejects.toMatchObject({ name: "ConstraintViolationError", code: "constraint_violation", constraint: "not_null", message: "constraint violation (not_null) on Artist/9: NOT NULL constraint failed: Artist.Name" });
    const check = db.runReadwriteTransaction((tx) => tx.insert(new Key("Album", 12), { Title: "", ArtistId: 1 }));
    await expect(check).rejects.toMatchObject({ constraint: "check" });
    const orphan = db.runReadwriteTransaction((tx) => tx.insert(new Key("Album", 12), { Title: "Orphan", ArtistId: 404 }));
    await expect(orphan).rejects.toBeInstanceOf(ConstraintViolationError);
    await expect(orphan).rejects.toMatchObject({ constraint: "foreign_key", key: new Key("Album", 12) });
    const referenced = db.runReadwriteTransaction((tx) => tx.delete(new Key("Artist", 1)));
    await expect(referenced).rejects.toMatchObject({ constraint: "foreign_key", message: "constraint violation (foreign_key) on Artist/1: FOREIGN KEY constraint failed" });
    expect((await db.get(new Key("Artist", 1))).exists).toBe(true);
  });

  it("maps missing rows on update and delete to NotFoundError", async () => {
    const { db } = await open();
    await expect(db.runReadwriteTransaction((tx) => tx.update(new Key("Artist", 404), { Name: "x" }))).rejects.toThrow(new NotFoundError(new Key("Artist", 404)));
    await expect(db.runReadwriteTransaction((tx) => tx.update(new Key("Artist", 404), {}))).rejects.toBeInstanceOf(NotFoundError);
    await expect(db.runReadwriteTransaction((tx) => tx.update(new Key("Artist", 1), {}))).resolves.toBeUndefined();
    await expect(db.runReadwriteTransaction((tx) => tx.delete(new Key("Artist", 404)))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses writes to composite-key and keyless tables", async () => {
    const { db } = await open();
    const composite = new Key("PlaylistTrack", "[100,1]");
    for (const write of [
      (tx: Parameters<Parameters<SqliteDatabase["runReadwriteTransaction"]>[0]>[0]) => tx.insert(composite, { TrackId: 1 }),
      (tx: Parameters<Parameters<SqliteDatabase["runReadwriteTransaction"]>[0]>[0]) => tx.set(composite, {}),
      (tx: Parameters<Parameters<SqliteDatabase["runReadwriteTransaction"]>[0]>[0]) => tx.update(composite, {}),
      (tx: Parameters<Parameters<SqliteDatabase["runReadwriteTransaction"]>[0]>[0]) => tx.delete(composite),
    ]) {
      await expect(db.runReadwriteTransaction(write)).rejects.toThrow(new UnsupportedError("composite primary key"));
    }
    await expect(db.runReadwriteTransaction((tx) => tx.insert(new Key("Log", 1), {}))).rejects.toThrow(new UnsupportedError("table without primary key"));
  });

  it("validates record data", async () => {
    const { db } = await open();
    const key = new Key("Artist", 7);
    await expect(db.runReadwriteTransaction((tx) => tx.insert(key, "Alanis"))).rejects.toThrow("SQLite record data for Artist/7 must be a plain object");
    await expect(db.runReadwriteTransaction((tx) => tx.insert(key, null))).rejects.toThrow(TypeError);
    await expect(db.runReadwriteTransaction((tx) => tx.insert(key, [1]))).rejects.toThrow(TypeError);
    await expect(db.runReadwriteTransaction((tx) => tx.insert(key, new Uint8Array(1)))).rejects.toThrow(TypeError);
    await expect(db.runReadwriteTransaction((tx) => tx.insert(key, new ArrayBuffer(1)))).rejects.toThrow(TypeError);
    await expect(db.runReadwriteTransaction((tx) => tx.insert(key, { Name: "x", Genre: "rock" }))).rejects.toThrow("SQLite column is not in table Artist: Genre");
    await expect(db.runReadwriteTransaction((tx) => tx.insert(key, { ArtistId: 8, Name: "x" }))).rejects.toThrow("SQLite record ArtistId does not match key Artist/7");
    await expect(db.runReadwriteTransaction((tx) => tx.insert(key, { ArtistId: null, Name: "x" }))).rejects.toThrow(TypeError);
    await expect(db.runReadwriteTransaction((tx) => tx.insert(key, { Name: { first: "A" } }))).rejects.toThrow("SQLite record values must be JSON scalars or blobs");
    await expect(db.runReadwriteTransaction((tx) => tx.insert(key, { Name: new Date(0) }))).rejects.toThrow(UnsupportedError);
    expect((await db.get(key)).exists).toBe(false);
  });
});

describe("transactions", () => {
  it("rolls back the whole batch when the callback throws", async () => {
    const { db } = await open();
    await expect(db.runReadwriteTransaction(async (tx) => {
      await tx.insert(new Key("Artist", 20), { Name: "Temp" });
      await tx.update(new Key("Artist", 1), { Note: "changed" });
      expect((await tx.get(new Key("Artist", 20))).exists).toBe(true);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect((await db.get(new Key("Artist", 20))).exists).toBe(false);
    expect((await db.get(new Key("Artist", 1))).data).toMatchObject({ Note: "rock" });
  });

  it("rolls back earlier writes when a later write fails", async () => {
    const { db } = await open();
    await expect(db.runReadwriteTransaction(async (tx) => {
      await tx.insert(new Key("Artist", 21), { Name: "Kept?" });
      await tx.delete(new Key("Artist", 2));
    })).rejects.toBeInstanceOf(ConstraintViolationError);
    expect((await db.getMany([new Key("Artist", 21), new Key("Artist", 2)])).map((snapshot) => snapshot.exists)).toEqual([false, true]);
  });

  it("maps a deferred foreign key failure at COMMIT and rolls back", async () => {
    const { db } = await open();
    const failed = db.runReadwriteTransaction((tx) => tx.insert(new Key("Review", 1), { ArtistId: 404 }));
    await expect(failed).rejects.toBeInstanceOf(ConstraintViolationError);
    await expect(failed).rejects.toMatchObject({ constraint: "foreign_key", key: undefined, message: "constraint violation (foreign_key): FOREIGN KEY constraint failed" });
    expect((await db.get(new Key("Review", 1))).exists).toBe(false);
    await db.runReadwriteTransaction((tx) => tx.insert(new Key("Review", 1), { ArtistId: 1 }));
  });

  it("returns the callback result and closes the transaction afterwards", async () => {
    const { db } = await open();
    let leaked: Parameters<Parameters<SqliteDatabase["runReadwriteTransaction"]>[0]>[0] | undefined;
    const result = await db.runReadwriteTransaction((tx) => { leaked = tx; return Promise.resolve(42); });
    expect(result).toBe(42);
    const stale = leaked;
    if (stale === undefined) throw new Error("transaction was not passed");
    await expect(stale.get(new Key("Artist", 1))).rejects.toThrow("SQLite transaction is no longer active");
    await expect(stale.getMany([])).rejects.toThrow("SQLite transaction is no longer active");
  });

  it("uses BEGIN IMMEDIATE for writable and BEGIN for read-only databases", async () => {
    const { driver } = memoryDriver(ddl);
    const writable = recording(driver);
    await createSqliteDatabase(writable.driver).runReadwriteTransaction(() => Promise.resolve());
    expect(writable.statements).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
    const readOnly = recording(driver);
    const db = createSqliteDatabase(readOnly.driver, { write: false });
    await db.runReadwriteTransaction(async (tx) => {
      expect((await tx.get(new Key("Artist", 1))).exists).toBe(true);
      await expect(tx.insert(new Key("Artist", 30), { Name: "x" })).rejects.toThrow(new UnsupportedError("write"));
      await expect(tx.set(new Key("Artist", 30), { Name: "x" })).rejects.toThrow(UnsupportedError);
      await expect(tx.update(new Key("Artist", 1), { Name: "x" })).rejects.toThrow(UnsupportedError);
      await expect(tx.delete(new Key("Artist", 1))).rejects.toThrow(new UnsupportedError("delete"));
    });
    expect(readOnly.statements[0]).toBe("BEGIN");
  });

  it("keeps deletes off when only delete is disabled", async () => {
    const { db } = await open({ delete: false });
    await expect(db.runReadwriteTransaction((tx) => tx.delete(new Key("Artist", 3)))).rejects.toThrow(new UnsupportedError("delete"));
    await db.runReadwriteTransaction((tx) => tx.update(new Key("Artist", 3), { Note: "ok" }));
  });

  it("keeps the original error when ROLLBACK itself fails", async () => {
    const { driver } = memoryDriver(ddl);
    const { driver: flaky, statements } = recording(driver, (sql) => (sql === "ROLLBACK" ? new Error("rollback failed") : undefined));
    await expect(createSqliteDatabase(flaky).runReadwriteTransaction(() => Promise.reject(new Error("original")))).rejects.toThrow("original");
    expect(statements).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
    await driver.exec("ROLLBACK");
  });

  it("serializes transactions and reads on one connection", async () => {
    const { db } = await open();
    const order: string[] = [];
    const first = db.runReadwriteTransaction(async (tx) => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await tx.update(new Key("Artist", 1), { Note: "first" });
      order.push("first:end");
    });
    const failing = db.runReadwriteTransaction(() => { order.push("failing"); return Promise.reject(new Error("boom")); });
    const second = db.runReadwriteTransaction(async (tx) => {
      order.push("second:start");
      expect((await tx.get(new Key("Artist", 1))).data).toMatchObject({ Note: "first" });
    });
    const read = db.get(new Key("Artist", 1)).then((snapshot) => { order.push("read"); return snapshot; });
    await first;
    await expect(failing).rejects.toThrow("boom");
    await second;
    expect((await read).data).toMatchObject({ Note: "first" });
    expect(order).toEqual(["first:start", "first:end", "failing", "second:start", "read"]);
  });
});

describe("reset", () => {
  it("calls onReset after queued work and switches to a returned driver", async () => {
    const { db: firstDb, driver: first } = memoryDriver(ddl);
    const { driver: second } = memoryDriver("CREATE TABLE Fresh(Id INTEGER PRIMARY KEY)");
    const calls: SqliteDriver[] = [];
    const db = createSqliteDatabase(first, { onReset: (current) => { calls.push(current); return calls.length === 1 ? second : undefined; } });
    expect(Object.keys((await db.schema()).tables)).toContain("Artist");
    const pending = db.runReadwriteTransaction((tx) => tx.update(new Key("Artist", 1), { Note: "before reset" }));
    await db.reset();
    await pending;
    expect(calls).toEqual([first]);
    expect(Object.keys((await db.schema()).tables)).toEqual(["Fresh"]);
    expect(firstDb.selectValue("SELECT Note FROM Artist WHERE ArtistId = 1")).toBe("before reset");
    await db.reset();
    expect(calls).toEqual([first, second]);
    expect(Object.keys((await db.schema()).tables)).toEqual(["Fresh"]);
  });

  it("rebuilds an in-memory database in place and forgets the cached schema", async () => {
    const { driver } = memoryDriver(ddl);
    const db = createSqliteDatabase(driver, {
      onReset: async (current) => {
        await current.exec("DROP TABLE Log");
        return undefined;
      },
    });
    expect(Object.keys((await db.schema()).tables)).toContain("Log");
    await db.reset();
    expect(Object.keys((await db.schema()).tables)).not.toContain("Log");
  });
});

describe("enableForeignKeys", () => {
  it("fails when SQLite does not report enforcement", async () => {
    const driver: SqliteDriver = { exec: () => ({ rows: [{ foreign_keys: 0 }], changes: 0 }) };
    await expect(enableForeignKeys(driver)).rejects.toThrow("SQLite foreign key enforcement could not be enabled");
    await expect(enableForeignKeys({ exec: () => ({ rows: [], changes: 0 }) })).rejects.toThrow(Error);
  });
});
