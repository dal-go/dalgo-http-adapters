import { afterEach, describe, expect, it, vi } from "vitest";
import { workingPath } from "../../src/opfs/canonical.js";
import { DemoDbEngine, type Sqlite3Like } from "../../src/opfs/engine.js";
import type { ProbeDirectoryHandle, ProbeFileHandle } from "../../src/opfs/pool.js";
import { FakePool, emptyDirectory, notADatabase, pinFor, sampleBytes, serve, sqliteLike } from "./helpers.js";

const sample = sampleBytes();
const pin = pinFor(sample);
const fetchFn = serve({ [pin.url]: sample });

afterEach(() => { vi.unstubAllGlobals(); });

function withPool(pool: FakePool): Sqlite3Like {
  return { ...sqliteLike, installOpfsSAHPoolVfs: () => Promise.resolve(pool) };
}

async function name(engine: DemoDbEngine, id: number): Promise<unknown> {
  return (await engine.exec("SELECT Name FROM Artist WHERE ArtistId = ?", [id])).rows[0]?.Name;
}

describe("DemoDbEngine with OPFS", () => {
  it("opens, edits, resets and closes the pooled working copy", async () => {
    const pool = new FakePool();
    const engine = new DemoDbEngine(withPool(pool), { fetch: fetchFn, getDirectory: () => Promise.resolve(emptyDirectory) });
    expect(await engine.open(pin)).toEqual({
      dataset: "sample", canonical: { sha256: pin.sha256 }, persistent: true, replacedPreviousVersion: false, imported: true,
    });
    await engine.exec("UPDATE Artist SET Name = 'edited' WHERE ArtistId = 1");
    expect(await name(engine, 1)).toBe("edited");
    expect(await engine.reset()).toEqual({ canonical: { sha256: pin.sha256 } });
    expect(await name(engine, 1)).toBe("AC/DC");
    engine.close();
    expect(pool.paused).toBe(true);
    expect(pool.opened.size).toBe(0);
    engine.close();
    await expect(engine.exec("SELECT 1")).rejects.toThrow("the dataset is not open");
    const reopened = new DemoDbEngine(withPool(pool), { fetch: fetchFn, getDirectory: () => Promise.resolve(emptyDirectory) });
    expect(await reopened.open(pin)).toMatchObject({ imported: false, persistent: true });
    await expect(reopened.open(pin)).rejects.toThrow("already open");
  });

  it("releases the pool when the dataset cannot be opened", async () => {
    const pool = new FakePool();
    const engine = new DemoDbEngine(withPool(pool), { fetch: serve({}), getDirectory: () => Promise.resolve(emptyDirectory) });
    await expect(engine.open(pin)).rejects.toMatchObject({ name: "CanonicalFetchError" });
    expect(pool.paused).toBe(true);
  });

  it("keeps the connection closed when a reset fails", async () => {
    const pool = new FakePool();
    const engine = new DemoDbEngine(withPool(pool), { fetch: fetchFn, getDirectory: () => Promise.resolve(emptyDirectory) });
    await engine.open(pin);
    pool.failOpen.set(workingPath(pin), [notADatabase()]);
    await expect(engine.reset()).rejects.toThrow("file is not a database");
    await expect(engine.exec("SELECT 1")).rejects.toThrow("not open");
    engine.close();
  });

  it("uses navigator.storage.getDirectory and the global fetch by default", async () => {
    const pool = new FakePool();
    const storage = { getDirectory: vi.fn(() => Promise.resolve(emptyDirectory)) };
    vi.stubGlobal("navigator", { storage });
    vi.stubGlobal("fetch", fetchFn);
    const engine = new DemoDbEngine(withPool(pool), { pool: { attempts: 1 } });
    expect(await engine.open(pin)).toMatchObject({ persistent: true });
    expect(storage.getDirectory).toHaveBeenCalled();
    engine.close();
  });
});

function lockedDirectory(): ProbeDirectoryHandle {
  const locked: ProbeFileHandle = {
    kind: "file",
    name: "slot",
    createSyncAccessHandle: () => Promise.reject(Object.assign(new Error("locked"), { name: "NoModificationAllowedError" })),
  };
  const handle: ProbeDirectoryHandle = {
    getDirectoryHandle: () => Promise.resolve(handle),
    values: () => ({ [Symbol.asyncIterator]: () => { let done = false; return { next: () => { const result = done ? { done: true as const, value: undefined } : { done: false as const, value: locked }; done = true; return Promise.resolve(result); } }; } }),
  };
  return handle;
}

describe("DemoDbEngine with a locked pool", () => {
  const options = { fetch: fetchFn, getDirectory: () => Promise.resolve(lockedDirectory()), pool: { attempts: 2, baseDelayMs: 1 } };

  it("fails with a retriable error instead of dropping to memory", async () => {
    const engine = new DemoDbEngine(withPool(new FakePool()), options);
    await expect(engine.open(pin)).rejects.toMatchObject({ name: "PoolUnavailableError", reason: "locked", retriable: true });
    await expect(engine.exec("SELECT 1")).rejects.toThrow("not open");
  });

  it("opens in memory only when the caller opts in", async () => {
    const engine = new DemoDbEngine(withPool(new FakePool()), options);
    expect(await engine.open(pin, { memoryWhenLocked: true })).toMatchObject({ persistent: false, fallback: { kind: "memory", reason: "locked" } });
    engine.close();
  });
});

describe("DemoDbEngine in memory on request", () => {
  it("skips OPFS and says why", async () => {
    const pool = new FakePool();
    const engine = new DemoDbEngine(withPool(pool), { fetch: fetchFn, getDirectory: () => Promise.resolve(emptyDirectory) });
    expect(await engine.open(pin, { storage: "memory" })).toMatchObject({ persistent: false, fallback: { reason: "requested", message: "memory storage was requested" } });
    engine.close();
    const noLocks = new DemoDbEngine(withPool(pool), { fetch: fetchFn });
    expect(await noLocks.open(pin, { storage: "memory", memoryReason: "web-locks-unavailable" })).toMatchObject({ fallback: { reason: "web-locks-unavailable" } });
    expect(pool.files.size).toBe(0);
  });
});

describe("DemoDbEngine fallback", () => {
  it("serves the verified canonical bytes from memory without OPFS", async () => {
    const engine = new DemoDbEngine(sqliteLike, { fetch: fetchFn, getDirectory: null });
    expect(await engine.open(pin)).toEqual({
      dataset: "sample", canonical: { sha256: pin.sha256 }, persistent: false, replacedPreviousVersion: false, imported: true,
      fallback: { kind: "memory", reason: "missing-api", message: "this sqlite3 build has no installOpfsSAHPoolVfs" },
    });
    await engine.exec("UPDATE Artist SET Name = ? WHERE ArtistId = 1", ["in memory"]);
    expect(await name(engine, 1)).toBe("in memory");
    await engine.reset();
    expect(await name(engine, 1)).toBe("AC/DC");
    engine.close();
  });

  it("falls back when the pool cannot be installed", async () => {
    vi.stubGlobal("navigator", {});
    const engine = new DemoDbEngine(withPool(new FakePool()), { fetch: fetchFn });
    expect(await engine.open(pin)).toMatchObject({ persistent: false, fallback: { reason: "missing-api", message: "navigator.storage.getDirectory is missing" } });
    engine.close();
  });

  it("reports a failed deserialize", async () => {
    const broken: Sqlite3Like = { ...sqliteLike, capi: { ...sqliteLike.capi, sqlite3_deserialize: () => 1 } };
    const engine = new DemoDbEngine(broken, { fetch: fetchFn, getDirectory: null });
    await expect(engine.open(pin)).rejects.toThrow("sqlite3_deserialize failed with result code 1");
  });

  it("validates the pin before anything else", async () => {
    const engine = new DemoDbEngine(sqliteLike, { fetch: fetchFn });
    await expect(engine.open({ ...pin, dataset: "" })).rejects.toThrow("invalid dataset name");
  });
});
