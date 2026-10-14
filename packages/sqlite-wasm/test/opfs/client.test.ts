import { afterEach, describe, expect, it, vi } from "vitest";
import { Key } from "@dalgo/core";
import { ConstraintViolationError } from "../../src/errors.js";
import { WorkerClient, WorkerUnavailableError, defaultRequestPersistence, openLeaderDatabase, type WorkerLike } from "../../src/opfs/client.js";
import type { Sqlite3Like } from "../../src/opfs/engine.js";
import { FakePool, InProcessWorker, emptyDirectory, pinFor, sampleBytes, serve, sqliteLike } from "./helpers.js";

const sample = sampleBytes();
const pin = pinFor(sample);

afterEach(() => { vi.unstubAllGlobals(); });

function persistentWorker(pool = new FakePool()): InProcessWorker {
  const sqlite3: Sqlite3Like = { ...sqliteLike, installOpfsSAHPoolVfs: () => Promise.resolve(pool) };
  return new InProcessWorker({ sqlite3: () => Promise.resolve(sqlite3), fetch: serve({ [pin.url]: sample }), getDirectory: () => Promise.resolve(emptyDirectory) });
}

function memoryWorker(): InProcessWorker {
  return new InProcessWorker({ sqlite3: () => Promise.resolve(sqliteLike), fetch: serve({ [pin.url]: sample }), getDirectory: null });
}

describe("WorkerClient", () => {
  it("matches answers to calls and revives errors", async () => {
    const client = new WorkerClient(memoryWorker());
    await client.call("open", { pin });
    expect(await client.call("exec", { sql: "SELECT COUNT(*) AS n FROM Artist" })).toEqual({ rows: [{ n: 3 }], changes: 0 });
    await expect(client.call("exec", { sql: "SELECT nope" })).rejects.toMatchObject({ name: "SQLite3Error" });
  });

  it("ignores answers it did not ask for", async () => {
    const target = new EventTarget();
    const worker: WorkerLike = {
      postMessage: () => undefined,
      addEventListener: (type, listener) => { target.addEventListener(type, listener); },
      terminate: () => undefined,
    };
    const client = new WorkerClient(worker);
    target.dispatchEvent(new MessageEvent("message", { data: { id: 42, ok: true, value: 1 } }));
    const call = client.call("close", {});
    target.dispatchEvent(new MessageEvent("message", { data: { id: 1, ok: true, value: "closed" } }));
    expect(await call).toBe("closed");
  });

  it("fails every pending and later call when the worker fails", async () => {
    const worker = memoryWorker();
    const client = new WorkerClient(worker);
    const onFailure = vi.fn();
    client.onFailure = onFailure;
    const pending = client.call("open", { pin });
    worker.crash("out of memory");
    worker.crash("again");
    await expect(pending).rejects.toThrow(new WorkerUnavailableError("dataset worker failed: out of memory"));
    await expect(client.call("close", {})).rejects.toMatchObject({ retriable: true, code: "worker_unavailable" });
    expect(worker.terminated).toBe(true);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("reports a failure without a message, a message error and a deliberate stop", async () => {
    const silent = memoryWorker();
    const first = new WorkerClient(silent);
    silent.crash();
    await expect(first.call("close", {})).rejects.toThrow("dataset worker failed");
    const target = new EventTarget();
    const second = new WorkerClient({ postMessage: () => undefined, addEventListener: (type, listener) => { target.addEventListener(type, listener); }, terminate: () => undefined });
    target.dispatchEvent(new Event("messageerror"));
    await expect(second.call("close", {})).rejects.toBeInstanceOf(WorkerUnavailableError);
    const third = new WorkerClient(memoryWorker());
    third.terminate();
    await expect(third.call("close", {})).rejects.toThrow("the dataset worker was stopped");
    const fourth = new WorkerClient(memoryWorker());
    fourth.terminate("leaving");
    await expect(fourth.call("close", {})).rejects.toThrow("leaving");
  });
});

describe("openLeaderDatabase", () => {
  it("runs a DALgo database in the worker and resets it", async () => {
    const client = new WorkerClient(persistentWorker());
    const persist = vi.fn(() => Promise.resolve(true));
    const opened = await openLeaderDatabase(client, pin, { requestPersistence: persist });
    expect(opened.report).toMatchObject({ persistent: true, imported: true });
    expect(opened.database.capabilities()).toMatchObject({ persistent: true, reset: true, write: true });
    expect(opened.persistence()).toBeUndefined();
    expect((await opened.database.get(new Key("Artist", 1))).data).toEqual({ ArtistId: 1, Name: "AC/DC" });
    expect(persist).not.toHaveBeenCalled();
    await opened.database.runReadwriteTransaction((tx) => tx.update(new Key("Artist", 1), { Name: "edited" }));
    await opened.database.runReadwriteTransaction((tx) => tx.update(new Key("Artist", 2), { Name: "edited" }));
    expect(await opened.persistence()).toBe("granted");
    expect(persist).toHaveBeenCalledTimes(1);
    const refused = opened.database.runReadwriteTransaction((tx) => tx.delete(new Key("Artist", 1)));
    await expect(refused).rejects.toBeInstanceOf(ConstraintViolationError);
    expect(await opened.reset()).toEqual({ canonical: { sha256: pin.sha256 } });
    expect((await opened.database.get(new Key("Artist", 1))).data).toEqual({ ArtistId: 1, Name: "AC/DC" });
  });

  it("reports denied, failed and unavailable persistence", async () => {
    const write = async (persist: (() => Promise<boolean>) | null) => {
      const opened = await openLeaderDatabase(new WorkerClient(persistentWorker()), pin, { requestPersistence: persist });
      await opened.database.runReadwriteTransaction((tx) => tx.update(new Key("Artist", 1), { Name: "x" }));
      return opened.persistence();
    };
    expect(await write(() => Promise.resolve(false))).toBe("denied");
    expect(await write(() => Promise.reject(new Error("no")))).toBe("unavailable");
    expect(await write(null)).toBe("unavailable");
  });

  it("does not ask for persistence in memory", async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    const opened = await openLeaderDatabase(new WorkerClient(memoryWorker()), pin, { requestPersistence: persist });
    expect(opened.database.capabilities()).toMatchObject({ persistent: false, reset: true });
    await opened.database.runReadwriteTransaction((tx) => tx.update(new Key("Artist", 1), { Name: "x" }));
    expect(opened.persistence()).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });

  it("asks navigator.storage.persist by default", async () => {
    const storage = { persist: vi.fn(() => Promise.resolve(true)) };
    vi.stubGlobal("navigator", { storage });
    const opened = await openLeaderDatabase(new WorkerClient(persistentWorker()), pin);
    await opened.database.runReadwriteTransaction((tx) => tx.update(new Key("Artist", 1), { Name: "x" }));
    expect(await opened.persistence()).toBe("granted");
    expect(storage.persist).toHaveBeenCalled();
    vi.stubGlobal("navigator", {});
    expect(defaultRequestPersistence()).toBeUndefined();
    const unavailable = await openLeaderDatabase(new WorkerClient(persistentWorker()), pin);
    await unavailable.database.runReadwriteTransaction((tx) => tx.update(new Key("Artist", 1), { Name: "y" }));
    expect(await unavailable.persistence()).toBe("unavailable");
  });
});
