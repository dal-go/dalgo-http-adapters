import { describe, expect, it, vi } from "vitest";
import { CanonicalIntegrityError, canonicalPath, journalPath, openCanonical, workingPath } from "../../src/opfs/canonical.js";
import { resetInMemory, resetWorkingCopy } from "../../src/opfs/reset.js";
import { FakePool, exportDb, memoryDb, pinFor, sampleBytes, sha256 } from "./helpers.js";

const sample = sampleBytes();
const pin = pinFor(sample);

async function edited(pool: FakePool) {
  const opened = await openCanonical(pool, pin, () => Promise.resolve(sample));
  await opened.driver.exec("UPDATE Artist SET Name = 'edited' WHERE ArtistId = 1");
  return opened;
}

describe("resetWorkingCopy", () => {
  it("restores the working copy from the pristine copy and drops the journal", async () => {
    const pool = new FakePool();
    const opened = await edited(pool);
    await pool.importDb(journalPath(pin), sample);
    const download = vi.fn(() => Promise.resolve(sample));
    const reset = await resetWorkingCopy(pool, pin, opened.db, download);
    expect((await reset.driver.exec("SELECT Name FROM Artist WHERE ArtistId = 1")).rows).toEqual([{ Name: "AC/DC" }]);
    expect((await reset.driver.exec("PRAGMA foreign_keys")).rows).toEqual([{ foreign_keys: 1 }]);
    expect(pool.getFileNames()).not.toContain(journalPath(pin));
    expect(download).not.toHaveBeenCalled();
    expect(sha256(pool.exportFile(workingPath(pin)))).toBe(pin.sha256);
  });

  it("downloads the pristine copy again when it is missing or altered", async () => {
    const pool = new FakePool();
    const opened = await edited(pool);
    pool.unlink(canonicalPath(pin));
    const download = vi.fn(() => Promise.resolve(sample));
    const reset = await resetWorkingCopy(pool, pin, opened.db, download);
    expect(download).toHaveBeenCalledTimes(1);
    await pool.importDb(canonicalPath(pin), sampleBytes("INSERT INTO Artist VALUES (9, 'tampered');"));
    await resetWorkingCopy(pool, pin, reset.db, download);
    expect(download).toHaveBeenCalledTimes(2);
    expect(sha256(pool.exportFile(canonicalPath(pin)))).toBe(pin.sha256);
  });

  it("refuses a result that differs from the pin and leaves it closed", async () => {
    const pool = new FakePool();
    const opened = await edited(pool);
    const other = sampleBytes("INSERT INTO Artist VALUES (9, 'other');");
    const wrongPin = { ...pin, sha256: sha256(other) };
    await pool.importDb(canonicalPath(wrongPin), other);
    pool.importDb = (name, bytes) => {
      pool.files.set(name, name === workingPath(wrongPin) ? sample : bytes);
      return Promise.resolve(bytes.length);
    };
    await expect(resetWorkingCopy(pool, wrongPin, opened.db, () => Promise.resolve(other))).rejects.toBeInstanceOf(CanonicalIntegrityError);
    expect(pool.opened.size).toBe(0);
  });
});

describe("resetInMemory", () => {
  const memory = { open: memoryDb, export: exportDb };

  it("reopens the verified canonical bytes", async () => {
    const current = memoryDb(sample);
    const reset = await resetInMemory(current, sample, pin.sha256, memory);
    expect((await reset.driver.exec("SELECT COUNT(*) AS n FROM Artist")).rows).toEqual([{ n: 3 }]);
    reset.db.close();
  });

  it("refuses bytes that do not match", async () => {
    await expect(resetInMemory(memoryDb(sample), sample, "0".repeat(64), memory)).rejects.toThrow("reset produced SHA-256");
  });
});
