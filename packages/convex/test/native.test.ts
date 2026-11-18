import { afterEach, describe, expect, it, vi } from "vitest";
import { Key, collection, identityCodec } from "@dalgo/core";
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "convex/values";
import { ConvexDatabase, CONVEX_CAPABILITIES, type ConvexOptions, type ConvexNativePage } from "../src/index.js";

const token = "synthetic-user-jwt-secret";
function options(extra: Partial<ConvexOptions> = {}): ConvexOptions {
  return {
    endpoint: "https://owned.convex.cloud", token,
    collections: { tasks: { getFunction: "dalgo:getTask", staticArgs: { tenant: "user-1" }, fields: [{ name: "title", type: "string" }] } },
    queries: { tasks: { path: "dalgo:listTasks", collection: "tasks", arguments: ["done"], staticArgs: { tenant: "user-1" } } },
    ...extra,
  };
}
function reply(value: Value): Response {
  return new Response(JSON.stringify({ status: "success", value: convexToJson(value), logLines: ["private-provider-log"] }), { headers: { "content-type": "application/json" } });
}
function body(init?: RequestInit): { path: string; args: Record<string, Value> } {
  if (typeof init?.body !== "string") throw new Error("fixture needs string body");
  const raw: unknown = JSON.parse(init.body);
  if (typeof raw !== "object" || raw === null || !("format" in raw) || raw.format !== "convex_encoded_json" || !("path" in raw) || typeof raw.path !== "string" || !("args" in raw) || !Array.isArray(raw.args) || raw.args.length !== 1) throw new Error("wrong native envelope");
  const args = jsonToConvex(raw.args[0] as JSONValue);
  if (typeof args !== "object" || args === null || Array.isArray(args) || args instanceof ArrayBuffer || (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null)) throw new Error("wrong native arguments");
  return { path: raw.path, args: args as Record<string, Value> };
}
function cursor(page: ConvexNativePage): string {
  if (page.nextCursor === undefined) throw new Error("fixture needs an issued cursor");
  return page.nextCursor;
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("configured native Convex functions", () => {
  it("constructs lazily, exposes configured provenance and sends only public query wire", async () => {
    const supplier = vi.fn(() => token);
    const transport = vi.fn<typeof fetch>((url, init) => {
      expect(url).toBe("https://owned.convex.cloud/api/query");
      expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
      expect(init?.headers).toEqual({ authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json" });
      expect(body(init)).toEqual({ path: "dalgo:getTask", args: { id: "a", tenant: "user-1" } });
      return Promise.resolve(reply({ _id: "a", title: "native" }));
    });
    const db = new ConvexDatabase(options({ token: supplier, fetch: transport }));
    expect(supplier).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
    expect(db.metadata()).toMatchObject({ provenance: "trusted-configuration", dynamicDiscovery: false, authorizationVerified: false, queries: [{ alias: "tasks", collection: "tasks" }] });
    expect(Object.isFrozen(db.metadata().collections[0]?.fields)).toBe(true);
    const row = await db.get(new Key("tasks", "a"));
    expect(row).toMatchObject({ exists: true, data: { _id: "a", title: "native" } });
    expect(row.key.id).toBe("a");
    expect(supplier).toHaveBeenCalledTimes(1);
    expect(CONVEX_CAPABILITIES.writes).toBe("NOT_IMPLEMENTED");
  });

  it("preserves int64 bytes nonfinite floats negative zero nested null and strings using official codec", async () => {
    const bytes = new Uint8Array([0, 255, 128]).buffer;
    const native: Value = { _id: "a", min: -9223372036854775808n, max: 9223372036854775807n, wide: 9007199254740993n, bytes, nan: NaN, infinity: Infinity, minus: -Infinity, zero: -0, nested: [null, false, "astral-😀", { value: 0.25 }] };
    const db = new ConvexDatabase(options({ fetch: () => Promise.resolve(reply(native)) }));
    const row = await db.get<Record<string, Value>>(new Key("tasks", "a"));
    expect(row.data).toEqual(native);
    expect(Object.is(row.data?.zero, -0)).toBe(true);
    expect(row.data?.bytes).toBeInstanceOf(ArrayBuffer);
  });

  it("preserves legitimate own constructor/prototype data through encoded point and query without prototype mutation", async () => {
    const beforeConstructor = Object.getOwnPropertyDescriptor(Object.prototype, "constructor");
    const beforePrototype = Object.getOwnPropertyDescriptor(Object.prototype, "prototype");
    const beforeProbe = Object.getOwnPropertyDescriptor(Object.prototype, "convexNativeProbe");
    const native: Value = {
      _id: "a",
      constructor: { prototype: { amount: 9007199254740993n, bytes: new Uint8Array([0, 255]).buffer }, nested: { constructor: "ordinary-data" } },
      prototype: { constructor: false, prototype: null, convexNativeProbe: true },
      nested: [{ constructor: "nested-own-data", prototype: { ok: true } }],
    };
    let point = true;
    const transport = vi.fn<typeof fetch>(() => {
      if (point) { point = false; return Promise.resolve(reply(native)); }
      return Promise.resolve(reply({ page: [native], isDone: true, continueCursor: "" }));
    });
    const db = new ConvexDatabase(options({ fetch: transport }));
    const row = await db.get<Record<string, Value>>(new Key("tasks", "a"));
    if (row.data === undefined) throw new Error("fixture needs a present record");
    expect(row.data).toEqual(native);
    expect(Object.hasOwn(row.data, "constructor")).toBe(true);
    expect(Object.hasOwn(row.data, "prototype")).toBe(true);
    const page = await db.queryFunction("tasks", {}, { pageSize: 1 });
    const first = page.documents[0];
    if (first === undefined) throw new Error("fixture needs a page document");
    expect(first).toEqual(native);
    expect(Object.hasOwn(first, "constructor")).toBe(true);
    expect(Object.hasOwn(first, "prototype")).toBe(true);
    await expect(db.queryFunction("tasks", { constructor: "not-an-argument" })).rejects.toMatchObject({ code: "invalid-input" });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(Object.getOwnPropertyDescriptor(Object.prototype, "constructor")).toEqual(beforeConstructor);
    expect(Object.getOwnPropertyDescriptor(Object.prototype, "prototype")).toEqual(beforePrototype);
    expect(Object.getOwnPropertyDescriptor(Object.prototype, "convexNativeProbe")).toEqual(beforeProbe);
    expect(Object.hasOwn({}, "convexNativeProbe")).toBe(false);
  });

  it("keeps getMany order duplicates missing identities and one shared operation", async () => {
    const transport = vi.fn<typeof fetch>((_url, init) => {
      const args = body(init).args;
      return Promise.resolve(reply(args.id === "missing" ? null : { _id: args.id, title: "native" }));
    });
    const db = new ConvexDatabase(options({ fetch: transport }));
    const rows = await db.getMany([new Key("tasks", "a"), new Key("tasks", "missing"), new Key("tasks", "a")]);
    expect(rows.map(row => [row.key.id, row.exists])).toEqual([["a", true], ["missing", false], ["a", true]]);
    expect(await db.exists(new Key("tasks", "missing"))).toBe(false);
    expect(await db.exists(new Key("tasks", "a"))).toBe(true);
    await db.testConnection(new Key("tasks", "missing"));
    expect(await db.getMany([])).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(6);
  });

  it("snapshots keys and static scopes before codec/token callbacks mutate caller input", async () => {
    const keys: Key[] = [new Key("tasks", "a"), new Key("tasks", "b")];
    const scope = { tenant: "user-1" };
    const seen: Value[] = [];
    const config = options({
      collections: { tasks: { getFunction: "dalgo:getTask", staticArgs: scope } },
      fetch: (_url, init) => {
        const request = body(init); seen.push(request.args.tenant ?? null);
        return Promise.resolve(reply({ _id: request.args.id }));
      },
    });
    const db = new ConvexDatabase(config);
    scope.tenant = "substituted-scope";
    const result = await db.getMany(keys, { ...identityCodec, decode(value: unknown): unknown { keys[1] = new Key("tasks", "substituted"); return value; } });
    expect(result.map(row => row.key.id)).toEqual(["a", "b"]);
    expect(seen).toEqual(["user-1", "user-1"]);
  });

  it("accepts empty unfinished pages and advances exactly the issued cursor, including terminal empty cursor", async () => {
    const seen: Value[] = [];
    const db = new ConvexDatabase(options({ fetch: (_url, init) => {
      const request = body(init); expect(request.path).toBe("dalgo:listTasks");
      expect(request.args.tenant).toBe("user-1"); expect(request.args.done).toBe(false);
      const pagination = request.args.paginationOpts;
      if (typeof pagination !== "object" || pagination === null || Array.isArray(pagination) || pagination instanceof ArrayBuffer) throw new Error("pagination missing");
      if (!("cursor" in pagination) || (pagination.cursor !== null && typeof pagination.cursor !== "string")) throw new Error("native cursor must be null or string");
      const position = pagination.cursor;
      expect(pagination).toMatchObject({ numItems: 1, maximumRowsRead: 1000, maximumBytesRead: 1_048_576 });
      seen.push(position);
      if (position === null) return Promise.resolve(reply({ page: [], isDone: false, continueCursor: "server-1" }));
      if (position === "server-1") return Promise.resolve(reply({ page: [{ _id: "a" }], isDone: false, continueCursor: "server-2" }));
      return Promise.resolve(reply({ page: [{ _id: "b" }], isDone: true, continueCursor: "" }));
    } }));
    const first = await db.queryFunction("tasks", { done: false }, { pageSize: 1 });
    expect(first.documents).toEqual([]); expect(first.isDone).toBe(false);
    expect(first.nextCursor).not.toBe("server-1");
    const second = await db.queryFunction("tasks", { done: false }, { pageSize: 1, cursor: cursor(first) });
    expect(second.documents).toEqual([{ _id: "a" }]);
    await expect(db.queryFunction("tasks", { done: false }, { pageSize: 1, cursor: cursor(first) })).rejects.toMatchObject({ code: "cursor" });
    const final = await db.queryFunction("tasks", { done: false }, { pageSize: 1, cursor: cursor(second) });
    expect(final).toEqual({ documents: [{ _id: "b" }], isDone: true });
    expect(seen).toEqual([null, "server-1", "server-2"]);
  });

  it("binds continuation to exact alias args size auth instance and TTL without leaking tokens", async () => {
    let current = token;
    const transport = vi.fn<typeof fetch>(() => Promise.resolve(reply({ page: [], isDone: false, continueCursor: "server" })));
    const db = new ConvexDatabase(options({ token: () => current, fetch: transport }));
    const first = await db.queryFunction("tasks", { done: false }, { pageSize: 1 });
    for (const extra of [{ pageSize: 2 }, {}]) {
      await expect(db.queryFunction("tasks", { done: true }, { ...extra, cursor: cursor(first) })).rejects.toMatchObject({ code: "cursor" });
    }
    const other = new ConvexDatabase(options({ fetch: transport }));
    await expect(other.queryFunction("tasks", { done: false }, { pageSize: 1, cursor: cursor(first) })).rejects.toMatchObject({ code: "cursor" });
    current = "another-user-token";
    await expect(db.queryFunction("tasks", { done: false }, { pageSize: 1, cursor: cursor(first) })).rejects.toMatchObject({ code: "cursor" });
    expect(transport).toHaveBeenCalledTimes(1);
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValue(1_000_000_000);
    await expect(db.queryFunction("tasks", { done: false }, { pageSize: 1, cursor: cursor(first) })).rejects.toMatchObject({ code: "cursor" });
  });

  it("refuses generic structured queries and transactions before token/fetch and prioritizes preabort", async () => {
    const supplier = vi.fn(() => token), transport = vi.fn<typeof fetch>(() => Promise.resolve(reply(null)));
    const db = new ConvexDatabase(options({ token: supplier, fetch: transport }));
    await expect(db.query(collection("tasks").query().limit(1).build())).rejects.toMatchObject({ code: "not-implemented" });
    await expect(db.runReadwriteTransaction(() => Promise.resolve())).rejects.toMatchObject({ code: "not-implemented" });
    const controller = new AbortController(); controller.abort("private abort");
    await expect(db.getWithSignal(new Key("tasks", "a"), controller.signal)).rejects.toMatchObject({ reason: "caller" });
    await expect(db.queryWithSignal(collection("tasks").query().build(), controller.signal)).rejects.toMatchObject({ reason: "caller" });
    expect(supplier).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
});
