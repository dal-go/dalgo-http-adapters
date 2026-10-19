import { describe, expect, it, vi } from "vitest";
import { Key } from "@dalgo/core";
import { DemoDbEngine, type Sqlite3Like } from "../../src/opfs/engine.js";
import { WorkerClient, openLeaderDatabase } from "../../src/opfs/client.js";
import { createSqliteDatabase } from "../../src/database.js";
import { MAX_SQLITE_EXPORT_BYTES, sqliteExportLimit } from "../../src/export.js";
import { fromOo1Db } from "../../src/oo1.js";
import { FakePool, InProcessWorker, emptyDirectory, memoryDb, pinFor, sampleBytes, serve, sqliteLike } from "./helpers.js";

const sample = sampleBytes();
const pin = pinFor(sample);

async function contents(bytes: Uint8Array): Promise<unknown> {
  const database = memoryDb(bytes);
  try {
    const driver = fromOo1Db(database);
    expect((await driver.exec("PRAGMA integrity_check")).rows).toEqual([{ integrity_check: "ok" }]);
    return (await driver.exec("SELECT ArtistId, Name FROM Artist ORDER BY ArtistId")).rows.map((row) => [row.ArtistId, row.Name]);
  } finally {
    database.close();
  }
}

describe("current SQLite export", () => {
  it.each(["memory", "opfs"] as const)("exports current %s edits and deleted rows without fetching again", async (storage) => {
    const fetch = serve({ [pin.url]: sample });
    const pool = new FakePool();
    const sqlite: Sqlite3Like = { ...sqliteLike, installOpfsSAHPoolVfs: () => Promise.resolve(pool) };
    const engine = new DemoDbEngine(sqlite, { fetch, getDirectory: () => Promise.resolve(emptyDirectory) });
    await engine.open(pin, { storage });
    await engine.exec("UPDATE Artist SET Name = 'Edited artist' WHERE ArtistId = 1");
    await engine.exec("DELETE FROM Artist WHERE ArtistId = 3");
    await engine.exec("INSERT INTO Artist VALUES (4, 'New artist')");
    const bytes = await engine.export();
    expect(await contents(bytes)).toEqual([[1, "Edited artist"], [2, "Accept"], [4, "New artist"]]);
    expect(fetch.calls).toEqual([pin.url]);
    engine.close();
    // The downloaded snapshot owns its bytes after the original connection closes.
    expect(await contents(bytes)).toEqual([[1, "Edited artist"], [2, "Accept"], [4, "New artist"]]);
    await expect(engine.export()).rejects.toThrow("not open");
  });

  it("waits for a transaction's commit before exporting, without asking for persistence", async () => {
    const worker = new InProcessWorker({ sqlite3: () => Promise.resolve(sqliteLike), fetch: serve({ [pin.url]: sample }), getDirectory: null });
    const client = new WorkerClient(worker);
    const persist = vi.fn(() => Promise.resolve(true));
    const opened = await openLeaderDatabase(client, pin, { requestPersistence: persist });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const transaction = opened.database.runReadwriteTransaction(async (tx) => {
      await tx.update(new Key("Artist", 1), { Name: "Committed together" });
      reached();
      await blocked;
      await tx.delete(new Key("Artist", 3));
    });
    await entered;
    const snapshot = opened.export();
    await Promise.resolve();
    expect(worker.posted.some((message) => (message as { op: string }).op === "export")).toBe(false);
    release();
    await transaction;
    expect(await contents(await snapshot)).toEqual([[1, "Committed together"], [2, "Accept"]]);
    expect(worker.transferredBytes).toEqual([sample.length]);
    expect(persist).not.toHaveBeenCalled();
    client.terminate();
  });

  it("bounds export size before native allocation, and keeps errors actionable across the worker", async () => {
    const serialize = vi.fn((db: Parameters<typeof sqliteLike.capi.sqlite3_js_db_export>[0]) => sqliteLike.capi.sqlite3_js_db_export(db));
    const sqlite: Sqlite3Like = { ...sqliteLike, capi: { ...sqliteLike.capi, sqlite3_js_db_export: serialize } };
    const worker = new InProcessWorker({ sqlite3: () => Promise.resolve(sqlite), fetch: serve({ [pin.url]: sample }), getDirectory: null });
    const client = new WorkerClient(worker);
    const opened = await openLeaderDatabase(client, pin);
    await expect(opened.export({ maxBytes: sample.length - 1 })).rejects.toMatchObject({ code: "sqlite_export_too_large", message: expect.stringContaining("smaller database") as unknown });
    expect(serialize).not.toHaveBeenCalled();
    expect(await contents(await opened.export())).toEqual([[1, "AC/DC"], [2, "Accept"], [3, "Unreferenced"]]);
    client.terminate();
  });

  it("rejects oversized native results even if the database size changed", async () => {
    const engine = new DemoDbEngine({ ...sqliteLike, capi: { ...sqliteLike.capi, sqlite3_js_db_export: () => new Uint8Array(sample.length + 1) } }, { fetch: serve({ [pin.url]: sample }), getDirectory: null });
    await engine.open(pin);
    await expect(engine.export({ maxBytes: sample.length })).rejects.toMatchObject({ code: "sqlite_export_too_large", message: expect.stringContaining("snapshot exceeds") as unknown });
    engine.close();
  });

  it("refuses invalid limits and unsupported export providers", async () => {
    expect(sqliteExportLimit()).toBe(MAX_SQLITE_EXPORT_BYTES);
    expect(sqliteExportLimit({ maxBytes: MAX_SQLITE_EXPORT_BYTES })).toBe(MAX_SQLITE_EXPORT_BYTES);
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_SQLITE_EXPORT_BYTES + 1])
      expect(() => sqliteExportLimit({ maxBytes })).toThrow(RangeError);
    const database = createSqliteDatabase({ exec: () => Promise.resolve({ rows: [], changes: 0 }) });
    await expect(database.export()).rejects.toThrow("does not provide database export");
  });

  it("allows only one export while a transaction is paused and exports the rolled back data", async () => {
    const worker = new InProcessWorker({ sqlite3: () => Promise.resolve(sqliteLike), fetch: serve({ [pin.url]: sample }), getDirectory: null });
    const client = new WorkerClient(worker);
    const opened = await openLeaderDatabase(client, pin);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const transaction = opened.database.runReadwriteTransaction(async (tx) => {
      await tx.update(new Key("Artist", 1), { Name: "Must roll back" });
      reached();
      await blocked;
      throw new Error("cancelled transaction");
    }).catch((error: unknown) => error);
    await entered;
    const snapshot = opened.export();
    await expect(opened.export()).rejects.toMatchObject({ code: "sqlite_export_busy", message: expect.stringContaining("Wait for it to finish") as unknown });
    release();
    expect(await transaction).toMatchObject({ message: "cancelled transaction" });
    expect(await contents(await snapshot)).toEqual([[1, "AC/DC"], [2, "Accept"], [3, "Unreferenced"]]);
    expect(await opened.export()).toBeInstanceOf(Uint8Array);
    client.terminate();
  });
});
