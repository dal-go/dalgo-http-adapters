import { collection, key, type Codec, type Key } from "@dalgo/core";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CouchDbBatchSizeError, CouchDbDatabase, CouchDbHttpError, CouchDbRequestError, NativeCouchDbDatabase, type CouchDbDatabaseOptions, type NativeCouchDbDatabaseOptions } from "../src/index.js";

type Mode = "managed" | "native";
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function stored(mode: Mode, id = "a"): Record<string, unknown> {
  const data = { title: "fixture", done: false, nested: [null, { n: 1.25 }] };
  return mode === "native" ? { _id: id, _rev: "1-owned", ...data } : { _id: btoa(JSON.stringify(["items", id])).replace(/=/gu, ""), _rev: "1-owned", __dalgo_collection: "items", __dalgo_id: id, data };
}
function reply(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status }); }
function setup(mode: Mode, changes: Partial<CouchDbDatabaseOptions & NativeCouchDbDatabaseOptions> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(); const headers = vi.fn(() => ({ authorization: "Bearer owned-scoped-reader" }));
  const options = { databaseUrl: "https://couch.example.test/app", collection: "items", fetch, headers, ...changes };
  const db = mode === "native" ? new NativeCouchDbDatabase(options) : new CouchDbDatabase(options);
  return { db, fetch, headers };
}
function signalOf(fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, index = 0): AbortSignal {
  const signal = fetch.mock.calls[index]?.[1]?.signal;
  if (signal == null) throw new Error("fixture requires an operation signal");
  return signal;
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe.each(["managed", "native"] as const)("%s CouchDB whole-operation lifecycle", (mode) => {
  it("refuses preabort before headers or HTTP and preserves public identity", async () => {
    const { db, fetch, headers } = setup(mode); const caller = new AbortController(); caller.abort("private-reason");
    await expect(db.getWithSignal(key("items", "a"), caller.signal)).rejects.toBeInstanceOf(QueryCancelledError);
    await expect(db.getManyWithSignal([key("items", "a")], caller.signal)).rejects.toMatchObject({ reason: "caller" });
    await expect(db.queryWithSignal(collection("items").query().limit(1).build(), caller.signal)).rejects.toMatchObject({ reason: "caller" });
    expect(headers).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("starts the deadline before header waiting and observes late rejection", async () => {
    vi.useFakeTimers(); vi.spyOn(performance, "now").mockReturnValue(0); const entered = deferred<undefined>(); const late = deferred<Readonly<Record<string, string>>>();
    const { db, fetch } = setup(mode, { timeoutMs: 10, headers: (signal) => { expect(signal?.aborted).toBe(false); entered.resolve(undefined); return late.promise; } });
    const outcome = expect(db.get(key("items", "a"))).rejects.toMatchObject({ name: "QueryCancelledError", reason: "deadline" });
    await entered.promise; await vi.advanceTimersByTimeAsync(10); await outcome;
    late.reject(new Error("private-late-header-cause")); await Promise.resolve(); expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("prevents fetch after synchronous header work crosses elapsed deadline", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const { db, fetch } = setup(mode, { timeoutMs: 10, headers: () => { now = 11; return { authorization: "owned" }; } });
    await expect(db.get(key("items", "a"))).rejects.toMatchObject({ reason: "deadline" }); expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects after a codec aborts or crosses elapsed time before delivery", async () => {
    for (const reason of ["caller", "deadline"] as const) {
      let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
      const caller = new AbortController(); const { db, fetch } = setup(mode, { timeoutMs: 10 }); fetch.mockResolvedValueOnce(reply(stored(mode)));
      const decode = vi.fn((value: unknown) => { if (reason === "caller") caller.abort("private-codec-cause"); else now = 11; return value; });
      await expect(db.getWithSignal(key("items", "a"), caller.signal, { encode: (value: unknown) => value, decode })).rejects.toMatchObject({ name: "QueryCancelledError", reason });
      expect(decode).toHaveBeenCalledTimes(1); vi.restoreAllMocks();
    }
  });

  it("cleans a late ignored fetch body once without waiting for cancel", async () => {
    const entered = deferred<undefined>(); const cleaned = deferred<undefined>(); const late = deferred<Response>(); const caller = new AbortController();
    const cancel = vi.fn(() => { cleaned.resolve(undefined); return new Promise<void>(() => undefined); });
    const { db, fetch } = setup(mode); fetch.mockImplementationOnce(() => { entered.resolve(undefined); return late.promise; });
    const outcome = expect(db.getWithSignal(key("items", "a"), caller.signal)).rejects.toMatchObject({ reason: "caller" });
    await entered.promise; caller.abort("private-fetch-cause"); await outcome; expect(signalOf(fetch).aborted).toBe(true);
    late.resolve(new Response(new ReadableStream<Uint8Array>({ cancel }))); await cleaned.promise; expect(cancel).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(reply(stored(mode))); await expect(db.get(key("items", "a"))).resolves.toMatchObject({ exists: true });
  });

  it("cancels an owned pending reader despite a rejecting cancel and releases lock", async () => {
    const entered = deferred<undefined>(); const caller = new AbortController();
    const cancel = vi.fn(() => Promise.reject(new Error("private-cancel-cause")));
    const body = new ReadableStream<Uint8Array>({ pull: () => { entered.resolve(undefined); return new Promise<void>(() => undefined); }, cancel }, { highWaterMark: 0 });
    const { db, fetch } = setup(mode); fetch.mockResolvedValueOnce(new Response(body));
    const outcome = expect(db.getWithSignal(key("items", "a"), caller.signal)).rejects.toMatchObject({ reason: "caller" });
    await entered.promise; expect(body.locked).toBe(true); caller.abort(); await outcome;
    expect(cancel).toHaveBeenCalledTimes(1); expect(body.locked).toBe(false);
  });

  it("cleans a successfully acquired reader when acquisition aborts or crosses deadline", async () => {
    for (const reason of ["caller", "deadline"] as const) {
      let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
      const caller = new AbortController(); const acquired = deferred<undefined>();
      const cancel = vi.fn(() => Promise.reject(new Error("private-reader-cleanup")));
      const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
      const ownedResponse = new Response(body);
      const nativeGetReader = body.getReader.bind(body);
      vi.spyOn(body, "getReader").mockImplementation(() => {
        const reader = nativeGetReader(); acquired.resolve(undefined);
        if (reason === "caller") caller.abort("private-acquire-cause"); else now = 11;
        return reader;
      });
      const { db, fetch } = setup(mode, { timeoutMs: 10 }); fetch.mockResolvedValueOnce(ownedResponse);
      const work = db.getWithSignal(key("items", "a"), caller.signal);
      const result = expect(work).rejects.toMatchObject({ name: "QueryCancelledError", reason });
      await acquired.promise; await result;
      await expect(work).rejects.not.toHaveProperty("cause"); await expect(work).rejects.not.toThrow("private-");
      expect(cancel).toHaveBeenCalledTimes(1); expect(body.locked).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it("keeps typed HTTP errors without pulling hostile error bodies", async () => {
    const pull = vi.fn(); const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const { db, fetch } = setup(mode); fetch.mockResolvedValueOnce(new Response(body, { status: 429 }));
    await expect(db.get(key("items", "a"))).rejects.toMatchObject({ name: "CouchDbHttpError", status: 429 });
    expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("redacts legacy and explicit-signal header/fetch/body/codec failures", async () => {
    const header = setup(mode, { headers: () => { throw new Error("private-header-token"); } });
    const network = setup(mode); network.fetch.mockRejectedValueOnce(new Error("private-fetch-token"));
    const body = setup(mode); body.fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private-body-token")); } })));
    const coded = setup(mode); coded.fetch.mockResolvedValueOnce(reply(stored(mode)));
    const codec: Codec<unknown> = { encode: (value) => value, decode: () => { throw new Error("private-codec-token"); } };
    await Promise.all([header.db.get(key("items", "a")), network.db.getWithSignal(key("items", "a"), new AbortController().signal), body.db.get(key("items", "a")), coded.db.get(key("items", "a"), codec)].map(async pending => {
      await expect(pending).rejects.toBeInstanceOf(CouchDbRequestError); await expect(pending).rejects.not.toHaveProperty("cause"); await expect(pending).rejects.not.toThrow("private-");
    }));
  });

  it("snapshots batch keys before header callbacks mutate the original array", async () => {
    const keys: Key[] = [key("items", "a"), key("items", "b")]; let changed = false;
    const { db, fetch } = setup(mode, { maxParallelReads: 1, headers: () => { if (!changed) { changed = true; keys[1] = key("items", "other"); } return {}; } });
    fetch.mockResolvedValueOnce(reply(stored(mode, "a"))).mockResolvedValueOnce(reply(stored(mode, "b")));
    const rows = await db.getMany(keys); expect(rows.map(row => row.key.id)).toEqual(["a", "b"]); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("charges shared batch bytes before retaining a second decoded result", async () => {
    const size = new TextEncoder().encode(JSON.stringify(stored(mode))).byteLength;
    const { db, fetch } = setup(mode, { maxParallelReads: 1, maxGetManyBytes: size * 2 - 1 });
    fetch.mockImplementation(() => Promise.resolve(reply(stored(mode))));
    const decode = vi.fn((value: unknown) => value);
    const outcome = db.getMany([key("items", "a"), key("items", "a"), key("items", "a")], { encode: (value: unknown) => value, decode });
    await expect(outcome).rejects.toBeInstanceOf(mode === "native" ? CouchDbBatchSizeError : RangeError);
    expect(fetch).toHaveBeenCalledTimes(2); expect(decode).toHaveBeenCalledTimes(1);
  });

  it("preserves first safe batch failure while aborting siblings and later keys", async () => {
    const entered = deferred<undefined>(); const denied = deferred<Response>(); const held = deferred<Response>(); const cleaned = deferred<undefined>();
    const { db, fetch } = setup(mode, { maxParallelReads: 2 });
    fetch.mockImplementationOnce(() => denied.promise).mockImplementationOnce(() => { entered.resolve(undefined); return held.promise; });
    const outcome = expect(db.getMany([key("items", "a"), key("items", "b"), key("items", "c")])).rejects.toBeInstanceOf(CouchDbHttpError);
    await entered.promise; denied.resolve(new Response(undefined, { status: 403 })); await outcome;
    expect(fetch).toHaveBeenCalledTimes(2); expect(signalOf(fetch, 1).aborted).toBe(true);
    const cancel = vi.fn(() => { cleaned.resolve(undefined); }); held.resolve(new Response(new ReadableStream<Uint8Array>({ cancel }))); await cleaned.promise;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("gives caller/deadline priority after cleanup abort listeners run", async () => {
    for (const reason of ["caller", "deadline"] as const) {
      let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now); const caller = new AbortController();
      const { db, fetch } = setup(mode, { timeoutMs: 10, headers: signal => { signal?.addEventListener("abort", () => { if (reason === "caller") caller.abort("private-cleanup"); else now = 11; }, { once: true }); return {}; } });
      fetch.mockResolvedValueOnce(new Response(undefined, { status: 403 }));
      await expect(db.getWithSignal(key("items", "a"), caller.signal)).rejects.toMatchObject({ name: "QueryCancelledError", reason });
      vi.restoreAllMocks();
    }
  });

  it("validates the entire page and bookmark before any codec invocation", async () => {
    const { db, fetch } = setup(mode); const decode = vi.fn((value: unknown) => value); const items = collection("items", { codec: { encode: (value: unknown) => value, decode } });
    fetch.mockResolvedValueOnce(reply({ docs: [stored(mode), stored(mode)], bookmark: "next" }));
    await expect(db.query(items.query().limit(2).build())).rejects.toThrow("duplicate"); expect(decode).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(reply({ docs: [stored(mode)], bookmark: "x".repeat(16_385) }));
    await expect(db.query(items.query().limit(1).build())).rejects.toThrow("bookmark"); expect(decode).not.toHaveBeenCalled();
  });

  it("refuses full and short empty-bookmark pages before codec delivery or retry", async () => {
    for (const limit of [1, 2]) {
      const { db, fetch } = setup(mode); const decode = vi.fn((value: unknown) => value);
      const items = collection("items", { codec: { encode: (value: unknown) => value, decode } });
      fetch.mockResolvedValueOnce(reply({ docs: [stored(mode)], bookmark: "" }));
      await expect(db.query(items.query().limit(limit).build())).rejects.toThrow("bookmark");
      expect(decode).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
      // A fresh explicit query is allowed; failure did not issue a handle or
      // silently restart pagination inside the refused operation.
      fetch.mockResolvedValueOnce(reply({ docs: [stored(mode)], bookmark: "owned-next" }));
      const page = await db.query(items.query().limit(1).build());
      expect(page.nextCursor).toBeDefined(); expect(fetch).toHaveBeenCalledTimes(2);
      fetch.mockResolvedValueOnce(reply({ docs: [] }));
      await db.query(items.query().limit(1).startAfter(...(page.nextCursor?.values ?? [])).build());
      expect(fetch.mock.calls[2]?.[1]?.body).toContain('"bookmark":"owned-next"');
      expect(fetch).toHaveBeenCalledTimes(3);
    }
  });

  it("refuses a full resumed page whose bookmark does not advance before decoding", async () => {
    const { db, fetch } = setup(mode); const items = collection("items");
    fetch.mockResolvedValueOnce(reply({ docs: [stored(mode)], bookmark: "first-bookmark" }));
    const first = await db.query(items.query().limit(1).build()); const original = first.nextCursor?.values ?? []; expect(original).toHaveLength(1);
    const decode = vi.fn((value: unknown) => value);
    const coded = collection("items", { codec: { encode: (value: unknown) => value, decode } });
    fetch.mockResolvedValueOnce(reply({ docs: [stored(mode, "b")], bookmark: "first-bookmark" }));
    await expect(db.query(coded.query().limit(1).startAfter(...original).build())).rejects.toThrow("did not advance");
    expect(decode).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(2);
    // Refusal did not consume the native prior handle or return a successor.
    // Retrying that exact prior handle with actual server progress must work.
    fetch.mockResolvedValueOnce(reply({ docs: [stored(mode, "b")], bookmark: "second-bookmark" }));
    const progress = await db.query(coded.query().limit(1).startAfter(...original).build());
    expect(progress.records).toMatchObject([{ key: key("items", "b") }]); expect(progress.nextCursor).toBeDefined(); expect(decode).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(reply({ docs: [], bookmark: "second-bookmark" }));
    await expect(db.query(coded.query().limit(1).startAfter(...(progress.nextCursor?.values ?? [])).build())).resolves.toMatchObject({ records: [] });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("refuses closed JSON depth/accessors before credentials and dispatch", async () => {
    const get = vi.fn(() => "private-value"); const hostile = Object.defineProperty({}, "value", { enumerable: true, get });
    let deep: unknown = {}; for (let i = 0; i < 34; i++) deep = { next: deep };
    const { db, fetch, headers } = setup(mode); const items = collection("items");
    // Managed filters accept plain JSON objects; native scalar filters refuse
    // them earlier. Neither path may invoke the supplied getter or issue I/O.
    for (const value of [hostile, deep]) await expect(db.query(items.query().where("title", "==", value).build())).rejects.toThrow();
    expect(get).not.toHaveBeenCalled(); expect(headers).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});

it("does not consume a native cursor or issue its successor after codec cancellation", async () => {
  const { db, fetch } = setup("native"); const items = collection("items");
  fetch.mockResolvedValueOnce(reply({ docs: [stored("native")], bookmark: "first" }));
  const first = await db.query(items.query().limit(1).build()); const values = first.nextCursor?.values ?? []; expect(values).toHaveLength(1);
  const caller = new AbortController(); const coded = collection("items", { codec: { encode: (value: unknown) => value, decode: (value: unknown) => { caller.abort("private-codec"); return value; } } });
  fetch.mockResolvedValueOnce(reply({ docs: [stored("native", "b")], bookmark: "second" }));
  await expect(db.queryWithSignal(coded.query().limit(1).startAfter(...values).build(), caller.signal)).rejects.toMatchObject({ reason: "caller" });
  fetch.mockResolvedValueOnce(reply({ docs: [stored("native", "b")], bookmark: "second" }));
  await expect(db.query(items.query().limit(1).startAfter(...values).build())).resolves.toMatchObject({ records: [{ key: key("items", "b") }] });
  await expect(db.query(items.query().limit(1).startAfter(...values).build())).rejects.toThrow("already been used"); expect(fetch).toHaveBeenCalledTimes(3);
});

it("binds managed bookmarks to the instance, exact query and page size", async () => {
  const { db, fetch } = setup("managed"); const items = collection("items"); const q = () => items.query().where("done", "==", false).limit(1);
  fetch.mockResolvedValueOnce(reply({ docs: [stored("managed")], bookmark: "owned-next" }));
  const first = await db.query(q().build()); const values = first.nextCursor?.values ?? [];
  await expect(db.query(items.query().where("done", "==", true).limit(1).startAfter(...values).build())).rejects.toThrow("for this query");
  await expect(db.query(q().limit(2).startAfter(...values).build())).rejects.toThrow("for this query");
  await expect(setup("managed").db.query(q().startAfter(...values).build())).rejects.toThrow("for this query");
  await expect(db.query(q().startAfter(structuredClone(values[0])).build())).rejects.toThrow("for this query");
  expect(fetch).toHaveBeenCalledTimes(1); fetch.mockResolvedValueOnce(reply({ docs: [] }));
  await db.query(q().startAfter(...values).build()); expect(fetch.mock.calls[1]?.[1]?.body).toContain('"bookmark":"owned-next"');
});

it("snapshots native metadata before an in-place codec transforms document identity", async () => {
  const { db, fetch } = setup("native");
  const codec: Codec<object> = {
    encode: (value) => value,
    decode: (value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture requires a native object");
      Object.defineProperty(value, "_id", { value: "transformed-data-id", enumerable: true, configurable: true, writable: true });
      Reflect.deleteProperty(value, "_rev");
      return value;
    },
  };
  fetch.mockResolvedValueOnce(reply(stored("native")));
  const point = await db.get(key("items", "a"), codec);
  expect(point).toMatchObject({ key: key("items", "a"), exists: true, data: { _id: "transformed-data-id" }, metadata: { id: "a", revision: "1-owned" } });
  expect(point).not.toHaveProperty("data._rev");
  fetch.mockResolvedValueOnce(reply({ docs: [stored("native")], bookmark: "owned-next" }));
  const page = await db.query(collection("items", { codec }).query().limit(1).build());
  expect(page.records).toMatchObject([{ key: key("items", "a"), exists: true, data: { _id: "transformed-data-id" }, metadata: { id: "a", revision: "1-owned" } }]);
  expect(page.records[0]).not.toHaveProperty("data._rev");
});
