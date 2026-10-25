import { describe, expect, it } from "vitest";
import {
  CanonicalFetchError,
  CanonicalIntegrityError,
  CorruptDatabaseError,
  DatasetStorageError,
  DemoDbConfigError,
  LeaderChangedError,
  PoolUnavailableError,
  RemoteRequestError,
  TabBridge,
  isPoolUnavailableReason,
  reviveError,
  serializeError,
  workingPath,
  type BridgeHost,
} from "../../src/opfs/index.js";
import { WorkerClient } from "../../src/opfs/client.js";
import type { Sqlite3Like } from "../../src/opfs/engine.js";
import { ChannelHub, FakePool, InProcessWorker, emptyDirectory, pinFor, sampleBytes, serve, sqliteLike } from "./helpers.js";

/** Serializes, structured-clones (as postMessage does) and revives. */
function roundTrip(error: unknown): Error {
  return reviveError(structuredClone(serializeError(error)));
}

const quota = (): Error => Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });

describe("typed errors across the worker boundary", () => {
  it("rebuild DatasetStorageError with its operation and cause", () => {
    const revived = roundTrip(new DatasetStorageError("import", "could not write x", { cause: quota() }));
    expect(revived).toBeInstanceOf(DatasetStorageError);
    expect(revived).toMatchObject({ name: "DatasetStorageError", code: "dataset_storage", operation: "import", message: "could not write x" });
    expect(revived.cause).toBeInstanceOf(Error);
    expect(revived.cause).toMatchObject({ name: "QuotaExceededError", message: "The quota has been exceeded." });
    // Only names and messages cross: no stacks.
    expect(JSON.stringify(serializeError(new DatasetStorageError("import", "x", { cause: quota() })))).not.toContain("typed-errors.test");
    const plain = roundTrip(new DatasetStorageError("open", "no"));
    expect(plain).toMatchObject({ operation: "open" });
    expect(plain.cause).toBeUndefined();
  });

  it("rebuild PoolUnavailableError with its reason and retriability", () => {
    const locked = roundTrip(new PoolUnavailableError("locked", "held", { cause: "a string cause" }));
    expect(locked).toBeInstanceOf(PoolUnavailableError);
    expect(locked).toMatchObject({ code: "opfs_unavailable", reason: "locked", retriable: true, cause: { name: "Error", message: "a string cause" } });
    expect(roundTrip(new PoolUnavailableError("quota", "full"))).toMatchObject({ reason: "quota", retriable: false });
  });

  it("rebuild the canonical, corruption and config errors", () => {
    const fetchError = roundTrip(new CanonicalFetchError("failed to fetch u: HTTP 503", 503));
    expect(fetchError).toBeInstanceOf(CanonicalFetchError);
    expect(fetchError).toMatchObject({ status: 503, code: "canonical_fetch" });
    const offline = roundTrip(new CanonicalFetchError("offline", undefined, { cause: new TypeError("Failed to fetch") }));
    expect(offline).toMatchObject({ cause: { name: "TypeError" } });
    expect((offline as CanonicalFetchError).status).toBeUndefined();
    expect(roundTrip(new CanonicalIntegrityError("bad sha"))).toBeInstanceOf(CanonicalIntegrityError);
    expect(roundTrip(new CorruptDatabaseError("damaged"))).toBeInstanceOf(CorruptDatabaseError);
    const config = roundTrip(new DemoDbConfigError("contradiction"));
    expect(config).toBeInstanceOf(DemoDbConfigError);
    expect(config).toMatchObject({ code: "demodb_config" });
    expect(roundTrip(new TypeError("invalid dataset name"))).toBeInstanceOf(TypeError);
  });

  it("keep SQLite result codes on typed and plain errors", () => {
    const corrupt = Object.assign(new CorruptDatabaseError("x"), { resultCode: 11 });
    expect(roundTrip(corrupt)).toMatchObject({ resultCode: 11 });
    const sqlite = roundTrip(Object.assign(new Error("constraint"), { name: "SQLite3Error", resultCode: 787 }));
    expect(sqlite).toMatchObject({ name: "SQLite3Error", resultCode: 787 });
  });

  it("fall back to a plain error with the fields when a typed error's fields are invalid or the name is unknown", () => {
    const badOperation = reviveError({ name: "DatasetStorageError", message: "m", code: "dataset_storage", operation: "delete" });
    expect(badOperation).not.toBeInstanceOf(DatasetStorageError);
    expect(badOperation).toMatchObject({ name: "DatasetStorageError", operation: "delete", code: "dataset_storage" });
    expect(reviveError({ name: "PoolUnavailableError", message: "m", reason: "nope" })).not.toBeInstanceOf(PoolUnavailableError);
    expect(reviveError({ name: "constructor", message: "m" })).toMatchObject({ name: "constructor", message: "m" });
    const custom = reviveError({ name: "Custom", message: "m", status: 7, retriable: true, cause: { name: "Inner", message: "inner" } });
    expect(custom).toMatchObject({ name: "Custom", status: 7, retriable: true, cause: { name: "Inner", message: "inner" } });
    expect(isPoolUnavailableReason("locked")).toBe(true);
    expect(isPoolUnavailableReason("other-thing")).toBe(false);
  });

  it("reach the leader tab's WorkerClient as their class: a quota failure while writing the working copy", async () => {
    const sample = sampleBytes();
    const pin = pinFor(sample);
    const pool = new FakePool();
    pool.failImport.set(workingPath(pin), quota());
    const sqlite3: Sqlite3Like = { ...sqliteLike, installOpfsSAHPoolVfs: () => Promise.resolve(pool) };
    const client = new WorkerClient(new InProcessWorker({ sqlite3: () => Promise.resolve(sqlite3), fetch: serve({ [pin.url]: sample }), getDirectory: () => Promise.resolve(emptyDirectory) }));
    const error = await client.call("open", { pin }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DatasetStorageError);
    expect(error).toMatchObject({ operation: "import", cause: { name: "QuotaExceededError" } });
  });
});

describe("typed errors across the tab bridge", () => {
  it("reach a follower as their class, and other errors as RemoteRequestError with their fields", async () => {
    const hub = new ChannelHub();
    const leader = new TabBridge(hub.create(), "tab1");
    const follower = new TabBridge(hub.create(), "tab2");
    let failure: Error = new DatasetStorageError("import", "full", { cause: quota() });
    const host: BridgeHost = { request: () => Promise.reject(failure), reset: () => Promise.reject(failure), port: () => undefined };
    leader.becomeLeader(host, null);
    await follower.whenLeader();
    const storage = await follower.reset().catch((caught: unknown) => caught);
    expect(storage).toBeInstanceOf(DatasetStorageError);
    expect(storage).toMatchObject({ operation: "import", cause: { name: "QuotaExceededError" } });
    failure = new PoolUnavailableError("locked", "held");
    expect(await follower.request(1).catch((caught: unknown) => caught)).toMatchObject({ reason: "locked", retriable: true });
    failure = new LeaderChangedError("moved");
    expect(await follower.request(1).catch((caught: unknown) => caught)).toBeInstanceOf(LeaderChangedError);
    failure = Object.assign(new Error("constraint"), { name: "SQLite3Error", resultCode: 787, code: "c", reason: "r", operation: "o", status: 1 });
    const remote = await follower.request(1).catch((caught: unknown) => caught);
    expect(remote).toBeInstanceOf(RemoteRequestError);
    expect(remote).toMatchObject({ name: "SQLite3Error", resultCode: 787, code: "c", reason: "r", operation: "o", status: 1, retriable: false });
    failure = Object.assign(new Error("busy"), { name: "WorkerUnavailableError", retriable: true });
    expect(await follower.request(1).catch((caught: unknown) => caught)).toMatchObject({ name: "WorkerUnavailableError", retriable: true });
  });
});
