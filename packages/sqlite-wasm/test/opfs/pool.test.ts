import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PoolUnavailableError,
  datasetPool,
  installPool,
  mapPoolError,
  poolOptionsFor,
  type InstallSahPool,
  type ProbeDirectoryHandle,
  type ProbeFileHandle,
} from "../../src/opfs/pool.js";
import { FakePool, emptyDirectory } from "./helpers.js";

afterEach(() => { vi.unstubAllGlobals(); });

function domError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("mapPoolError", () => {
  it.each([
    [domError("NoModificationAllowedError"), "locked", true],
    [domError("InvalidStateError", "The object is in an invalid state."), "locked", true],
    [domError("SecurityError"), "security", false],
    [domError("NotAllowedError"), "security", false],
    [domError("QuotaExceededError"), "quota", false],
    [new Error("Missing required OPFS APIs."), "missing-api", false],
    [new Error("The local OPFS API is too old for opfs-sahpool: it has an async close() method."), "sync-handles-unavailable", false],
    [domError("UnknownError", "The operation failed for an unknown transient reason"), "other", false],
    ["a string", "other", false],
    [{ name: "NoModificationAllowedError" }, "locked", true],
  ])("maps %s to %s", (error, reason, retriable) => {
    const mapped = mapPoolError(error);
    expect(mapped).toMatchObject({ name: "PoolUnavailableError", code: "opfs_unavailable", reason, retriable });
    expect(mapped.cause).toBe(error);
  });

  it("keeps a pool error as it is", () => {
    const error = new PoolUnavailableError("quota", "full");
    expect(mapPoolError(error)).toBe(error);
  });
});

it("gives every dataset its own VFS and directory", () => {
  expect(poolOptionsFor("chinook")).toEqual({ name: "demodb-chinook", directory: ".demodb/chinook", initialCapacity: 8 });
});

function file(name: string, failures: Error[] = []): ProbeFileHandle & { opened: number } {
  return {
    kind: "file",
    name,
    opened: 0,
    createSyncAccessHandle() {
      const failure = failures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      this.opened += 1;
      return Promise.resolve({ close: () => undefined });
    },
  };
}

function directory(entries: ProbeFileHandle[], visited: string[] = []): ProbeDirectoryHandle {
  const handle: ProbeDirectoryHandle = {
    getDirectoryHandle(name) {
      visited.push(name);
      return Promise.resolve(handle);
    },
    values() {
      const items = entries[Symbol.iterator]();
      return { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve(items.next()) }) };
    },
  };
  return handle;
}

describe("installPool", () => {
  const options = poolOptionsFor("sample");

  it("installs the VFS after probing every pool file", async () => {
    const pool = new FakePool();
    const install = vi.fn<InstallSahPool>(() => Promise.resolve(pool));
    const visited: string[] = [];
    const slot = file("slot");
    const util = await installPool({ ...options, directory: "/a//b" }, {
      install,
      getDirectory: () => Promise.resolve(directory([slot, { kind: "directory", name: "nested" }], visited)),
    });
    expect(util).toBe(pool);
    expect(visited).toEqual(["a", "b", ".opaque"]);
    expect(slot.opened).toBe(1);
    expect(install).toHaveBeenCalledWith({ ...options, directory: "/a//b", forceReinitIfPreviouslyFailed: true });
  });

  it("unpauses a pool paused by an earlier close", async () => {
    const pool = new FakePool();
    pool.paused = true;
    await installPool(options, { install: () => Promise.resolve(pool), getDirectory: () => Promise.resolve(emptyDirectory) });
    expect(pool.paused).toBe(false);
  });

  it("waits with exponential backoff while the files are locked", async () => {
    const pool = new FakePool();
    const sleep = vi.fn(() => Promise.resolve());
    const onRetry = vi.fn();
    const locked = () => domError("NoModificationAllowedError");
    const slot = file("slot", [locked(), locked(), locked(), locked()]);
    const util = await installPool(options, {
      install: () => Promise.resolve(pool),
      getDirectory: () => Promise.resolve(directory([slot])),
      baseDelayMs: 100,
      maxDelayMs: 300,
      sleep,
      onRetry,
    });
    expect(util).toBe(pool);
    expect(sleep.mock.calls).toEqual([[100], [200], [300], [300]]);
    expect(onRetry).toHaveBeenCalledTimes(4);
    expect(onRetry.mock.calls[0]).toEqual([expect.objectContaining({ reason: "locked" }), 1]);
  });

  it("gives up when the files stay locked", async () => {
    const install = vi.fn<InstallSahPool>();
    const slot = file("slot", Array.from({ length: 3 }, () => domError("InvalidStateError")));
    await expect(installPool(options, { install, getDirectory: () => Promise.resolve(directory([slot])), attempts: 3, baseDelayMs: 1 }))
      .rejects.toMatchObject({ reason: "locked" });
    expect(install).not.toHaveBeenCalled();
  });

  it("does not retry other failures", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    await expect(installPool(options, {
      install: () => Promise.reject(domError("SecurityError")),
      getDirectory: () => Promise.resolve(emptyDirectory),
      sleep,
    })).rejects.toMatchObject({ reason: "security" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reports missing APIs", async () => {
    const getDirectory = () => Promise.resolve(emptyDirectory);
    await expect(installPool(options, { install: undefined, getDirectory })).rejects.toMatchObject({ reason: "missing-api" });
    await expect(installPool(options, { install: vi.fn(), getDirectory: undefined })).rejects.toMatchObject({ reason: "missing-api" });
    await expect(installPool(options, { install: vi.fn(), getDirectory: () => Promise.resolve(directory([{ kind: "file", name: "slot" }])) }))
      .rejects.toMatchObject({ reason: "missing-api" });
    vi.stubGlobal("FileSystemFileHandle", { prototype: {} });
    await expect(installPool(options, { install: vi.fn(), getDirectory })).rejects.toMatchObject({ reason: "missing-api" });
    vi.stubGlobal("FileSystemFileHandle", { prototype: { createSyncAccessHandle: () => undefined } });
    const pool = new FakePool();
    expect(await installPool(options, { install: () => Promise.resolve(pool), getDirectory })).toBe(pool);
  });
});

it("adapts the pool utility to the dataset store", async () => {
  const pool = new FakePool();
  const store = datasetPool(pool);
  await store.importDb("/x", new Uint8Array([1]));
  expect(store.getFileNames()).toEqual(["/x"]);
  expect(store.exportFile("/x")).toEqual(new Uint8Array([1]));
  expect(store.unlink("/x")).toBe(true);
  const db = store.open("/y");
  expect(db.exec({ sql: "SELECT 1 AS one", rowMode: "object", returnValue: "resultRows" })).toEqual([{ one: 1 }]);
  db.close();
});
