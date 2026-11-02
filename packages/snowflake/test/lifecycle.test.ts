import { collection, identityCodec, type Codec, type Key } from "@dalgo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnowflakeDatabase, SnowflakeError, type SnowflakeOptions } from "../src/index.js";

const endpoint = "https://owned.snowflakecomputing.com";
const statementHandle = "536fad38-b564-4dc5-9892-a4543504df6c";
const otherHandle = "636fad38-b564-4dc5-9892-a4543504df6c";
const users = collection<Record<string, string | null>>("users");
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("not initialized"); };
  let reject: (error: unknown) => void = () => { throw new Error("not initialized"); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function payload(id = "a", name: string | null = "Ada") {
  return { statementHandle, resultSetMetaData: { numRows: 1, rowType: [{ name: "ID" }, { name: "NAME" }], partitionInfo: [{ rowCount: 1 }] }, data: [[id, name]] };
}
function response(body: unknown = payload(), status = 200): Response { return new Response(JSON.stringify(body), { status }); }
function setup(options: Partial<SnowflakeOptions> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response()));
  const token = vi.fn(() => "owned-submit-token");
  const database = new SnowflakeDatabase({ endpoint, database: "DB", schema: "PUBLIC", tables: { users: { table: "USERS", idColumn: "ID" } }, pollIntervalMs: 0, fetch, token, ...options });
  return { database, fetch, token };
}
function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("fixture requires JSON body");
  return JSON.parse(init.body) as Record<string, unknown>;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("whole Snowflake read lifecycle", () => {
  it("refuses genuine preabort before copying, credentials or HTTP despite shadow properties", async () => {
    const caller = new AbortController(); const getter = vi.fn(() => { throw new Error("PRIVATE_SIGNAL"); });
    Object.defineProperty(caller.signal, "aborted", { get: getter }); caller.abort("PRIVATE_REASON");
    const { database, token, fetch } = setup();
    await expect(database.getWithSignal(users.key("a"), caller.signal)).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    expect(getter).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); database.close();
  });
  it("retains an ignored credential's physical slot until settlement, then reopens", async () => {
    const entered = deferred<undefined>(); const credential = deferred<string>(); const caller = new AbortController(); let ordinary = false;
    const { database, fetch } = setup({ maxConcurrent: 1, token: () => { if (ordinary) return "owned"; entered.resolve(undefined); return credential.promise; } });
    const failed = expect(database.getWithSignal(users.key("a"), caller.signal)).rejects.toMatchObject({ reason: "caller" });
    await entered.promise; caller.abort(); await failed;
    await expect(database.get(users.key("a"))).rejects.toThrow("busy"); expect(fetch).not.toHaveBeenCalled();
    ordinary = true; credential.resolve("late"); await vi.waitFor(async () => { expect((await database.get(users.key("a"))).exists).toBe(true); }); database.close();
  });
  it("owns a late response body and retains hostile cancellation until actual settlement", async () => {
    const entered = deferred<undefined>(); const late = deferred<Response>(); const cleaned = deferred<undefined>(); const cleanup = deferred<undefined>(); const caller = new AbortController();
    const cancel = vi.fn(() => { cleaned.resolve(undefined); return cleanup.promise; });
    const { database, fetch } = setup({ maxConcurrent: 1 }); fetch.mockImplementationOnce(() => { entered.resolve(undefined); return late.promise; });
    const outcome = expect(database.getWithSignal(users.key("a"), caller.signal)).rejects.toMatchObject({ reason: "caller" });
    await entered.promise; caller.abort(); await outcome; late.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await cleaned.promise; expect(cancel).toHaveBeenCalledTimes(1); await expect(database.get(users.key("a"))).rejects.toThrow("busy");
    cleanup.resolve(undefined); await vi.waitFor(async () => { expect((await database.get(users.key("a"))).exists).toBe(true); }); database.close();
  });
  it("uses intrinsic owned signal state during a borrowed fetch's late fulfillment", async () => {
    const caller = new AbortController(); const getter = vi.fn(() => { throw new Error("PRIVATE_OWNED_SIGNAL"); }); const cancelled = deferred<undefined>();
    Object.defineProperty(caller.signal, "aborted", { value: false });
    const cancel = vi.fn(() => { cancelled.resolve(undefined); }); const { database, fetch } = setup();
    fetch.mockImplementationOnce((_url, init) => {
      if (init?.signal == null) throw new Error("fixture requires signal");
      Object.defineProperty(init.signal, "aborted", { get: getter }); caller.abort();
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    });
    await expect(database.getWithSignal(users.key("a"), caller.signal)).rejects.toMatchObject({ reason: "caller" });
    await cancelled.promise; expect(cancel).toHaveBeenCalledTimes(1); expect(getter).not.toHaveBeenCalled(); database.close();
  });
  it("bounds a dispatched native stream deadline and releases its actual reader", async () => {
    vi.useFakeTimers(); const acquired = deferred<undefined>(); const pulled = deferred<undefined>(); const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull() { pulled.resolve(undefined); }, cancel }); const owned = new Response(body);
    const getReader = body.getReader.bind(body);
    vi.spyOn(body, "getReader").mockImplementation(() => { const reader = getReader(); acquired.resolve(undefined); return reader; });
    const { database, fetch } = setup({ timeoutMs: 10 }); fetch.mockResolvedValueOnce(owned);
    const outcome = expect(database.get(users.key("a"))).rejects.toMatchObject({ reason: "deadline" });
    await acquired.promise; await pulled.promise; expect(body.locked).toBe(true); await vi.advanceTimersByTimeAsync(10); await outcome;
    expect(cancel).toHaveBeenCalledTimes(1); expect(body.locked).toBe(false); database.close();
  });
  it("owns the acquired reader before getReader revokes caller authority", async () => {
    const caller = new AbortController(); const cancel = vi.fn(); const body = new ReadableStream<Uint8Array>({ cancel }); const owned = new Response(body);
    const getReader = body.getReader.bind(body); vi.spyOn(body, "getReader").mockImplementation(() => { const reader = getReader(); caller.abort(); return reader; });
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(owned);
    await expect(database.getWithSignal(users.key("a"), caller.signal)).rejects.toMatchObject({ reason: "caller" });
    expect(cancel).toHaveBeenCalledTimes(1); expect(body.locked).toBe(false); database.close();
  });
  it("guards after EOF reader-release callbacks and preserves original caller classification", async () => {
    const caller = new AbortController(); const owned = response(); const body = owned.body; if (body === null) throw new Error("fixture requires body");
    const getReader = body.getReader.bind(body); vi.spyOn(body, "getReader").mockImplementation(() => {
      const reader = getReader(); const release = reader.releaseLock.bind(reader);
      vi.spyOn(reader, "releaseLock").mockImplementation(() => { release(); caller.abort(); throw new Error("PRIVATE_RELEASE"); }); return reader;
    });
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(owned);
    await expect(database.getWithSignal(users.key("a"), caller.signal)).rejects.toMatchObject({ reason: "caller" });
    expect(body.locked).toBe(false); database.close();
  });
  it("keeps one monotonic budget through synchronous credentials and final codecs", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const first = setup({ timeoutMs: 10, token: () => { now = 10; return "owned"; } });
    await expect(first.database.get(users.key("a"))).rejects.toMatchObject({ reason: "deadline" }); expect(first.fetch).not.toHaveBeenCalled(); first.database.close();
    now = 0; const second = setup({ timeoutMs: 10 }); const codec: Codec<unknown> = { ...identityCodec, decode: value => { now = 10; return value; } };
    await expect(second.database.get(users.key("a"), codec)).rejects.toMatchObject({ reason: "deadline" }); second.database.close();
  });
  it("refreshes positive server timeout from the original remaining budget after credentials", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const { database, fetch } = setup({ timeoutMs: 10_000, token: () => { now = 9_001; return "owned"; } });
    expect((await database.get(users.key("a"))).exists).toBe(true); expect(requestBody(fetch.mock.calls[0]?.[1]).timeout).toBe(1); database.close();
  });
  it("copies the admitted batch before credentials mutate later keys and append work", async () => {
    const keys: Key[] = [users.key("a"), users.key("b")]; let call = 0;
    const { database, fetch } = setup({ token: () => { keys[1] = users.key("changed"); keys.push(users.key("extra")); return "owned"; } });
    fetch.mockImplementation(() => Promise.resolve(response(payload(++call === 1 ? "a" : "b"))));
    expect((await database.getMany(keys)).map(record => record.key.id)).toEqual(["a", "b"]); expect(fetch).toHaveBeenCalledTimes(2);
    expect(requestBody(fetch.mock.calls[1]?.[1]).bindings).toEqual({ "1": { type: "TEXT", value: "b" } }); database.close();
  });
  it("withholds a batch prefix and stops later statements at the aggregate byte cap", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(payload())).length;
    const { database, fetch } = setup({ maxResponseBytes: bytes + 1 });
    await expect(database.getMany([users.key("a"), users.key("a"), users.key("a")])).rejects.toThrow("response budget"); expect(fetch).toHaveBeenCalledTimes(2); database.close();
  });
  it("freshly fences final codec abort/Close and redacts forged public errors", async () => {
    for (const close of [false, true]) {
      const caller = new AbortController(); const { database } = setup(); const codec: Codec<unknown> = { ...identityCodec, decode: value => { if (close) database.close(); else caller.abort(); return value; } };
      await expect(database.getWithSignal(users.key("a"), caller.signal, codec)).rejects.toMatchObject(close ? { message: "Snowflake adapter closed" } : { reason: "caller" }); database.close();
    }
    const { database, fetch } = setup(); const forged = new SnowflakeError("PRIVATE_TOKEN", 403); fetch.mockRejectedValueOnce(forged);
    await expect(database.get(users.key("a"))).rejects.not.toThrow("PRIVATE"); database.close();
  });
  it("charges repeated escaped query bindings before any credential or HTTP work", async () => {
    const { database, token, fetch } = setup({ maxRequestBytes: 1024 }); const shared = "\u0000".repeat(100);
    await expect(database.query(users.query().where("NAME", "in", [shared, shared]).build())).rejects.toThrow("request budget");
    expect(token).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); database.close();
  });
  it("refuses caller array iterators and accessors without invoking them", async () => {
    const iterator = vi.fn(function* () { yield users.key("a"); }); const keys = [users.key("a")]; Object.defineProperty(keys, Symbol.iterator, { value: iterator });
    const { database, token } = setup(); await expect(database.getMany(keys)).rejects.toThrow(); expect(iterator).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled(); database.close();
  });
});

describe("Snowflake protocol and remote cancellation boundaries", () => {
  it("preserves every native JSONv2 cell as its original string/null", async () => {
    const native = ["9223372036854775807", "1.230000000000000001", "1e+99", "2026-11-02 01:02:03.123456789", "00ff80", '{"wide":9223372036854775807}', "null", "", null];
    const rowType = [{ name: "ID" }, ...native.map((_cell, i) => ({ name: `C${i}` }))];
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(response({ statementHandle, resultSetMetaData: { numRows: 1, rowType, partitionInfo: [{ rowCount: 1 }] }, data: [["a", ...native]] }));
    const found = await database.get<Record<string, string | null>>(users.key("a")); expect(native.map((_cell, i) => found.data?.[`C${i}`])).toEqual(native); database.close();
  });
  it("allows bounded empty physical partitions without inventing a row-count partition cap", async () => {
    const { database, fetch } = setup(); const first = payload(); first.resultSetMetaData.partitionInfo = [{ rowCount: 0 }, { rowCount: 1 }]; first.data = [];
    fetch.mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response({ data: [["a", "Ada"]] }));
    expect((await database.get(users.key("a"))).exists).toBe(true); expect(fetch.mock.calls[1]?.[0]).toBe(`${endpoint}/api/v2/statements/${statementHandle}?partition=1`); database.close();
  });
  it("binds every polled/final/partition handle to the initial owned statement", async () => {
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(response({ statementHandle }, 202)).mockResolvedValueOnce(response({ ...payload(), statementHandle: otherHandle })).mockResolvedValueOnce(response({ statementHandle }));
    await expect(database.get(users.key("a"))).rejects.toThrow("Mismatched");
    await vi.waitFor(() => { expect(fetch.mock.calls.filter(call => typeof call[0] === "string" && call[0].endsWith("/cancel"))).toHaveLength(1); });
    expect(fetch.mock.calls.some(call => typeof call[0] === "string" && call[0].includes(otherHandle))).toBe(false); database.close();
  });
  it("cancels only a known pending handle, once, with the captured submit credential", async () => {
    const caller = new AbortController(); const dispatched = deferred<undefined>(); const cancelled = deferred<undefined>(); const cancelDone = deferred<Response>(); let tokens = 0;
    const { database, fetch } = setup({ maxConcurrent: 1, token: () => ++tokens === 1 ? "submit-authority" : "rotated-poll-authority" });
    fetch.mockImplementation((url, init) => {
      if (url === `${endpoint}/api/v2/statements`) return Promise.resolve(response({ statementHandle }, 202));
      if (url === `${endpoint}/api/v2/statements/${statementHandle}/cancel`) { expect(init?.method).toBe("POST"); expect(init?.headers).toMatchObject({ Authorization: "Bearer submit-authority" }); cancelled.resolve(undefined); return cancelDone.promise; }
      dispatched.resolve(undefined); return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => { reject(new Error("owned abort")); }, { once: true }); });
    });
    const outcome = expect(database.getWithSignal(users.key("a"), caller.signal)).rejects.toMatchObject({ reason: "caller" });
    await dispatched.promise; caller.abort(); await outcome; await cancelled.promise;
    await expect(database.get(users.key("a"))).rejects.toThrow("busy"); expect(tokens).toBe(2);
    cancelDone.resolve(response({ statementHandle })); fetch.mockImplementation(() => Promise.resolve(response()));
    await vi.waitFor(async () => { expect((await database.get(users.key("a"))).exists).toBe(true); }); database.close();
  });
  it("attempts owned-handle cancel after poll exhaustion but never retries a submission", async () => {
    const { database, fetch } = setup({ maxPolls: 1 });
    fetch.mockResolvedValueOnce(response({ statementHandle }, 202)).mockResolvedValueOnce(response({ statementHandle }, 429)).mockResolvedValueOnce(response({ statementHandle }));
    await expect(database.get(users.key("a"))).rejects.toThrow("polling limit");
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(3); });
    expect(fetch.mock.calls.map(call => call[0])).toEqual([`${endpoint}/api/v2/statements`, `${endpoint}/api/v2/statements/${statementHandle}`, `${endpoint}/api/v2/statements/${statementHandle}/cancel`]); database.close();
  });
  it("starts separate owned cancel cleanup after a dispatched deadline or Close", async () => {
    for (const close of [false, true]) {
      vi.useFakeTimers(); const dispatched = deferred<undefined>(); const cancelled = deferred<undefined>();
      const { database, fetch } = setup({ timeoutMs: 10 });
      fetch.mockImplementation((url, init) => {
        if (url === `${endpoint}/api/v2/statements`) return Promise.resolve(response({ statementHandle }, 202));
        if (url === `${endpoint}/api/v2/statements/${statementHandle}/cancel`) { expect(init?.signal?.aborted).toBe(false); cancelled.resolve(undefined); return Promise.resolve(response({ statementHandle })); }
        dispatched.resolve(undefined); return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => { reject(new Error("owned abort")); }, { once: true }); });
      });
      const outcome = expect(database.get(users.key("a"))).rejects.toMatchObject(close ? { message: "Snowflake adapter closed" } : { reason: "deadline" });
      await vi.advanceTimersByTimeAsync(0); await dispatched.promise;
      if (close) database.close(); else await vi.advanceTimersByTimeAsync(10);
      await outcome; await cancelled.promise; expect(fetch).toHaveBeenCalledTimes(3); database.close(); vi.useRealTimers();
    }
  });
  it("bounds cancel waiting to two seconds but retains the ignored physical request and late body", async () => {
    vi.useFakeTimers(); const caller = new AbortController(); const dispatched = deferred<undefined>(); const cancelling = deferred<AbortSignal>(); const late = deferred<Response>();
    const cleaned = deferred<undefined>(); const { database, fetch } = setup({ maxConcurrent: 1 });
    fetch.mockImplementation((url, init) => {
      if (url === `${endpoint}/api/v2/statements`) return Promise.resolve(response({ statementHandle }, 202));
      if (url === `${endpoint}/api/v2/statements/${statementHandle}/cancel`) {
        if (init?.signal == null) throw new Error("fixture requires cancel signal"); cancelling.resolve(init.signal); return late.promise;
      }
      dispatched.resolve(undefined); return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => { reject(new Error("owned abort")); }, { once: true }); });
    });
    const outcome = expect(database.getWithSignal(users.key("a"), caller.signal)).rejects.toMatchObject({ reason: "caller" });
    await vi.advanceTimersByTimeAsync(0); await dispatched.promise; caller.abort(); await outcome; const cleanupSignal = await cancelling.promise;
    await vi.advanceTimersByTimeAsync(2000); expect(cleanupSignal.aborted).toBe(true); await expect(database.get(users.key("a"))).rejects.toThrow("busy");
    late.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cleaned.resolve(undefined); } }))); await cleaned.promise;
    fetch.mockImplementation(() => Promise.resolve(response())); vi.useRealTimers();
    await vi.waitFor(async () => { expect((await database.get(users.key("a"))).exists).toBe(true); }); database.close();
  });
  it("does not refresh credentials or mask caller cancellation when remote cancel is rejected", async () => {
    const caller = new AbortController(); const dispatched = deferred<undefined>(); const cleaned = deferred<undefined>(); let tokens = 0;
    const { database, fetch } = setup({ token: () => { tokens++; return "owned"; } });
    fetch.mockImplementation((url, init) => {
      if (url === `${endpoint}/api/v2/statements`) return Promise.resolve(response({ statementHandle }, 202));
      if (url === `${endpoint}/api/v2/statements/${statementHandle}/cancel`) return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cleaned.resolve(undefined); } }), { status: 401 }));
      dispatched.resolve(undefined); return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => { reject(new Error("owned abort")); }, { once: true }); });
    });
    const outcome = expect(database.getWithSignal(users.key("a"), caller.signal)).rejects.toMatchObject({ reason: "caller" });
    await dispatched.promise; caller.abort(); await outcome; await cleaned.promise; expect(tokens).toBe(2); expect(fetch).toHaveBeenCalledTimes(3); database.close();
  });
  it("keeps the cancel race private from fetch signal listener shadows and cleans an acquired stalled reader", async () => {
    vi.useFakeTimers(); const caller = new AbortController(); const dispatched = deferred<undefined>(); const acquired = deferred<undefined>(); const pulled = deferred<undefined>(); const cancelled = deferred<undefined>();
    const listener = vi.fn(); const cancel = vi.fn(() => { cancelled.resolve(undefined); });
    const stream = new ReadableStream<Uint8Array>({ pull() { pulled.resolve(undefined); }, cancel }); const owned = new Response(stream); const getReader = stream.getReader.bind(stream);
    vi.spyOn(stream, "getReader").mockImplementation(() => { const reader = getReader(); acquired.resolve(undefined); return reader; });
    const { database, fetch } = setup({ maxConcurrent: 1 });
    fetch.mockImplementation((url, init) => {
      if (url === `${endpoint}/api/v2/statements`) return Promise.resolve(response({ statementHandle }, 202));
      if (url === `${endpoint}/api/v2/statements/${statementHandle}/cancel`) {
        if (init?.signal == null) throw new Error("fixture requires owned cancel signal");
        Object.defineProperty(init.signal, "addEventListener", { value: listener });
        Object.defineProperty(init.signal, "removeEventListener", { value: () => { throw new Error("PRIVATE_SIGNAL_REMOVE"); } });
        return Promise.resolve(owned);
      }
      dispatched.resolve(undefined); return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => { reject(new Error("owned abort")); }, { once: true }); });
    });
    const outcome = expect(database.getWithSignal(users.key("a"), caller.signal)).rejects.toMatchObject({ reason: "caller" });
    await vi.advanceTimersByTimeAsync(0); await dispatched.promise; caller.abort(); await outcome; await acquired.promise; await pulled.promise;
    expect(stream.locked).toBe(true); await expect(database.get(users.key("a"))).rejects.toThrow("busy");
    await vi.advanceTimersByTimeAsync(2000); await cancelled.promise;
    expect(cancel).toHaveBeenCalledTimes(1); expect(stream.locked).toBe(false); expect(listener).not.toHaveBeenCalled();
    fetch.mockImplementation(() => Promise.resolve(response())); vi.useRealTimers();
    await vi.waitFor(async () => { expect((await database.get(users.key("a"))).exists).toBe(true); }); database.close();
  });
  it("does not invent remote ownership when submission never yields a handle", async () => {
    const caller = new AbortController(); const entered = deferred<undefined>(); const late = deferred<Response>(); const { database, fetch } = setup();
    fetch.mockImplementationOnce(() => { entered.resolve(undefined); return late.promise; });
    const outcome = expect(database.getWithSignal(users.key("a"), caller.signal)).rejects.toMatchObject({ reason: "caller" }); await entered.promise; caller.abort(); await outcome;
    const cancelled = deferred<undefined>(); late.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled.resolve(undefined); } }))); await cancelled.promise;
    expect(fetch).toHaveBeenCalledTimes(1); database.close();
  });
  it("never cancels a completed statement when caller decoding fails afterward", async () => {
    const { database, fetch } = setup(); const codec: Codec<unknown> = { ...identityCodec, decode: () => { throw new Error("PRIVATE_CODEC"); } };
    await expect(database.get(users.key("a"), codec)).rejects.toThrow("Snowflake codec failed"); expect(fetch).toHaveBeenCalledTimes(1); database.close();
  });
  it("fails declared/streamed/structural response excess whole and releases owned bodies", async () => {
    for (const owned of [new Response("x".repeat(2000), { headers: { "content-length": "2000" } }), new Response("x".repeat(2000)), new Response(new Uint8Array([0xff])), new Response('{"data":[],"data":[]}'), new Response("[".repeat(34) + "null" + "]".repeat(34)), new Response("{}", { headers: { "x-owned": "x".repeat(65_537) } })]) {
      const { database, fetch } = setup({ maxPageBytes: 1024 }); fetch.mockResolvedValueOnce(owned);
      await expect(database.get(users.key("a"))).rejects.toBeInstanceOf(SnowflakeError); expect(owned.body?.locked).toBe(false); database.close();
    }
  });
  it("caps partition/column/request work before issuing later GETs", async () => {
    const { database, fetch } = setup({ maxPartitions: 1 }); const first = payload(); first.resultSetMetaData.partitionInfo = [{ rowCount: 1 }, { rowCount: 0 }]; fetch.mockResolvedValueOnce(response(first));
    await expect(database.get(users.key("a"))).rejects.toThrow("partitions"); expect(fetch).toHaveBeenCalledTimes(1); database.close();
    const columns = setup({ maxColumns: 1 }); await expect(columns.database.get(users.key("a"))).rejects.toThrow("metadata"); expect(columns.fetch).toHaveBeenCalledTimes(1); columns.database.close();
    const second = setup({ maxRequests: 1 }); second.fetch.mockResolvedValueOnce(response({ statementHandle }, 202)).mockResolvedValueOnce(response({ statementHandle }));
    await expect(second.database.get(users.key("a"))).rejects.toThrow("request budget");
    await vi.waitFor(() => { expect(second.fetch).toHaveBeenCalledTimes(2); }); expect(second.fetch.mock.calls[1]?.[0]).toBe(`${endpoint}/api/v2/statements/${statementHandle}/cancel`); second.database.close();
  });
});
