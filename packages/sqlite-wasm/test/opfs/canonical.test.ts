import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CanonicalFetchError,
  CanonicalIntegrityError,
  CorruptDatabaseError,
  canonicalPath,
  datasetDirectory,
  fetchCanonical,
  gunzip,
  journalPath,
  openCanonical,
  prepareConnection,
  sha256Hex,
  validatePin,
  workingPath,
  type CanonicalPin,
  type ClosableOo1Db,
} from "../../src/opfs/canonical.js";
import { FakePool, gzip, pinFor, sampleBytes, serve, sha256 } from "./helpers.js";

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

describe("openCanonical", () => {
  it("imports both copies on first open and reuses them later", async () => {
    const pool = new FakePool();
    const download = vi.fn(() => Promise.resolve(sample));
    const first = await openCanonical(pool, pin, download);
    expect(first).toMatchObject({ imported: true, replacedPreviousVersion: false });
    expect(pool.calls).toEqual([`import ${canonicalPath(pin)}`, `unlink ${journalPath(pin)}`, `import ${workingPath(pin)}`]);
    expect((await first.driver.exec("PRAGMA foreign_keys")).rows).toEqual([{ foreign_keys: 1 }]);
    await first.driver.exec("UPDATE Artist SET Name = 'edited' WHERE ArtistId = 1");
    first.db.close();
    const second = await openCanonical(pool, pin, download);
    expect(second).toMatchObject({ imported: false, replacedPreviousVersion: false });
    expect((await second.driver.exec("SELECT Name FROM Artist WHERE ArtistId = 1")).rows).toEqual([{ Name: "edited" }]);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("re-imports a working copy that is missing its pristine copy or fails to open", async () => {
    const pool = new FakePool();
    await pool.importDb(workingPath(pin), sample);
    expect(await openCanonical(pool, pin, () => Promise.resolve(sample))).toMatchObject({ imported: true });
    pool.opened.get(workingPath(pin))?.close();
    pool.opened.clear();
    pool.failOpen.set(workingPath(pin), 1);
    expect(await openCanonical(pool, pin, () => Promise.resolve(sample))).toMatchObject({ imported: true });
  });

  it("re-imports a working copy that fails quick_check", async () => {
    const pool = new FakePool();
    await openCanonical(pool, pin, () => Promise.resolve(sample));
    const corrupt = { ...fakeDb([{ quick_check: "bad" }]) };
    const open = pool.open.bind(pool);
    let calls = 0;
    pool.open = (name) => (++calls === 1 ? corrupt : open(name));
    expect(await openCanonical(pool, pin, () => Promise.resolve(sample))).toMatchObject({ imported: true });
    expect(corrupt.closed).toBe(true);
  });

  it("fails when a fresh import still cannot be opened", async () => {
    const pool = new FakePool();
    pool.failOpen.set(workingPath(pin), 2);
    await expect(openCanonical(pool, pin, () => Promise.resolve(sample))).rejects.toThrow("file is not a database");
    pool.open = () => { throw "not an Error" as unknown as Error; };
    await expect(openCanonical(pool, pin, () => Promise.resolve(sample))).rejects.toThrow("not an Error");
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
