import { afterEach, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { WorkersKvDatabase } from "../src/index.js";
import { CloudflareKvRestDatabase } from "../src/rest.js";
import { createCloudflareKvHttpHandler } from "../src/http.js";
import { bounded, deferred, namespace, options } from "./helpers.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Instrument a real native signal, always delegating to its actual platform
 * listener removal unless the explicit throw-before case exercises fallback. */
function removal(signal: AbortSignal, effect: () => void, before = false): () => number {
  let calls = 0;
  Object.defineProperty(signal, "removeEventListener", { configurable: true, value(type: string, listener: EventListenerOrEventListenerObject | null, eventOptions?: boolean | EventListenerOptions): void {
    if (type === "abort") { calls++; if (before) effect(); }
    EventTarget.prototype.removeEventListener.call(signal, type, listener, eventOptions);
    if (type === "abort" && !before) effect();
  } });
  return () => calls;
}

it("checks real delegate-removal cancellation/Close/elapsed/errors before read delivery and releases timers/leases", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  for (const mode of ["caller", "closed", "deadline", "throw-before", "throw-after"] as const) {
    now = 0; const controller = new AbortController();
    const database = new WorkersKvDatabase(namespace(), { ...options, maxConcurrent: 1, timeoutMs: 10 });
    const removed = removal(controller.signal, () => {
      if (mode === "caller") controller.abort(new Error("PRIVATE_CALLER_CAUSE"));
      else if (mode === "closed") database.close();
      else if (mode === "deadline") now = 11;
      else throw new Error("PRIVATE_REMOVE_ERROR");
    }, mode === "throw-before");
    const failure: unknown = await database.get("tenant:a", controller.signal).catch((error: unknown) => error);
    if (!(failure instanceof Error)) throw new Error("cleanup callback returned a late successful read");
    if (mode === "caller" || mode === "deadline") expect(failure).toMatchObject({ reason: mode });
    else expect(failure).toMatchObject({ code: mode === "closed" ? "closed" : "transport" });
    expect(failure.message).not.toContain("PRIVATE"); expect(failure).not.toHaveProperty("cause");
    expect(removed()).toBe(1); expect(getEventListeners(controller.signal, "abort")).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    if (mode !== "closed") expect((await database.get("tenant:b"))?.key).toBe("tenant:b");
    database.close(); expect(vi.getTimerCount()).toBe(0);
  }
});

it("keeps the prior cursor and spent attempts when delegate removal rejects a resumed page", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  for (const mode of ["caller", "deadline", "throw"] as const) {
    now = 0; let calls = 0; const binding = namespace();
    binding.list = (request) => { calls++; return Promise.resolve(request.cursor === undefined ? { keys: [], list_complete: false, cursor: "owned-a" } : { keys: [{ name: "tenant:a" }], list_complete: true }); };
    const database = new WorkersKvDatabase(binding, { ...options, maxConcurrent: 1, timeoutMs: 10, maxPages: 3 });
    const first = await database.list({ prefix: "tenant:", limit: 1 }); if (first.nextCursor === undefined) throw new Error("no prior cursor");
    const request = { prefix: "tenant:", limit: 1, cursor: first.nextCursor }; const caller = new AbortController();
    const removed = removal(caller.signal, () => { if (mode === "caller") caller.abort(); else if (mode === "deadline") now = 11; else throw new Error("PRIVATE_REMOVE"); });
    const failed = database.list(request, caller.signal);
    await expect(failed).rejects.toMatchObject(mode === "throw" ? { code: "transport" } : { reason: mode });
    expect(removed()).toBe(1); expect(vi.getTimerCount()).toBe(0);
    const recovered = await database.list(request); expect(recovered.keys[0]?.name).toBe("tenant:a"); expect(recovered.complete).toBe(true); expect(calls).toBe(3);
    await expect(database.list(request)).rejects.toMatchObject({ code: "input" }); expect(calls).toBe(3); database.close();
  }
});

it("preserves the original safe failure when listener cleanup throws and never leaves owned timers/admission", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const binding = namespace(); binding.getWithMetadata = () => Promise.reject(new Error("PRIVATE_PROVIDER"));
  const database = new WorkersKvDatabase(binding, { ...options, maxConcurrent: 1 });
  const caller = new AbortController(); removal(caller.signal, () => { throw new Error("PRIVATE_REMOVE"); }, true);
  const error: unknown = await database.get("tenant:a", caller.signal).catch((failure: unknown) => failure);
  expect(error).toMatchObject({ code: "transport" }); expect(error).not.toHaveProperty("cause");
  if (!(error instanceof Error)) throw new Error("missing safe failure"); expect(error.message).not.toContain("PRIVATE");
  expect(getEventListeners(caller.signal, "abort")).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  binding.getWithMetadata = namespace().getWithMetadata.bind(binding);
  expect((await database.get("tenant:b"))?.key).toBe("tenant:b"); database.close();
});

it("does not ACK or release admission before an asynchronous response factory settles", async () => {
  const entered = deferred<undefined>(); const factory = deferred<number>(); const binding = namespace(); let calls = 0;
  binding.list = (request) => { calls++; return Promise.resolve(request.cursor === undefined ? { keys: [], list_complete: false, cursor: "owned-a" } : { keys: [{ name: "tenant:a" }], list_complete: true }); };
  const database = new WorkersKvDatabase(binding, { ...options, maxConcurrent: 1 });
  const first = await database.list({ prefix: "tenant:", limit: 1 }); if (first.nextCursor === undefined) throw new Error("no cursor");
  const request = { prefix: "tenant:", limit: 1, cursor: first.nextCursor };
  const result = database.mapList(request, () => { entered.resolve(undefined); return factory.promise; }); await bounded(entered.promise);
  await expect(database.list(request)).rejects.toMatchObject({ code: "busy" }); expect(calls).toBe(2);
  factory.resolve(7); expect(await result).toBe(7);
  await expect(database.list(request)).rejects.toMatchObject({ code: "input" }); expect(calls).toBe(2); database.close();
});

it("retains an abandoned asynchronous factory until physical settlement without consuming its prior cursor", async () => {
  const entered = deferred<undefined>(); const factory = deferred<number>(); let calls = 0; const binding = namespace();
  binding.list = (request) => { calls++; return Promise.resolve(request.cursor === undefined ? { keys: [], list_complete: false, cursor: "owned-a" } : { keys: [{ name: "tenant:a" }], list_complete: true }); };
  const database = new WorkersKvDatabase(binding, { ...options, maxConcurrent: 1, maxPages: 3 });
  const first = await database.list({ prefix: "tenant:", limit: 1 }); if (first.nextCursor === undefined) throw new Error("no cursor");
  const request = { prefix: "tenant:", limit: 1, cursor: first.nextCursor }; const caller = new AbortController();
  const pending = database.mapList(request, () => { entered.resolve(undefined); return factory.promise; }, caller.signal); await bounded(entered.promise); caller.abort();
  await expect(pending).rejects.toMatchObject({ reason: "caller" }); await expect(database.list(request)).rejects.toMatchObject({ code: "busy" }); expect(calls).toBe(2);
  factory.resolve(9); await setImmediate();
  expect((await database.list(request)).keys[0]?.name).toBe("tenant:a"); expect(calls).toBe(3); database.close();
});

it("checks outer bridge cleanup and original deadline after inner cleanup before cursor ACK", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  let tokens = 0; let calls = 0;
  const native = new CloudflareKvRestDatabase({ ...options, accountId: "owned", namespaceId: "existing", timeoutMs: 100, token: (signal) => { if (++tokens === 2) removal(signal, () => { now = 11; }); return "synthetic-reader"; }, fetch: () => { calls++; return Promise.resolve(Response.json(calls === 1 ? { success: true, result: [], result_info: { cursor: "owned-a" } } : { success: true, result: [{ name: "tenant:a" }], result_info: { cursor: "" } })); } });
  const first = await native.list({ prefix: "tenant:", limit: 10 }); if (first.nextCursor === undefined) throw new Error("no cursor");
  const request = { prefix: "tenant:", limit: 10, cursor: first.nextCursor };
  const handler = createCloudflareKvHttpHandler({ timeoutMs: 10, authorize: () => native });
  const response = await handler(new Request("https://owned.invalid/kv", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "list", request }) }));
  expect(response.status).toBe(408); const body: unknown = await response.json(); expect(body).toEqual({ error: "cancelled", reason: "deadline" }); expect(vi.getTimerCount()).toBe(0);
  expect((await native.list(request)).keys[0]?.name).toBe("tenant:a"); expect(calls).toBe(3); native.close();
});
