import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CanonicalFetchError,
  CanonicalIntegrityError,
  CorruptDatabaseError,
  DatasetStorageError,
  canonicalPath,
  datasetDirectory,
  fetchCanonical,
  gunzip,
  isCorruption,
  journalPath,
  openCanonical,
  prepareConnection,
  sha256Hex,
  validatePin,
  workingPath,
  type CanonicalPin,
  type ClosableOo1Db,
} from "../../src/opfs/canonical.js";
import { FakePool, gzip, notADatabase, pinFor, sampleBytes, serve, sha256, sqliteError } from "./helpers.js";

const sample = sampleBytes();
const pin = pinFor(sample);
const sha = "a".repeat(64);

afterEach(() => { vi.unstubAllGlobals(); });

describe("validatePin", () => {
  const valid: CanonicalPin = { dataset: "chinook", url: "/c.sqlite", sha256: sha, bytes: 10 };

  it("accepts a pin with or without gzip parts", () => {
    expect(() => { validatePin(valid); }).not.toThrow();
    expect(() => { validatePin({ ...valid, compression: "gzip", parts: [{ url: "p1", sha256: sha, bytes: 1 }] }); }).not.toThrow();
  });

  it.each([
    [{ dataset: "../x" }, "invalid dataset name"],
    [{ dataset: "" }, "invalid dataset name"],
    [{ url: "" }, "pin.url"],
    [{ sha256: "ABC" }, "pin.sha256"],
    [{ bytes: 0 }, "pin.bytes"],
    [{ bytes: 1.5 }, "pin.bytes"],
    [{ compression: "br" }, "unsupported compression: \"br\""],
    [{ parts: [] }, "must not be empty"],
    [{ parts: [{ url: "", sha256: sha, bytes: 1 }] }, "pin.parts[0].url"],
    [{ parts: [{ url: "p", sha256: "x", bytes: 1 }] }, "pin.parts[0].sha256"],
    [{ parts: [{ url: "p", sha256: sha, bytes: -1 }] }, "pin.parts[0].bytes"],
  ])("rejects %j", (change, message) => {
    expect(() => { validatePin({ ...valid, ...change } as CanonicalPin); }).toThrow(message);
  });
});

describe("paths", () => {
  it("keeps every version of a dataset in its own directory", () => {
    expect(datasetDirectory("chinook")).toBe("/demodb/chinook/");
    expect(workingPath({ dataset: "chinook", sha256: sha })).toBe(`/demodb/chinook/${sha}.sqlite`);
    expect(canonicalPath({ dataset: "chinook", sha256: sha })).toBe(`/demodb/chinook/${sha}.canonical`);
    expect(journalPath({ dataset: "chinook", sha256: sha })).toBe(`/demodb/chinook/${sha}.sqlite-journal`);
  });
});

describe("sha256Hex and gunzip", () => {
  it("hashes with Web Crypto", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("decodes gzip and reports a corrupt stream as an integrity error", async () => {
    expect(await gunzip(gzip(sample))).toEqual(sample);
    const corrupt = gzip(sample).slice(0, 40);
    await expect(gunzip(corrupt)).rejects.toBeInstanceOf(CanonicalIntegrityError);
  });
});

describe("fetchCanonical", () => {
  it("downloads and verifies a single file", async () => {
    const fetchFn = serve({ [pin.url]: sample });
    expect(await fetchCanonical(pin, fetchFn)).toEqual(sample);
  });

  it("joins verified gzip parts resolved against the pin URL", async () => {
    const encoded = gzip(sample);
    const parts = [encoded.slice(0, 100), encoded.slice(100)];
    const fetchFn = serve({ "https://demo.test/data/p1": parts[0] as Uint8Array, "https://demo.test/data/p2": parts[1] as Uint8Array });
    const parted: CanonicalPin = {
      ...pin, url: "https://demo.test/data/", compression: "gzip",
      parts: parts.map((part, index) => ({ url: `p${String(index + 1)}`, sha256: sha256(part), bytes: part.length })),
    };
    expect(await fetchCanonical(parted, fetchFn)).toEqual(sample);
    expect(fetchFn.calls).toEqual(["https://demo.test/data/p1", "https://demo.test/data/p2"]);
    const tampered = { ...parted, parts: [{ ...(parted.parts?.[0] as { url: string; sha256: string; bytes: number }), sha256: sha }, ...(parted.parts?.slice(1) ?? [])] };
    await expect(fetchCanonical(tampered, fetchFn)).rejects.toThrow("sample part 1 has SHA-256");
  });

  it("resolves relative URLs against the page location and uses the global fetch", async () => {
    const fetchFn = serve({ "https://app.test/data/sample.sqlite": sample });
    vi.stubGlobal("location", { href: "https://app.test/page" });
    vi.stubGlobal("fetch", fetchFn);
    expect(await fetchCanonical({ ...pin, url: "/data/sample.sqlite" })).toEqual(sample);
  });

  it("reports download failures", async () => {
    await expect(fetchCanonical(pin, serve({}))).rejects.toMatchObject({ name: "CanonicalFetchError", status: 404, code: "canonical_fetch" });
    const failing = (): Promise<Response> => Promise.reject(new TypeError("offline"));
    const error = await fetchCanonical(pin, failing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CanonicalFetchError);
    expect((error as CanonicalFetchError).cause).toBeInstanceOf(TypeError);
    expect((error as CanonicalFetchError).status).toBeUndefined();
  });

  it("rejects bytes that do not match the pin", async () => {
    await expect(fetchCanonical({ ...pin, bytes: pin.bytes + 1 }, serve({ [pin.url]: sample }))).rejects.toThrow("expected");
    await expect(fetchCanonical({ ...pin, sha256: sha }, serve({ [pin.url]: sample }))).rejects.toMatchObject({ code: "canonical_integrity" });
  });

  it("rejects files that are not rollback-journal SQLite databases", async () => {
    const text = new TextEncoder().encode("not a database at all, just text");
    await expect(fetchCanonical(pinFor(text), serve({ [pin.url]: text }))).rejects.toThrow("is not a SQLite database");
    const wal = sample.slice();
    wal[18] = 2;
    wal[19] = 2;
    await expect(fetchCanonical(pinFor(wal), serve({ [pin.url]: wal }))).rejects.toThrow("WAL mode");
  });
});

function fakeDb(rows: Record<string, unknown>[]): ClosableOo1Db & { closed: boolean } {
  return {
    closed: false,
    exec: () => rows,
    changes: () => 0,
    close() { this.closed = true; },
  };
}

describe("prepareConnection", () => {
  it("refuses a file that fails quick_check", async () => {
    await expect(prepareConnection(fakeDb([{ quick_check: "row 3 missing" }, { quick_check: "page 2 never used" }])))
      .rejects.toThrow(new CorruptDatabaseError("quick_check failed: row 3 missing; page 2 never used"));
  });
});

describe("isCorruption", () => {
  it("accepts only damage, never other failures", () => {
    expect(isCorruption(new CorruptDatabaseError("bad"))).toBe(true);
    expect(isCorruption(notADatabase())).toBe(true);
    expect(isCorruption(sqliteError("database disk image is malformed", 11))).toBe(true);
    expect(isCorruption(sqliteError("malformed (extended)", 11 | (1 << 8)))).toBe(true);
    expect(isCorruption(sqliteError("disk I/O error", 10))).toBe(false);
    expect(isCorruption(sqliteError("database or disk is full", 13))).toBe(false);
    expect(isCorruption(new Error("quota"))).toBe(false);
    expect(isCorruption(null)).toBe(false);
  });
});

async function editAndClose(pool: FakePool, sql: string): Promise<void> {
  const opened = await openCanonical(pool, pin, () => Promise.resolve(sample));
  await opened.driver.exec(sql);
  opened.db.close();
}

const name1 = "SELECT Name FROM Artist WHERE ArtistId = 1";

describe("openCanonical", () => {
  it("imports both copies on first open and reuses them later", async () => {
    const pool = new FakePool();
    const download = vi.fn(() => Promise.resolve(sample));
    const first = await openCanonical(pool, pin, download);
    expect(first).toMatchObject({ imported: true, replacedPreviousVersion: false });
    expect(pool.calls).toEqual([
      `unlink ${canonicalPath(pin)}`, `import ${canonicalPath(pin)}`,
      `unlink ${journalPath(pin)}`, `unlink ${workingPath(pin)}`, `import ${workingPath(pin)}`,
    ]);
    expect((await first.driver.exec("PRAGMA foreign_keys")).rows).toEqual([{ foreign_keys: 1 }]);
    await first.driver.exec("UPDATE Artist SET Name = 'edited' WHERE ArtistId = 1");
    first.db.close();
    const second = await openCanonical(pool, pin, download);
    expect(second).toMatchObject({ imported: false, replacedPreviousVersion: false });
    expect((await second.driver.exec(name1)).rows).toEqual([{ Name: "edited" }]);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("restores a missing working copy from the stored pristine copy without downloading", async () => {
    const pool = new FakePool();
    await editAndClose(pool, "UPDATE Artist SET Name = 'edited' WHERE ArtistId = 1");
    pool.unlink(workingPath(pin));
    const download = vi.fn(() => Promise.resolve(sample));
    const opened = await openCanonical(pool, pin, download);
    expect(opened.imported).toBe(false);
    expect(download).not.toHaveBeenCalled();
    expect((await opened.driver.exec(name1)).rows).toEqual([{ Name: "AC/DC" }]);
  });

  it("recovers from a crash between unlinking and re-importing the working copy", async () => {
    const pool = new FakePool();
    await editAndClose(pool, "UPDATE Artist SET Name = 'edited' WHERE ArtistId = 1");
    await pool.importDb(journalPath(pin), sample);
    pool.failOpen.set(workingPath(pin), [notADatabase()]);
    pool.failImport.set(workingPath(pin), new Error("the tab crashed"));
    await expect(openCanonical(pool, pin, () => Promise.resolve(sample))).rejects.toMatchObject({ name: "DatasetStorageError", operation: "import" });
    // The name is gone (not half-written) and so is the old journal.
    expect(pool.getFileNames().sort()).toEqual([canonicalPath(pin)]);
    const opened = await openCanonical(pool, pin, () => Promise.resolve(sample));
    expect((await opened.driver.exec(name1)).rows).toEqual([{ Name: "AC/DC" }]);
    expect(sha256(pool.exportFile(workingPath(pin)))).toBe(pin.sha256);
  });

  it("restores only a missing pristine copy and keeps the edited working copy", async () => {
    const pool = new FakePool();
    await editAndClose(pool, "UPDATE Artist SET Name = 'kept' WHERE ArtistId = 1");
    pool.unlink(canonicalPath(pin));
    pool.calls.length = 0;
    const opened = await openCanonical(pool, pin, () => Promise.resolve(sample));
    expect(opened.imported).toBe(true);
    expect(pool.calls).toEqual([`unlink ${canonicalPath(pin)}`, `import ${canonicalPath(pin)}`]);
    expect((await opened.driver.exec(name1)).rows).toEqual([{ Name: "kept" }]);
  });

  it("rewrites a damaged working copy from the pristine copy, once", async () => {
    const pool = new FakePool();
    await editAndClose(pool, "UPDATE Artist SET Name = 'edited' WHERE ArtistId = 1");
    pool.failOpen.set(workingPath(pin), [notADatabase()]);
    const download = vi.fn(() => Promise.resolve(sample));
    const opened = await openCanonical(pool, pin, download);
    expect((await opened.driver.exec(name1)).rows).toEqual([{ Name: "AC/DC" }]);
    expect(download).not.toHaveBeenCalled();
    opened.db.close();
    pool.failOpen.set(workingPath(pin), [notADatabase(), notADatabase()]);
    await expect(openCanonical(pool, pin, download)).rejects.toBeInstanceOf(CorruptDatabaseError);
  });

  it("downloads the pristine copy again when the stored one no longer matches the pin", async () => {
    const pool = new FakePool();
    await editAndClose(pool, "SELECT 1");
    await pool.importDb(canonicalPath(pin), sampleBytes("INSERT INTO Artist VALUES (9, 'tampered');"));
    pool.failOpen.set(workingPath(pin), [notADatabase()]);
    const download = vi.fn(() => Promise.resolve(sample));
    const opened = await openCanonical(pool, pin, download);
    expect(download).toHaveBeenCalledTimes(1);
    expect(opened.imported).toBe(true);
    expect(sha256(pool.exportFile(canonicalPath(pin)))).toBe(pin.sha256);
  });

  it("re-imports a working copy that fails quick_check", async () => {
    const pool = new FakePool();
    await editAndClose(pool, "SELECT 1");
    const corrupt = { ...fakeDb([{ quick_check: "bad" }]) };
    const open = pool.open.bind(pool);
    let calls = 0;
    pool.open = (name) => (++calls === 1 ? corrupt : open(name));
    expect(await openCanonical(pool, pin, () => Promise.resolve(sample))).toMatchObject({ imported: false });
    expect(corrupt.closed).toBe(true);
  });

  it("never replaces the working copy for failures other than damage", async () => {
    for (const failure of [sqliteError("disk I/O error", 10), new Error("SQLite foreign key enforcement could not be enabled"), "not an Error"]) {
      const pool = new FakePool();
      await editAndClose(pool, "UPDATE Artist SET Name = 'kept' WHERE ArtistId = 1");
      pool.failOpen.set(workingPath(pin), [failure]);
      pool.calls.length = 0;
      const error = await openCanonical(pool, pin, () => Promise.resolve(sample)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DatasetStorageError);
      expect(error).toMatchObject({ operation: "open", code: "dataset_storage", cause: failure });
      expect(pool.calls).toEqual([]);
      const opened = await openCanonical(pool, pin, () => Promise.resolve(sample));
      expect((await opened.driver.exec(name1)).rows).toEqual([{ Name: "kept" }]);
    }
  });

  it("gives up when a freshly imported working copy is damaged", async () => {
    const pool = new FakePool();
    pool.failOpen.set(workingPath(pin), [notADatabase()]);
    await expect(openCanonical(pool, pin, () => Promise.resolve(sample))).rejects.toBeInstanceOf(CorruptDatabaseError);
  });

  it("reports a full pool as a storage error", async () => {
    const pool = new FakePool();
    pool.failImport.set(canonicalPath(pin), new Error("No available handles to import to."));
    await expect(openCanonical(pool, pin, () => Promise.resolve(sample))).rejects.toMatchObject({ name: "DatasetStorageError", operation: "import" });
    pool.failImport.set(canonicalPath(pin), "text");
    await expect(openCanonical(pool, pin, () => Promise.resolve(sample))).rejects.toThrow("could not write");
  });

  it("deletes the files of other versions and reports a replaced version", async () => {
    const pool = new FakePool();
    const old = { dataset: pin.dataset, sha256: sha };
    await pool.importDb(workingPath(old), sample);
    await pool.importDb(canonicalPath(old), sample);
    await pool.importDb(journalPath(old), sample);
    await pool.importDb(workingPath({ dataset: "other", sha256: sha }), sample);
    const opened = await openCanonical(pool, pin, () => Promise.resolve(sample));
    expect(opened.replacedPreviousVersion).toBe(true);
    expect(pool.getFileNames().sort()).toEqual([canonicalPath(pin), workingPath(pin), workingPath({ dataset: "other", sha256: sha })].sort());
  });

  it("does not report a replaced version when only a pristine copy was left", async () => {
    const pool = new FakePool();
    await pool.importDb(canonicalPath({ dataset: pin.dataset, sha256: sha }), sample);
    expect((await openCanonical(pool, pin, () => Promise.resolve(sample))).replacedPreviousVersion).toBe(false);
  });
});
