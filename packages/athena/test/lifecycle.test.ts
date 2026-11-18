import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { AthenaNativeClient } from "../src/client.js";
import { deferred, Fixture, query, result, source } from "./fixture.js";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("whole operation and physical admission", () => {
  it("reads genuine caller state intrinsically and redacts its private cause/getter", async () => {
    const f = new Fixture(), c = new AthenaNativeClient({ source, transport: f }), controller = new AbortController(); controller.abort(new Error("PRIVATE_CAUSE"));
    Object.defineProperty(controller.signal, "aborted", { get() { throw new Error("PRIVATE_GETTER"); } });
    const error: unknown = await c.queryPage(query(), { signal: controller.signal }).catch(error => error as unknown);
    expect(error).toBeInstanceOf(QueryCancelledError); expect(error).not.toHaveProperty("cause"); expect(String(error)).not.toContain("PRIVATE"); expect(f.auth).toBe(0); c.close();
  });
  it("covers ignored credential work and retains admission until true settlement", async () => {
    const f = new Fixture(), started = deferred<void>(), token = deferred<{ principal: string; generation: string }>();
    f.authorize = () => { f.auth++; started.resolve(undefined); return token.promise; };
    const c = new AthenaNativeClient({ source, transport: f, maxConcurrent: 1 }), controller = new AbortController();
    const pending = c.queryPage(query(), { signal: controller.signal }); await started.promise; controller.abort();
    await expect(pending).rejects.toBeInstanceOf(QueryCancelledError); await expect(c.queryPage(query())).rejects.toMatchObject({ code: "busy" });
    token.resolve({ principal: "owned-reader", generation: "one" }); await new Promise(resolve => setImmediate(resolve));
    f.authorize = () => ({ principal: "owned-reader", generation: "one" }); expect((await c.queryPage(query())).rows).toHaveLength(1); c.close();
  });
  it("owns the reader before a reentrant acquisition abort, cancels it once and unlocks", async () => {
    const f = new Fixture(), controller = new AbortController(); let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }); const native = stream.getReader.bind(stream);
    Object.defineProperty(stream, "getReader", { value: () => { const reader = native(); controller.abort(); return reader; } });
    f.override = event => event.action === "GetQueryResults" ? new Response(stream, { headers: { "content-type": "application/json" } }) : undefined;
    const c = new AthenaNativeClient({ source, transport: f });
    await expect(c.queryPage(query(), { signal: controller.signal })).rejects.toBeInstanceOf(QueryCancelledError);
    expect(cancelled).toBe(1); expect(stream.locked).toBe(false); c.close();
  });
  it("retains a native underlying cancel promise after the reader lock is released", async () => {
    const f = new Fixture(), entered = deferred<void>(), finish = deferred<void>(), controller = new AbortController(); let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull() { if (stream.locked) entered.resolve(undefined); }, cancel() { cancelled++; return finish.promise; } });
    f.override = event => event.action === "GetQueryResults" ? new Response(stream, { headers: { "content-type": "application/json" } }) : undefined;
    const c = new AthenaNativeClient({ source, transport: f, maxConcurrent: 1 }); const pending = c.queryPage(query(), { signal: controller.signal });
    await entered.promise; controller.abort(); await expect(pending).rejects.toBeInstanceOf(QueryCancelledError); expect(cancelled).toBe(1); expect(stream.locked).toBe(false);
    await expect(c.queryPage(query())).rejects.toMatchObject({ code: "busy" }); finish.resolve(undefined); await new Promise(resolve => setImmediate(resolve));
    f.override = undefined; expect((await c.queryPage(query())).rows).toHaveLength(1); c.close();
  });
  it("uses private timer state despite received-signal getters and listener overrides", async () => {
    vi.useFakeTimers(); const f = new Fixture(), entered = deferred<void>(); let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ pull() { if (stream.locked) entered.resolve(undefined); }, cancel() { cancelled++; } });
    f.override = event => {
      if (event.action !== "GetQueryResults") return undefined;
      Object.defineProperty(event.signal, "addEventListener", { value: () => undefined });
      Object.defineProperty(event.signal, "aborted", { get() { throw new Error("PRIVATE"); } });
      return new Response(stream, { headers: { "content-type": "application/json" } });
    };
    const c = new AthenaNativeClient({ source, transport: f, timeoutMs: 100 }); const outcome = c.queryPage(query()).catch(error => error as unknown);
    await entered.promise; await vi.advanceTimersByTimeAsync(100); expect(await outcome).toBeInstanceOf(QueryCancelledError); expect(cancelled).toBe(1); expect(stream.locked).toBe(false); c.close();
  });
  it.each([true, false])("checks original expiry at final %s successor/terminal ACK boundary", async more => {
    vi.useFakeTimers(); const clock = { value: 0 }; vi.spyOn(performance, "now").mockImplementation(() => clock.value);
    const f = new Fixture(); f.pages = [result([], "p1", true), result([["a", "1", null]], more ? "p2" : undefined), result([["b", "2", null]])];
    const c = new AthenaNativeClient({ source, transport: f, cursorTtlMs: 10 }); const first = await c.queryPage(query());
    if (first.nextCursor === undefined) throw new Error("cursor");
    await expect(c.mapNextPage(first.nextCursor, undefined, () => { clock.value = 10; return "late"; })).rejects.toBeInstanceOf(QueryCancelledError);
    await expect(c.nextPage(first.nextCursor)).rejects.toBeInstanceOf(QueryCancelledError);
    clock.value = 11; f.pages = [result([["new", "1", null]], undefined, true)]; expect((await c.queryPage(query())).rows[0]?.[0]).toBe("new"); c.close();
  });
  it("retains async factory work after cancellation and preserves its input handle", async () => {
    const f = new Fixture(); f.pages = [result([], "p1", true), result([["a", "1", null]])];
    const c = new AthenaNativeClient({ source, transport: f }), entered = deferred<void>(), finish = deferred<string>(), controller = new AbortController();
    const first = await c.queryPage(query()); if (first.nextCursor === undefined) throw new Error("cursor"); const cursor = first.nextCursor;
    const pending = c.mapNextPage(cursor, controller.signal, () => { entered.resolve(undefined); return finish.promise; }); await entered.promise; controller.abort();
    await expect(pending).rejects.toBeInstanceOf(QueryCancelledError); await expect(c.nextPage(cursor)).rejects.toMatchObject({ code: "busy" });
    finish.resolve("late"); await new Promise(resolve => setImmediate(resolve)); expect((await c.nextPage(cursor)).rows[0]?.[0]).toBe("a"); c.close();
  });
  it("guards synchronous credential elapsed time before any request is sent", async () => {
    vi.useFakeTimers(); const clock = { value: 0 }; vi.spyOn(performance, "now").mockImplementation(() => clock.value);
    const f = new Fixture(); f.authorize = () => { clock.value = 100; return f.identity; };
    const c = new AthenaNativeClient({ source, transport: f, timeoutMs: 100 }); await expect(c.queryPage(query())).rejects.toBeInstanceOf(QueryCancelledError);
    expect(f.calls).toHaveLength(0); c.close();
  });
  it("keeps a global quota across journeys, net-replaces ACK state and refunds terminal state", async () => {
    const f = new Fixture(); f.pages = [result([], "p1", true), result([["a", "1", null]])];
    const c = new AthenaNativeClient({ source, transport: f, maxColumns: 3, maxPageNodes: 128, maxCursorNodes: 768, maxPageBytes: 2048, maxCursorBytes: 524288 });
    const cursors = [];
    for (let i = 0; i < 3; i++) { const page = await c.queryPage(query()); if (page.nextCursor === undefined) throw new Error("cursor"); cursors.push(page.nextCursor); }
    const authBefore = f.auth; await expect(c.queryPage(query())).rejects.toMatchObject({ code: "bounds" }); expect(f.auth).toBe(authBefore);
    const cursor = cursors[0]; if (cursor === undefined) throw new Error("cursor");
    expect((await c.nextPage(cursor)).hasMore).toBe(false); expect((await c.queryPage(query())).hasMore).toBe(true); c.close();
  });
  it.each(["caller", "deadline"] as const)("reclassifies a permission failure after abort cleanup causes real %s cancellation", async reason => {
    vi.useFakeTimers(); const clock = { value: 0 }; vi.spyOn(performance, "now").mockImplementation(() => clock.value);
    const f = new Fixture(), controller = new AbortController(); let cleanupEvents = 0;
    f.override = event => {
      if (event.action !== "GetQueryResults") return undefined;
      event.signal.addEventListener("abort", () => { cleanupEvents++; if (reason === "caller") controller.abort(new Error("PRIVATE_CAUSE")); else clock.value = 100; }, { once: true });
      return new Response("{}", { status: 403, headers: { "content-type": "application/json" } });
    };
    const c = new AthenaNativeClient({ source, transport: f, timeoutMs: 100 });
    const error: unknown = await c.queryPage(query(), { signal: controller.signal }).catch(error => error as unknown);
    expect(error).toBeInstanceOf(QueryCancelledError); expect(error).toMatchObject({ reason });
    expect(error).not.toHaveProperty("cause"); expect(String(error)).not.toContain("PRIVATE"); expect(cleanupEvents).toBe(1);
    f.override = undefined; expect((await c.queryPage(query())).rows).toHaveLength(1); c.close();
  });
  it("retains only the admitted closed authority and passes that copy to a trusted binding hook", async () => {
    const f = new Fixture(), original = { principal: "owned-reader", generation: "one", extra: { large: "PRIVATE".repeat(10000) } };
    let captured: unknown, admitted: unknown;
    const transport = {
      authorize: () => original,
      captureAuthority(value: unknown, copy: unknown) { captured = value; admitted = copy; },
      request: f.request.bind(f)
    };
    const c = new AthenaNativeClient({ source, transport }); expect((await c.queryPage(query())).rows).toHaveLength(1);
    expect(captured).toBe(original); expect(admitted).not.toBe(original); expect(Object.isFrozen(admitted)).toBe(true);
    expect(admitted).toEqual({ principal: "owned-reader", generation: "one" });
    expect(f.calls.every(event => event.authority === admitted)).toBe(true); expect(f.calls.every(event => !Object.hasOwn(event.authority, "extra"))).toBe(true); c.close();
  });
  it("requests only one owned stop with captured submit authority after real poll dispatch", async () => {
    const f = new Fixture(), entered = deferred<void>(), finish = deferred<Response>(), controller = new AbortController();
    f.override = event => { if (event.action === "GetQueryExecution") { entered.resolve(undefined); return finish.promise; } return undefined; };
    const c = new AthenaNativeClient({ source, transport: f, maxConcurrent: 1 }); const pending = c.queryPage(query(), { signal: controller.signal });
    await entered.promise; f.identity = { principal: "unrelated", generation: "two" }; controller.abort();
    await expect(pending).rejects.toBeInstanceOf(QueryCancelledError); await new Promise(resolve => setImmediate(resolve));
    const stops = f.calls.filter(v => v.action === "StopQueryExecution"); expect(stops).toHaveLength(1);
    expect(stops[0]?.input).toEqual({ QueryExecutionId: "query-1" }); expect(stops[0]?.authority).toEqual({ principal: "owned-reader", generation: "one" }); expect(f.auth).toBe(1);
    await expect(c.queryPage(query())).rejects.toMatchObject({ code: "busy" }); finish.resolve(new Response(null)); await new Promise(resolve => setImmediate(resolve)); c.close();
  });
});
