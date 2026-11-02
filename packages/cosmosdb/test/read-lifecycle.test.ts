import { collection, identityCodec, key, type Codec, type Key } from "@dalgo/core";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CosmosHttpError, CosmosNoSqlDatabase, CosmosTransportError, type CosmosNoSqlOptions } from "../src/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function document(id = "a", data: Record<string, unknown> = { n: 1 }): Record<string, unknown> {
  return { id: btoa(JSON.stringify(id)).replace(/=/gu, ""), __dalgo_collection: "items", __dalgo_id: id, data };
}
function response(body: unknown, headers?: HeadersInit): Response { return new Response(JSON.stringify(body), { status: 200, ...(headers === undefined ? {} : { headers }) }); }
function setup(change: Partial<CosmosNoSqlOptions> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const authorization = vi.fn(() => "owned-resource-token");
  const database = new CosmosNoSqlDatabase({ endpoint: "https://example.documents.azure.com", databaseId: "app", containerId: "records", authorization, fetch, ...change });
  return { database, fetch, authorization };
}
function signalFor(fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, index = 0): AbortSignal {
  const signal = fetch.mock.calls[index]?.[1]?.signal;
  if (signal == null) throw new Error("fixture did not receive operation signal");
  return signal;
}
function query() { return collection<{ n: number }>("items").query().where("n", ">=", 1).limit(2); }

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Cosmos whole-operation lifecycle", () => {
  it("refuses pre-abort before partition, token or fetch", async () => {
    const partitionKey = vi.fn(() => "items");
    const { database, fetch, authorization } = setup({ partitionKey });
    const caller = new AbortController(); caller.abort("private-caller-token");
    await expect(database.getWithSignal(key("items", "a"), caller.signal)).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    await expect(database.getManyWithSignal([key("items", "a")], caller.signal)).rejects.toBeInstanceOf(QueryCancelledError);
    await expect(database.queryWithSignal(query().build(), caller.signal)).rejects.toBeInstanceOf(QueryCancelledError);
    expect(partitionKey).not.toHaveBeenCalled(); expect(authorization).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it("starts deadline before authorization and observes its late rejection", async () => {
    vi.useFakeTimers();
    const entered = deferred<undefined>(); const token = deferred<string>();
    const { database, fetch } = setup({ timeoutMs: 10, authorization: (request) => { expect(request.signal.aborted).toBe(false); entered.resolve(undefined); return token.promise; } });
    const outcome = expect(database.get(key("items", "a"))).rejects.toMatchObject({ name: "QueryCancelledError", reason: "deadline" });
    await entered.promise; await vi.advanceTimersByTimeAsync(10); await outcome;
    token.reject(new Error("private-late-authorization"));
    await Promise.resolve(undefined); expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels authorization waiting using the caller signal without forwarding reason", async () => {
    const entered = deferred<undefined>(); const token = deferred<string>(); const caller = new AbortController();
    const { database, fetch } = setup({ authorization: (request) => { entered.resolve(undefined); expect(request.signal.aborted).toBe(false); return token.promise; } });
    const outcome = expect(database.getWithSignal(key("items", "a"), caller.signal)).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    await entered.promise; caller.abort(new Error("private-caller-detail")); await outcome;
    token.resolve("late-token"); await Promise.resolve(undefined); expect(fetch).not.toHaveBeenCalled();
  });

  it("cleans an ignored fetch's late body once and can read again", async () => {
    const entered = deferred<undefined>(); const late = deferred<Response>(); const caller = new AbortController();
    const cleaned = deferred<undefined>();
    const cancel = vi.fn(() => { cleaned.resolve(undefined); return Promise.reject(new Error("private-cancel-detail")); });
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { database, fetch } = setup();
    fetch.mockImplementationOnce(() => { entered.resolve(undefined); return late.promise; });
    const outcome = expect(database.getWithSignal(key("items", "a"), caller.signal)).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    await entered.promise; caller.abort(); await outcome; expect(signalFor(fetch).aborted).toBe(true);
    late.resolve(new Response(body)); await cleaned.promise;
    expect(cancel).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(response(document()));
    await expect(database.get(key("items", "a"))).resolves.toMatchObject({ exists: true, data: { n: 1 } });
  });

  it("observes a rejected ignored fetch after deadline without raw causes", async () => {
    vi.useFakeTimers(); const entered = deferred<undefined>(); const late = deferred<Response>();
    const { database, fetch } = setup({ timeoutMs: 10 });
    fetch.mockImplementationOnce(() => { entered.resolve(undefined); return late.promise; });
    const result = expect(database.get(key("items", "a"))).rejects.toMatchObject({ name: "QueryCancelledError", reason: "deadline" });
    await entered.promise; await vi.advanceTimersByTimeAsync(10); await result;
    late.reject(new Error("private-fetch-token")); await Promise.resolve(undefined); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not await a hostile reader cancel and releases its lock", async () => {
    const reading = deferred<undefined>(); const caller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ pull: () => { reading.resolve(undefined); return new Promise<void>(() => undefined); }, cancel }, { highWaterMark: 0 });
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(new Response(body));
    const result = expect(database.getWithSignal(key("items", "a"), caller.signal)).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    await reading.promise; caller.abort(); await result;
    expect(cancel).toHaveBeenCalledTimes(1); expect(body.locked).toBe(false);
  });

  it("returns a budget error despite rejecting unused-body cancellation", async () => {
    const cancel = vi.fn(() => Promise.reject(new Error("private-cleanup-detail")));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { database, fetch } = setup({ maxResponseBytes: 20 });
    fetch.mockResolvedValueOnce(new Response(body, { headers: { "content-length": "21" } }));
    await expect(database.get(key("items", "a"))).rejects.toThrow("maxResponseBytes");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects HTTP status without pulling a hostile provider body", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(new Response(body, { status: 429, headers: { "x-ms-retry-after-ms": "25" } }));
    await expect(database.get(key("items", "a"))).rejects.toMatchObject({ name: "CosmosHttpError", status: 429, retryAfterMs: 25 });
    expect(cancel).toHaveBeenCalledTimes(1); expect(pull).not.toHaveBeenCalled();
  });

  it("checks caller cancellation triggered by unused-body cleanup before missing delivery", async () => {
    const caller = new AbortController(); const cleaned = deferred<undefined>();
    const body = new ReadableStream<Uint8Array>({ cancel() { caller.abort("private-cleanup-reason"); cleaned.resolve(undefined); } });
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(new Response(body, { status: 404 }));
    await expect(database.getWithSignal(key("items", "a"), caller.signal)).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    await cleaned.promise;
  });

  it("redacts authorization, fetch, body and codec failures", async () => {
    const secret = "private-provider-token";
    const auth = setup({ authorization: () => { throw new Error(secret); } });
    const network = setup(); network.fetch.mockRejectedValueOnce(new Error(secret));
    const body = setup(); body.fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(secret)); } })));
    const codec = setup(); codec.fetch.mockResolvedValueOnce(response(document()));
    const failedCodec: Codec<unknown> = { encode: (value: unknown) => identityCodec.encode(value), decode: () => { throw new Error(secret); } };
    await Promise.all([auth.database.get(key("items", "a")), network.database.get(key("items", "a")), body.database.get(key("items", "a")), codec.database.get(key("items", "a"), failedCodec)].map(async (pending) => {
      await expect(pending).rejects.toBeInstanceOf(CosmosTransportError);
      await expect(pending).rejects.not.toHaveProperty("cause");
      await expect(pending).rejects.not.toThrow(secret);
    }));
  });

  it("checks caller cancellation and elapsed time after synchronous codec work", async () => {
    for (const mode of ["caller", "deadline"] as const) {
      let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
      const caller = new AbortController(); const { database, fetch } = setup({ timeoutMs: 10 }); fetch.mockResolvedValueOnce(response(document()));
      const decode = vi.fn(() => { if (mode === "caller") caller.abort("private-codec"); else now = 11; return { n: 1 }; });
      await expect(database.getWithSignal(key("items", "a"), caller.signal, { encode: (value: { n: number }) => value, decode })).rejects.toMatchObject({ name: "QueryCancelledError", reason: mode });
      expect(decode).toHaveBeenCalledTimes(1); vi.restoreAllMocks();
    }
  });

  it("prevents dispatch when synchronous authorization crosses the monotonic deadline", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const { database, fetch } = setup({ timeoutMs: 10, authorization: () => { now = 11; return "owned-token"; } });
    await expect(database.get(key("items", "a"))).rejects.toMatchObject({ name: "QueryCancelledError", reason: "deadline" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("copies the admitted batch and stops siblings and later batches after failure", async () => {
    const entered = deferred<undefined>(); const sibling = deferred<Response>(); const { database, fetch } = setup({ maxParallelReads: 2 });
    fetch.mockResolvedValueOnce(response(document("a")));
    fetch.mockImplementationOnce(() => { entered.resolve(undefined); return sibling.promise; });
    const keys: Key[] = [key("items", "a"), key("items", "b"), key("items", "c")];
    const pending = database.getMany(keys); await entered.promise; keys[2] = key("items", "changed");
    sibling.resolve(response(document("b"))); fetch.mockResolvedValueOnce(response(document("c")));
    await expect(pending).resolves.toMatchObject([{ key: key("items", "a") }, { key: key("items", "b") }, { key: key("items", "c") }]);
    expect(fetch.mock.calls[2]?.[0]).toBe("https://example.documents.azure.com/dbs/app/colls/records/docs/ImMi");

    const secondEntered = deferred<undefined>(); const denied = deferred<Response>(); const held = deferred<Response>(); const stopped = setup({ maxParallelReads: 2 });
    stopped.fetch.mockImplementationOnce(() => denied.promise);
    stopped.fetch.mockImplementationOnce(() => { secondEntered.resolve(undefined); return held.promise; });
    const refused = expect(stopped.database.getMany([key("items", "a"), key("items", "b"), key("items", "c")])).rejects.toBeInstanceOf(CosmosHttpError);
    await secondEntered.promise; denied.resolve(new Response(undefined, { status: 403 })); await refused;
    expect(stopped.fetch).toHaveBeenCalledTimes(2); expect(signalFor(stopped.fetch, 1).aborted).toBe(true);
    const cleaned = deferred<undefined>(); const cancel = vi.fn(() => { cleaned.resolve(undefined); }); held.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await cleaned.promise; expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("prioritizes caller or elapsed deadline during single and batch failure cleanup", async () => {
    for (const shape of ["single", "batch"] as const) {
      for (const mode of ["caller", "deadline"] as const) {
        let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
        const caller = new AbortController(); const entered = deferred<undefined>(); const denied = deferred<Response>(); const late = deferred<Response>();
        const { database, fetch } = setup({ timeoutMs: 10, maxParallelReads: 2 });
        const observeCleanup = (init: RequestInit | undefined): void => {
          if (init?.signal == null) throw new Error("owned fixture requires the operation signal");
          init.signal.addEventListener("abort", () => { if (mode === "caller") caller.abort("private-cleanup-cause"); else now = 11; }, { once: true });
          entered.resolve(undefined);
        };
        fetch.mockImplementationOnce((_url, init) => { if (shape === "single") observeCleanup(init); return denied.promise; });
        if (shape === "batch") fetch.mockImplementationOnce((_url, init) => { observeCleanup(init); return late.promise; });
        const work = shape === "single"
          ? database.getWithSignal(key("items", "a"), caller.signal)
          : database.getManyWithSignal([key("items", "a"), key("items", "b"), key("items", "c")], caller.signal);
        const result = expect(work).rejects.toMatchObject({ name: "QueryCancelledError", reason: mode });
        await entered.promise; denied.resolve(new Response(undefined, { status: 403 })); await result;
        expect(fetch).toHaveBeenCalledTimes(shape === "single" ? 1 : 2); expect(signalFor(fetch, shape === "single" ? 0 : 1).aborted).toBe(true);
        late.resolve(new Response()); vi.restoreAllMocks();
      }
    }
  });

  it("applies aggregate response bytes and one deadline across batch requests", async () => {
    const full = JSON.stringify(document()); const { database, fetch } = setup({ maxParallelReads: 1, maxResponseBytes: new TextEncoder().encode(full).length * 2 - 1 });
    fetch.mockImplementation(() => Promise.resolve(response(document())));
    await expect(database.getMany([key("items", "a"), key("items", "a"), key("items", "a")])).rejects.toThrow("maxResponseBytes");
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.useFakeTimers(); const started = deferred<undefined>(); const secondStarted = deferred<undefined>(); const first = deferred<Response>(); const second = deferred<Response>(); const batch = setup({ timeoutMs: 10, maxParallelReads: 1 });
    batch.fetch.mockImplementationOnce(() => { started.resolve(undefined); return first.promise; });
    batch.fetch.mockImplementationOnce(() => { secondStarted.resolve(undefined); return second.promise; });
    const outcome = expect(batch.database.getMany([key("items", "a"), key("items", "b")])).rejects.toMatchObject({ reason: "deadline" });
    await started.promise; await vi.advanceTimersByTimeAsync(8); first.resolve(response(document()));
    await secondStarted.promise; await vi.advanceTimersByTimeAsync(2); await outcome;
    expect(batch.fetch).toHaveBeenCalledTimes(2); expect(signalFor(batch.fetch, 1).aborted).toBe(true);
    second.resolve(response(document("b")));
  });

  it("binds opaque continuation to its exact query, partition and instance", async () => {
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(response({ Documents: [] }, { "x-ms-continuation": "opaque-next" }));
    const page = await database.query(query().build()); expect(page.nextCursor).toBeDefined();
    const values = page.nextCursor?.values ?? [];
    await expect(database.query(collection<{ n: number }>("items").query().where("n", ">=", 2).limit(2).startAfter(...values).build())).rejects.toThrow("this query and partition");
    await expect(database.query(query().limit(1).startAfter(...values).build())).rejects.toThrow("this query and partition");
    const other = setup(); await expect(other.database.query(query().startAfter(...values).build())).rejects.toThrow("this query and partition"); expect(other.fetch).not.toHaveBeenCalled();
    let partition = "first"; const mapped = setup({ partitionKey: () => partition }); mapped.fetch.mockResolvedValueOnce(response({ Documents: [] }, { "x-ms-continuation": "owned-next" }));
    const owned = await mapped.database.query(query().build()); partition = "second";
    await expect(mapped.database.query(query().startAfter(...(owned.nextCursor?.values ?? [])).build())).rejects.toThrow("this query and partition"); expect(mapped.fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(response({ Documents: [] })); await database.query(query().startAfter(...values).build());
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ "x-ms-continuation": "opaque-next" }); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects overreturned, duplicate or foreign managed pages before codec delivery", async () => {
    for (const documents of [[document(), document("b"), document("c")], [document(), document()], [{ ...document(), __dalgo_collection: "foreign" }], [{ ...document(), __dalgo_partition: "foreign" }]]) {
      const decode = vi.fn((value: unknown) => value); const items = collection("items", { codec: { encode: (value: unknown) => identityCodec.encode(value), decode } });
      const { database, fetch } = setup(); fetch.mockResolvedValueOnce(response({ Documents: documents }));
      await expect(database.query(items.query().limit(2).build())).rejects.toThrow(); expect(decode).not.toHaveBeenCalled();
    }
  });

  it("bounds continuation and response headers before returning a page", async () => {
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(response({ Documents: [] }, { "x-ms-continuation": "x".repeat(16_385) }));
    await expect(database.query(query().build())).rejects.toThrow("continuation");
    fetch.mockResolvedValueOnce(response({ Documents: [], _count: 1 }));
    await expect(database.query(query().build())).rejects.toThrow("count");
    fetch.mockResolvedValueOnce(response(document(), { "x-owned-large": "x".repeat(65_537) }));
    await expect(database.get(key("items", "a"))).rejects.toThrow("headers");
  });

  it("refuses accessors, sparse/custom arrays and deep structures without calling user getters", async () => {
    const get = vi.fn(() => "private-getter"); const object = Object.defineProperty({}, "secret", { enumerable: true, get });
    const sparse = new Array<unknown>(2); sparse[0] = 1;
    let deep: unknown = {}; for (let i = 0; i < 34; i++) deep = { next: deep };
    const { database, fetch, authorization } = setup();
    for (const data of [object, { sparse }, { deep }]) await expect(database.set(key("items", "a"), data)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled(); expect(authorization).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    await expect(database.get(key("items", "x".repeat(4097)))).rejects.toThrow("key"); expect(fetch).not.toHaveBeenCalled();
  });
});
