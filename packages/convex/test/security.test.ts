import { afterEach, expect, it, vi } from "vitest";
import { Key } from "@dalgo/core";
import { convexToJson, type Value } from "convex/values";
import { ConvexDatabase, type ConvexOptions, type ConvexNativePage } from "../src/index.js";

const secret = "private-token-do-not-print";
function options(extra: Partial<ConvexOptions> = {}): ConvexOptions {
  return { endpoint: "https://owned.convex.cloud", token: secret, collections: { tasks: { getFunction: "dalgo:getTask", staticArgs: { tenant: "fixed" } } }, queries: { tasks: { path: "dalgo:listTasks", collection: "tasks", arguments: ["value"], staticArgs: { tenant: "fixed" } } }, ...extra };
}
function reply(value: Value): Response { return new Response(JSON.stringify({ status: "success", value: convexToJson(value) }), { headers: { "content-type": "application/json" } }); }
function raw(text: string, init: ResponseInit = {}): Response { return new Response(text, { headers: { "content-type": "application/json" }, ...init }); }
function cursor(page: ConvexNativePage): string { if (page.nextCursor === undefined) throw new Error("missing fixture cursor"); return page.nextCursor; }
afterEach(() => { vi.restoreAllMocks(); });

it("refuses unsafe routes, auth modes and closed descriptor/iterator bypasses without invoking getters", () => {
  for (const endpoint of ["http://owned.convex.cloud", "https://user:secret@owned.convex.cloud", "https://owned.convex.cloud/api/run", "https://owned.convex.cloud?secret", "https://owned.convex.cloud?", "https://owned.convex.cloud#secret", "https://owned.convex.cloud/%2F", "not a URL"]) {
    expect(() => new ConvexDatabase(options({ endpoint }))).toThrow("invalid-input");
  }
  expect(() => new ConvexDatabase(options({ endpoint: "http://127.0.0.1:4567", allowInsecureLoopbackHttp: true }))).not.toThrow();
  expect(() => new ConvexDatabase(options({ endpoint: "http://localhost:4567", allowInsecureLoopbackHttp: true }))).toThrow();
  const getter = vi.fn(() => { throw new Error(secret); });
  const config = options(); Object.defineProperty(config, "token", { get: getter });
  expect(() => new ConvexDatabase(config)).toThrow("invalid-input"); expect(getter).not.toHaveBeenCalled();
  const controlConstructor = options(); Object.defineProperty(controlConstructor, "constructor", { value: "not-a-control-option", enumerable: true });
  expect(() => new ConvexDatabase(controlConstructor)).toThrow("invalid-input");
  expect(() => new ConvexDatabase({ ...options(), adminKey: secret } as ConvexOptions)).toThrow();
  expect(() => new ConvexDatabase({ endpoint: "https://owned.convex.cloud", collections: options().collections })).toThrow();
  for (const path of ["../admin:read", "https://evil/query", "api/run", "/get", "foo:bar:more"]) {
    expect(() => new ConvexDatabase(options({ collections: { tasks: { getFunction: path } } }))).toThrow();
  }
  expect(() => new ConvexDatabase(options({ queries: { tasks: { path: "dalgo:listTasks", collection: "unknown" } } }))).toThrow();
});

it("requires explicit anonymous mode and never falls back to anonymous on token failure", async () => {
  const fetcher = vi.fn<typeof fetch>((_url, init) => {
    expect(init?.headers).toEqual({ "content-type": "application/json", accept: "application/json" });
    return Promise.resolve(reply(null));
  });
  const db = new ConvexDatabase({ endpoint: "https://owned.convex.cloud", allowAnonymous: true, collections: options().collections, fetch: fetcher });
  expect((await db.get(new Key("tasks", "a"))).exists).toBe(false);
  for (const token of ["", "bad token", "bad\nheader", "x".repeat(8193)]) {
    const bad = new ConvexDatabase(options({ token, allowAnonymous: true, fetch: fetcher }));
    await expect(bad.get(new Key("tasks", "a"))).rejects.toMatchObject({ code: "denied" });
  }
  const rejected = new ConvexDatabase(options({ token: () => Promise.reject(new Error(secret)), allowAnonymous: true, fetch: fetcher }));
  const failure = rejected.get(new Key("tasks", "a"));
  await expect(failure).rejects.toMatchObject({ name: "ConvexReadError", code: "transport", message: "Convex read: transport" });
  await expect(failure).rejects.not.toHaveProperty("cause");
  await expect(failure).rejects.not.toThrow(secret);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("refuses malformed arguments, unconfigured functions and scope overrides before token/fetch", async () => {
  const auth = vi.fn(() => secret), fetcher = vi.fn<typeof fetch>(() => Promise.resolve(reply(null)));
  const db = new ConvexDatabase(options({ token: auth, fetch: fetcher }));
  const getter = vi.fn(() => { throw new Error(secret); });
  const accessors = {}; Object.defineProperty(accessors, "value", { get: getter, enumerable: true });
  for (const args of [{ tenant: "substituted" }, { unknown: true }, { value: undefined }, { value: new Date() }, { value: new Set() }, { value: 9223372036854775808n }, { value: "\ud800" }, accessors, { value: () => secret }]) {
    await expect(db.queryFunction("tasks", args)).rejects.toThrow();
  }
  const customIterator = [new Key("tasks", "a")];
  Object.defineProperty(customIterator, Symbol.iterator, { value: getter });
  await expect(db.getMany(customIterator)).rejects.toThrow();
  await expect(db.get(new Key("tasks", 1))).rejects.toThrow();
  await expect(db.get(new Key("unknown", "a"))).rejects.toMatchObject({ code: "not-implemented" });
  await expect(db.queryFunction("unconfigured")).rejects.toMatchObject({ code: "not-implemented" });
  expect(auth).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
});

it("fails closed on malformed envelope/value/identity and never forwards provider logs or causes", async () => {
  const replies = [
    raw('{"status":"success","status":"error","value":null}'), raw('{"status":"success","value":null} {}'),
    raw('{"status":"success","value":{"_id":"a","__proto__":{"private":true}}}'),
    raw('{"status":"success","value":{"_id":"a","broken":"\\ud800"}}'),
    raw('{"status":"success","value":{"_id":"a","broken":{"$integer":"AA=="}}}'),
    raw('{"status":"success","value":{"_id":"a","broken":{"$float":"AAAAAAAA8D8="}}}'),
    raw('{"status":"success","value":{"_id":"a","broken":{"$bytes":"AB=="}}}'),
    raw('{"status":"success","value":{"_id":"a","broken":{"$commitTs":null}}}'),
    raw('{"status":"success","value":{"_id":"a","broken":1e999}}'),
    raw('{"status":"error","errorMessage":"'+secret+'","errorData":"'+secret+'","logLines":["'+secret+'"]}'),
    reply({ _id: "foreign-private-id" }),
    raw(secret, { status: 403 }), raw(secret, { status: 560 }),
    raw("{}", { headers: { "content-type": "text/plain" } }),
    raw("{}", { headers: { "content-type": "application/json", "content-length": "-1" } }),
    new Response(null, { headers: { "content-type": "application/json" } }),
  ];
  for (const response of replies) {
    const db = new ConvexDatabase(options({ fetch: () => Promise.resolve(response) }));
    try { await db.get(new Key("tasks", "a")); throw new Error("unsafe response accepted"); }
    catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.message).not.toContain(secret); expect(error.message).not.toContain("foreign-private-id");
      expect(error.message).not.toContain("unsafe response accepted"); expect(error.cause).toBeUndefined();
    }
  }
  const redirected = reply(null); Object.defineProperty(redirected, "redirected", { value: true });
  await expect(new ConvexDatabase(options({ fetch: () => Promise.resolve(redirected) })).get(new Key("tasks", "a"))).rejects.toMatchObject({ code: "transport" });
});

it("bounds actual escaped request bytes and aggregate getMany requests, response bytes and rows", async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(reply({ _id: "a", text: "x".repeat(100) })));
  const tinyRequest = new ConvexDatabase(options({ maxRequestBytes: 256, fetch: fetcher }));
  await expect(tinyRequest.queryFunction("tasks", { value: "\n".repeat(100) })).rejects.toMatchObject({ code: "limit" });
  expect(fetcher).not.toHaveBeenCalled();
  const bodyLimit = new ConvexDatabase(options({ maxResponseBytes: 20, fetch: fetcher }));
  await expect(bodyLimit.get(new Key("tasks", "a"))).rejects.toMatchObject({ code: "limit" });
  const rowLimit = new ConvexDatabase(options({ maxRows: 1, fetch: fetcher }));
  const count = fetcher.mock.calls.length;
  await expect(rowLimit.getMany([new Key("tasks", "a"), new Key("tasks", "a")])).rejects.toMatchObject({ code: "limit" });
  expect(fetcher.mock.calls.length).toBe(count + 1);
  const pageLimit = new ConvexDatabase(options({ maxPages: 1, fetch: fetcher }));
  await expect(pageLimit.getMany([new Key("tasks", "a"), new Key("tasks", "a")])).rejects.toMatchObject({ code: "limit" });
});

it("refuses overreturn, duplicate IDs, split pages and repeated server cursors without truncation", async () => {
  for (const page of [
    { page: [{ _id: "a" }, { _id: "b" }], isDone: true, continueCursor: "" },
    { page: [], isDone: false, continueCursor: "" },
    { page: [], isDone: false, continueCursor: "a", pageStatus: "SplitRequired", splitCursor: "half" },
    { page: [], isDone: false, continueCursor: "a", pageStatus: "SplitRecommended" },
    { page: [], isDone: "false", continueCursor: "a" },
  ] as Value[]) {
    await expect(new ConvexDatabase(options({ fetch: () => Promise.resolve(reply(page)) })).queryFunction("tasks", {}, { pageSize: 1 })).rejects.toThrow();
  }
  let attempt = 0;
  const repeated = new ConvexDatabase(options({ fetch: () => Promise.resolve(reply({ page: [], isDone: false, continueCursor: "same" })) }));
  const first = await repeated.queryFunction("tasks", {}, { pageSize: 1 });
  await expect(repeated.queryFunction("tasks", {}, { pageSize: 1, cursor: cursor(first) })).rejects.toMatchObject({ code: "cursor" });
  const duplicates = new ConvexDatabase(options({ fetch: () => Promise.resolve(reply({ page: [{ _id: "a" }], isDone: ++attempt > 1, continueCursor: "page-"+String(attempt) })) }));
  const initial = await duplicates.queryFunction("tasks", {}, { pageSize: 1 });
  await expect(duplicates.queryFunction("tasks", {}, { pageSize: 1, cursor: cursor(initial) })).rejects.toMatchObject({ code: "protocol" });
});

it("bounds cursor registry, cumulative page/work counters and expiry without network on refused resume", async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(reply({ page: [], isDone: false, continueCursor: "next" })));
  const db = new ConvexDatabase(options({ maxCursors: 1, maxWorkRows: 1000, fetch: fetcher }));
  const first = await db.queryFunction("tasks", {}, { pageSize: 1 });
  await expect(db.queryFunction("tasks", {}, { pageSize: 1 })).rejects.toMatchObject({ code: "limit" });
  await expect(db.queryFunction("tasks", {}, { pageSize: 1, cursor: cursor(first) })).rejects.toMatchObject({ code: "limit" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
