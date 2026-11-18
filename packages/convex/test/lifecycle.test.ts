import { afterEach, expect, it, vi } from "vitest";
import { Key, identityCodec } from "@dalgo/core";
import { convexToJson, type Value } from "convex/values";
import { ConvexDatabase, type ConvexNativePage, type ConvexOptions } from "../src/index.js";

function options(extra: Partial<ConvexOptions> = {}): ConvexOptions {
  return { endpoint: "https://owned.convex.cloud", token: "private-jwt", collections: { tasks: { getFunction: "dalgo:getTask" } }, queries: { tasks: { path: "dalgo:listTasks", collection: "tasks" } }, ...extra };
}
function reply(value: Value): Response { return new Response(JSON.stringify({ status: "success", value: convexToJson(value) }), { headers: { "content-type": "application/json" } }); }
function cursor(page: ConvexNativePage): string { if (page.nextCursor === undefined) throw new Error("fixture cursor missing"); return page.nextCursor; }
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve: ((value: T) => void) | undefined, reject: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  if (resolve === undefined || reject === undefined) throw new Error("fixture promise not constructed");
  return { promise, resolve, reject };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("stops on real after-dispatch caller abort and reopens without closing borrowed fetch", async () => {
  const dispatched = deferred<undefined>(), controller = new AbortController();
  let slow = true, observed: AbortSignal | undefined;
  const transport = vi.fn<typeof fetch>((_url, init) => {
    if (!slow) return Promise.resolve(reply({ _id: "a" }));
    slow = false;
    if (!(init?.signal instanceof AbortSignal)) throw new Error("owned signal absent");
    observed = init.signal; dispatched.resolve(undefined);
    return new Promise<Response>(() => undefined);
  });
  const db = new ConvexDatabase(options({ fetch: transport }));
  const request = db.getWithSignal(new Key("tasks", "a"), controller.signal);
  await dispatched.promise;
  controller.abort("private caller cause");
  await expect(request).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
  await expect(request).rejects.not.toHaveProperty("cause");
  await expect(request).rejects.not.toThrow("private caller cause");
  expect(observed?.aborted).toBe(true);
  expect((await db.get(new Key("tasks", "a"))).exists).toBe(true);
});

it("covers token waits, monotonic token/codec/fingerprint boundaries and no later getMany dispatch", async () => {
  const transport = vi.fn<typeof fetch>(() => Promise.resolve(reply({ _id: "a" })));
  const tokenStarted = deferred<undefined>(), controller = new AbortController();
  const db = new ConvexDatabase(options({ token: () => { tokenStarted.resolve(undefined); return new Promise<string>(() => undefined); }, fetch: transport }));
  const pending = db.getWithSignal(new Key("tasks", "a"), controller.signal);
  await tokenStarted.promise; controller.abort("private");
  await expect(pending).rejects.toMatchObject({ reason: "caller" }); expect(transport).not.toHaveBeenCalled();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const expired = new ConvexDatabase(options({ timeoutMs: 10, token: () => { now = 11; return "private"; }, fetch: transport }));
  await expect(expired.get(new Key("tasks", "a"))).rejects.toMatchObject({ reason: "deadline" });
  expect(transport).not.toHaveBeenCalled();
  now = 0;
  const codecDb = new ConvexDatabase(options({ timeoutMs: 10, fetch: transport }));
  await expect(codecDb.get(new Key("tasks", "a"), { ...identityCodec, decode(value: unknown): unknown { now = 11; return value; } })).rejects.toMatchObject({ reason: "deadline" });
  now = 0;
  const before = transport.mock.calls.length, stop = new AbortController();
  await expect(codecDb.getManyWithSignal([new Key("tasks", "a"), new Key("tasks", "b")], stop.signal, { ...identityCodec, decode(value: unknown): unknown { stop.abort(); return value; } })).rejects.toMatchObject({ reason: "caller" });
  expect(transport.mock.calls.length).toBe(before + 1);
});

it("includes asynchronous official-codec auth fingerprint work in the original deadline", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(() => { now = 11; return Promise.resolve(new ArrayBuffer(32)); });
  const transport = vi.fn<typeof fetch>(() => Promise.resolve(reply(null)));
  const db = new ConvexDatabase(options({ timeoutMs: 10, fetch: transport }));
  await expect(db.get(new Key("tasks", "a"))).rejects.toMatchObject({ reason: "deadline" });
  expect(transport).not.toHaveBeenCalled();
});

it("bounds real dispatched deadline and closes exact owned signal before subsequent read", async () => {
  const dispatched = deferred<undefined>();
  let received: AbortSignal | undefined, slow = true;
  const db = new ConvexDatabase(options({ timeoutMs: 100, fetch: (_url, init) => {
    if (!slow) return Promise.resolve(reply({ _id: "a" }));
    slow = false;
    if (!(init?.signal instanceof AbortSignal)) throw new Error("missing signal");
    received = init.signal; dispatched.resolve(undefined); return new Promise<Response>(() => undefined);
  } }));
  const pending = db.get(new Key("tasks", "a"));
  await dispatched.promise;
  await expect(pending).rejects.toMatchObject({ reason: "deadline" });
  expect(received?.aborted).toBe(true);
  expect((await db.get(new Key("tasks", "a"))).exists).toBe(true);
});

it("consumes late fetch rejection and nonblocking late body cancellation, even if cancel throws or never settles", async () => {
  for (const mode of ["throws", "rejects", "never", "late-reject"] as const) {
    const completion = deferred<Response>(), dispatched = deferred<undefined>(), stop = new AbortController();
    const db = new ConvexDatabase(options({ fetch: () => { dispatched.resolve(undefined); return completion.promise; } }));
    const pending = db.getWithSignal(new Key("tasks", "a"), stop.signal);
    await dispatched.promise; stop.abort();
    await expect(pending).rejects.toMatchObject({ reason: "caller" });
    if (mode === "late-reject") completion.reject(new Error("private transport cause"));
    else {
      const cancel = vi.fn((): Promise<void> => {
        if (mode === "throws") throw new Error("private cancel cause");
        if (mode === "rejects") return Promise.reject(new Error("private rejected cancel cause"));
        return new Promise<void>(() => undefined);
      });
      const response = reply(null);
      Object.defineProperty(response, "body", { value: { cancel } });
      completion.resolve(response);
      await Promise.resolve(); await Promise.resolve();
      expect(cancel).toHaveBeenCalledTimes(1);
    }
  }
});

it("retains prior cursor after final body cleanup abort and retries the same server position", async () => {
  const stop = new AbortController();
  const sent: string[] = [];
  let aborted = false;
  const db = new ConvexDatabase(options({ fetch: (_url, init) => {
    if (typeof init?.body !== "string") throw new Error("missing body");
    sent.push(init.body);
    const response = reply(sent.length === 1 ? { page: [], isDone: false, continueCursor: "server-1" } : { page: [{ _id: "a" }], isDone: true, continueCursor: "" });
    if (sent.length === 2) {
      const stream = response.body;
      if (stream === null) throw new Error("missing fixture stream");
      const getReader = stream.getReader.bind(stream);
      Object.defineProperty(stream, "getReader", { value: () => {
        const reader = getReader(), cancel = reader.cancel.bind(reader);
        reader.cancel = (): Promise<void> => { aborted = true; stop.abort("private"); return cancel(); };
        return reader;
      } });
    }
    return Promise.resolve(response);
  } }));
  const first = await db.queryFunction("tasks", {}, { pageSize: 1 });
  await expect(db.queryFunction("tasks", {}, { pageSize: 1, cursor: cursor(first), signal: stop.signal })).rejects.toMatchObject({ reason: "caller" });
  expect(aborted).toBe(true);
  const final = await db.queryFunction("tasks", {}, { pageSize: 1, cursor: cursor(first) });
  expect(final.documents).toEqual([{ _id: "a" }]);
  expect(sent[1]).toBe(sent[2]);
});

it("does not revoke an already acknowledged page when caller aborts on its fulfilled promise", async () => {
  const stop = new AbortController();
  let page = 0;
  const db = new ConvexDatabase(options({ fetch: () => Promise.resolve(reply(++page === 1 ? { page: [{ _id: "a" }], isDone: false, continueCursor: "one" } : { page: [{ _id: "b" }], isDone: true, continueCursor: "" })) }));
  const pending = db.queryFunction("tasks", {}, { pageSize: 1, signal: stop.signal });
  void pending.then(() => { stop.abort(); });
  const first = await pending;
  expect(first.documents).toEqual([{ _id: "a" }]);
  expect((await db.queryFunction("tasks", {}, { pageSize: 1, cursor: cursor(first) })).documents).toEqual([{ _id: "b" }]);
});

it("bounds admission and close cancels active work without destroying a borrowed transport", async () => {
  const dispatched = deferred<undefined>(), owned = deferred<Response>();
  const db = new ConvexDatabase(options({ maxConcurrent: 1, fetch: () => { dispatched.resolve(undefined); return owned.promise; } }));
  const first = db.get(new Key("tasks", "a")); await dispatched.promise;
  await expect(db.get(new Key("tasks", "b"))).rejects.toMatchObject({ code: "busy" });
  db.close(); db.close();
  await expect(first).rejects.toMatchObject({ code: "closed" });
  await expect(db.get(new Key("tasks", "a"))).rejects.toMatchObject({ code: "closed" });
  owned.resolve(reply(null));
});

it.each([
  { stage: "auth", reason: "caller" }, { stage: "auth", reason: "deadline" },
  { stage: "fetch", reason: "caller" }, { stage: "fetch", reason: "deadline" },
] as const)("retains one physical admission lease for ignored $stage after $reason", async ({ stage, reason }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockReturnValue(0);
  const entered = deferred<undefined>(), authHeld = deferred<string>(), fetchHeld = deferred<Response>();
  const controller = new AbortController();
  let firstAuth = true, firstFetch = true;
  const supplier = vi.fn(() => {
    if (stage === "auth" && firstAuth) { firstAuth = false; entered.resolve(undefined); return authHeld.promise; }
    return "private-jwt";
  });
  const fetcher = vi.fn<typeof fetch>(() => {
    if (stage === "fetch" && firstFetch) { firstFetch = false; entered.resolve(undefined); return fetchHeld.promise; }
    return Promise.resolve(reply({ _id: "a" }));
  });
  const db = new ConvexDatabase(options({ maxConcurrent: 1, timeoutMs: 40, token: supplier, fetch: fetcher }));
  const outcome = expect(db.getWithSignal(new Key("tasks", "a"), controller.signal)).rejects.toMatchObject({ reason });
  await entered.promise;
  if (reason === "caller") controller.abort("private-abort");
  else await vi.advanceTimersByTimeAsync(40);
  await outcome;
  for (let attempt = 0; attempt < 2; attempt++) await expect(db.get(new Key("tasks", "a"))).rejects.toMatchObject({ code: "busy" });
  expect(supplier).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(stage === "auth" ? 0 : 1);
  const cancelled = vi.fn(() => new Promise<void>(() => undefined));
  if (stage === "auth") authHeld.reject(new Error("private late auth rejection"));
  else fetchHeld.resolve(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })));
  // The actual borrowed promise settles first; a native event-loop checkpoint
  // drains its promise ownership handlers, without an elapsed-time sleep/retry.
  await new Promise<void>(resolve => { setImmediate(resolve); });
  if (stage === "fetch") expect(cancelled).toHaveBeenCalledTimes(1);
  expect((await db.get(new Key("tasks", "a"))).exists).toBe(true);
});

it("retains admission while a borrowed reader ignores cancellation, releasing only after its read settles", async () => {
  const entered = deferred<undefined>(), held = deferred<ReadableStreamReadResult<Uint8Array>>();
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
  const response = new Response(stream, { headers: { "content-type": "application/json" } });
  const reader = stream.getReader();
  vi.spyOn(reader, "read").mockImplementation(() => { entered.resolve(undefined); return held.promise; });
  vi.spyOn(reader, "cancel").mockImplementation(() => new Promise<void>(() => undefined));
  Object.defineProperty(stream, "getReader", { value: () => reader });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response).mockImplementation(() => Promise.resolve(reply({ _id: "a" })));
  const db = new ConvexDatabase(options({ maxConcurrent: 1, fetch: fetcher }));
  const outcome = expect(db.getWithSignal(new Key("tasks", "a"), controller.signal)).rejects.toMatchObject({ reason: "caller" });
  await entered.promise; controller.abort(); await outcome;
  await expect(db.get(new Key("tasks", "a"))).rejects.toMatchObject({ code: "busy" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(stream.locked).toBe(false);
  held.resolve({ done: true, value: new Uint8Array() });
  await new Promise<void>(resolve => { setImmediate(resolve); });
  expect((await db.get(new Key("tasks", "a"))).exists).toBe(true);
});
