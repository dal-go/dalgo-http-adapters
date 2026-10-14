import { describe, expect, it } from "vitest";
import { CanonicalFetchError, DatasetStorageError, canonicalPath, journalPath, openCanonical, workingPath } from "../../src/opfs/canonical.js";
import { WorkerClient, openLeaderDatabase } from "../../src/opfs/client.js";
import { DemoDbEngine, type Sqlite3Like } from "../../src/opfs/engine.js";
import { PoolUnavailableError } from "../../src/opfs/pool.js";
import { FakePool, InProcessWorker, emptyDirectory, pinFor, sampleBytes, serve, sha256, sqliteLike } from "./helpers.js";

const sample = sampleBytes();
const pin = pinFor(sample);
const single = { storagePolicy: "single-copy" } as const;
const quota = (): Error => Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });

function engine(pool: FakePool, fetchFn = serve({ [pin.url]: sample })): DemoDbEngine {
  const sqlite3: Sqlite3Like = { ...sqliteLike, installOpfsSAHPoolVfs: () => Promise.resolve(pool) };
  return new DemoDbEngine(sqlite3, { fetch: fetchFn, getDirectory: () => Promise.resolve(emptyDirectory) });
}

async function name(db: DemoDbEngine, id: number): Promise<unknown> {
  return (await db.exec("SELECT Name FROM Artist WHERE ArtistId = ?", [id])).rows[0]?.Name;
}

describe("single-copy storage", () => {
  it("keeps only the working copy, and reopens without downloading", async () => {
    const pool = new FakePool();
    const fetchFn = serve({ [pin.url]: sample });
    const first = engine(pool, fetchFn);
    expect(await first.open(pin, single)).toMatchObject({ persistent: true, imported: true });
    expect(pool.getFileNames()).toEqual([workingPath(pin)]);
    await first.exec("UPDATE Artist SET Name = 'edited' WHERE ArtistId = 1");
    first.close();
    const second = engine(pool, fetchFn);
    expect(await second.open(pin, single)).toMatchObject({ imported: false });
    expect(await name(second, 1)).toBe("edited");
    expect(fetchFn.calls).toHaveLength(1);
    second.close();
  });

  it("drops the pristine copy when a dataset switches to single-copy, and stores it again when it switches back", async () => {
    const pool = new FakePool();
    const fetchFn = serve({ [pin.url]: sample });
    const twoCopies = engine(pool, fetchFn);
    await twoCopies.open(pin);
    twoCopies.close();
    expect(pool.files.has(canonicalPath(pin))).toBe(true);
    const switched = engine(pool, fetchFn);
    expect(await switched.open(pin, single)).toMatchObject({ imported: false });
    switched.close();
    expect(pool.getFileNames()).toEqual([workingPath(pin)]);
    const back = engine(pool, fetchFn);
    expect(await back.open(pin, { storagePolicy: "working-and-pristine" })).toMatchObject({ imported: true });
    back.close();
    expect(pool.files.has(canonicalPath(pin))).toBe(true);
    expect(fetchFn.calls).toHaveLength(2);
  });

  it("writes a missing working copy from a still-valid pristine copy left by the other policy", async () => {
    const pool = new FakePool();
    await pool.importDb(canonicalPath(pin), sample);
    const fetchFn = serve({});
    const opened = await openCanonical(pool, pin, () => Promise.reject(new Error("no download expected")), single);
    expect(opened.imported).toBe(false);
    opened.db.close();
    expect(pool.getFileNames()).toEqual([workingPath(pin)]);
    expect(fetchFn.calls).toEqual([]);
  });

  it("repairs a damaged working copy from a fresh download", async () => {
    const pool = new FakePool();
    pool.files.set(workingPath(pin), new Uint8Array(4096));
    let downloads = 0;
    const opened = await openCanonical(pool, pin, () => { downloads += 1; return Promise.resolve(sample); }, single);
    expect(opened).toMatchObject({ imported: true });
    expect(downloads).toBe(1);
    opened.db.close();
    expect(pool.files.has(canonicalPath(pin))).toBe(false);
  });

  it("resets by downloading and verifying the pin, even after the working copy grew", async () => {
    const pool = new FakePool();
    const fetchFn = serve({ [pin.url]: sample });
    const db = engine(pool, fetchFn);
    await db.open(pin, single);
    await db.exec("UPDATE Artist SET Name = ? WHERE ArtistId = 1", ["x".repeat(200_000)]);
    await db.exec("PRAGMA user_version = 7");
    expect(await db.reset()).toEqual({ canonical: { sha256: pin.sha256 } });
    expect(await name(db, 1)).toBe("AC/DC");
    expect(fetchFn.calls).toHaveLength(2);
    db.close();
    expect(sha256(pool.files.get(workingPath(pin)) ?? new Uint8Array())).toBe(pin.sha256);
    expect(pool.getFileNames()).toEqual([workingPath(pin)]);
  });

  it("keeps the connection and the edits when the reset download fails", async () => {
    const pool = new FakePool();
    let online = true;
    const fetchFn = Object.assign((url: string): Promise<Response> => (online ? serve({ [pin.url]: sample })(url) : Promise.reject(new TypeError("Failed to fetch"))), { calls: [] });
    const db = engine(pool, fetchFn);
    await db.open(pin, single);
    await db.exec("UPDATE Artist SET Name = 'kept' WHERE ArtistId = 1");
    online = false;
    await expect(db.reset()).rejects.toBeInstanceOf(CanonicalFetchError);
    expect(await name(db, 1)).toBe("kept");
    online = true;
    await db.reset();
    expect(await name(db, 1)).toBe("AC/DC");
    db.close();
  });

  it("survives a crash between unlinking the working copy and importing it again", async () => {
    const pool = new FakePool();
    const fetchFn = serve({ [pin.url]: sample });
    const db = engine(pool, fetchFn);
    await db.open(pin, single);
    await db.exec("UPDATE Artist SET Name = 'edited' WHERE ArtistId = 1");
    pool.failImport.set(workingPath(pin), new Error("the worker died mid-import"));
    await expect(db.reset()).rejects.toMatchObject({ name: "DatasetStorageError", operation: "import" });
    await expect(db.exec("SELECT 1")).rejects.toThrow("not open");
    expect(pool.files.has(workingPath(pin))).toBe(false);
    expect(pool.files.has(journalPath(pin))).toBe(false);
    db.close();
    const next = engine(pool, fetchFn);
    expect(await next.open(pin, single)).toMatchObject({ imported: true });
    expect(await name(next, 1)).toBe("AC/DC");
    next.close();
  });

  it("surfaces a quota failure during reset as a typed DatasetStorageError in the leader tab", async () => {
    const pool = new FakePool();
    const sqlite3: Sqlite3Like = { ...sqliteLike, installOpfsSAHPoolVfs: () => Promise.resolve(pool) };
    const client = new WorkerClient(new InProcessWorker({ sqlite3: () => Promise.resolve(sqlite3), fetch: serve({ [pin.url]: sample }), getDirectory: () => Promise.resolve(emptyDirectory) }));
    const opened = await openLeaderDatabase(client, pin, { open: single });
    pool.failImport.set(workingPath(pin), quota());
    const error = await opened.reset().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DatasetStorageError);
    expect(error).toMatchObject({ operation: "import", code: "dataset_storage", cause: { name: "QuotaExceededError" } });
  });
});

describe("memoryFallback: \"forbid\"", () => {
  it("fails with the typed OPFS error before downloading anything", async () => {
    const fetchFn = serve({ [pin.url]: sample });
    const noOpfs = new DemoDbEngine(sqliteLike, { fetch: fetchFn, getDirectory: null });
    const error = await noOpfs.open(pin, { memoryFallback: "forbid" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PoolUnavailableError);
    expect(error).toMatchObject({ reason: "missing-api", retriable: false });
    expect(fetchFn.calls).toEqual([]);
  });

  it("wins over memoryWhenLocked, and refuses memory storage", async () => {
    const lockedError = Object.assign(new Error("locked"), { name: "NoModificationAllowedError" });
    const fetchFn = serve({ [pin.url]: sample });
    const sqlite3: Sqlite3Like = { ...sqliteLike, installOpfsSAHPoolVfs: () => Promise.reject(lockedError) };
    const locked = new DemoDbEngine(sqlite3, { fetch: fetchFn, getDirectory: () => Promise.resolve(emptyDirectory), pool: { attempts: 1 } });
    await expect(locked.open(pin, { memoryWhenLocked: true, memoryFallback: "forbid" })).rejects.toMatchObject({ reason: "locked", retriable: true });
    const memory = new DemoDbEngine(sqliteLike, { fetch: fetchFn });
    await expect(memory.open(pin, { storage: "memory", memoryFallback: "forbid" })).rejects.toMatchObject({ name: "PoolUnavailableError", reason: "other" });
    await expect(memory.open(pin, { storage: "memory", memoryReason: "web-locks-unavailable", memoryFallback: "forbid" }))
      .rejects.toMatchObject({ name: "PoolUnavailableError", reason: "missing-api", message: expect.stringContaining("Web Locks") as unknown });
    expect(await memory.open(pin, { memoryFallback: "allow", storage: "memory" })).toMatchObject({ persistent: false });
    memory.close();
    expect(fetchFn.calls).toHaveLength(1);
  });
});
