import { describe, expect, it, vi } from "vitest";
import { MongoHttpClient, createMongoHttpHandler } from "../src/http.js";
import type { MongoReadExecutor } from "../src/types.js";
import { QueryCancelledError } from "@dalgo/adapter-runtime";

const documents = { kind: "documents", documents: [{ _id: { $oid: "000000000000000000000001" }, value: { $numberLong: "9007199254740993" } }] } as const;
function request(body: unknown): Request {
  return new Request("https://app.example/mongo", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer scoped-user" }, body: JSON.stringify(body) });
}

describe("MongoDB trusted HTTP boundary", () => {
  it("runs through required user/connection authorization and returns canonical BSON without credentials", async () => {
    const execute = vi.fn(() => Promise.resolve(documents));
    const authorize = vi.fn((http: Request, id: string) => Promise.resolve(http.headers.get("authorization") === "Bearer scoped-user" && id === "owned" ? { execute } : undefined));
    const handler = createMongoHttpHandler({ authorize });
    const transport: typeof fetch = async (input, init) => handler(new Request(input instanceof Request ? input : String(input), init));
    const client = new MongoHttpClient({ endpoint: "https://app.example/mongo", connectionId: "owned", headers: () => ({ authorization: "Bearer scoped-user" }), fetch: transport });
    expect(await client.execute({ kind: "find", collection: "products", limit: 10 })).toEqual(documents);
    expect(authorize).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("denies unknown connections and refuses client URI/options before execution", async () => {
    const execute = vi.fn(() => Promise.resolve(documents));
    const handler = createMongoHttpHandler({ authorize: (_http, id) => Promise.resolve(id === "owned" ? { execute } : undefined) });
    expect((await handler(request({ connectionId: "foreign", request: { kind: "find", collection: "products", limit: 1 } }))).status).toBe(403);
    expect((await handler(request({ connectionId: "owned", uri: "mongodb://secret", request: { kind: "find", collection: "products", limit: 1 } }))).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("caps incomplete request streams and cancels slow authorization without returning secrets", async () => {
    const handler = createMongoHttpHandler({ authorize: () => new Promise(() => undefined), timeoutMs: 5, maxRequestBytes: 256 });
    const response = await handler(request({ connectionId: "owned", request: { kind: "find", collection: "products", limit: 1 } }));
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: "cancelled", reason: "deadline" });
    const oversized = await handler(request({ connectionId: "owned", padding: "x".repeat(257) }));
    expect(oversized.status).toBe(413);
  });

  it("redacts authorization exceptions and sets private no-store responses", async () => {
    const handler = createMongoHttpHandler({ authorize: () => Promise.reject(new Error("mongodb://alice:secret@host")) });
    const response = await handler(request({ connectionId: "owned", request: { kind: "discover" } }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("cancels hanging fetch and header providers without waiting for them", async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const controller = new AbortController();
    const client = new MongoHttpClient({ endpoint: "https://app.example/mongo", connectionId: "owned", fetch: fetcher });
    const pending = client.execute({ kind: "discover" }, controller.signal);
    controller.abort("secret");
    await expect(pending).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller", message: "query cancelled by caller" });
    const waiting = new MongoHttpClient({ endpoint: "https://app.example/mongo", connectionId: "owned", headers: () => new Promise(() => undefined), fetch: fetcher, timeoutMs: 5 });
    await expect(waiting.execute({ kind: "discover" })).rejects.toMatchObject({ reason: "deadline" });
  });

  it("caps response bytes and rejects malformed success envelopes", async () => {
    const tooLarge = new MongoHttpClient({ endpoint: "https://app.example/mongo", connectionId: "owned", maxResponseBytes: 100, fetch: () => Promise.resolve(new Response(JSON.stringify({ ...documents, padding: "x".repeat(101) }), { headers: { "content-type": "application/json" } })) });
    await expect(tooLarge.execute({ kind: "find", collection: "products", limit: 10 })).rejects.toMatchObject({ code: "bounds" });
    const wrong = new MongoHttpClient({ endpoint: "https://app.example/mongo", connectionId: "owned", fetch: () => Promise.resolve(new Response(JSON.stringify({ kind: "collections", source: "server-admin", collections: ["private"] }), { headers: { "content-type": "application/json" } })) });
    await expect(wrong.execute({ kind: "discover" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("requires an explicit authorization function", () => {
    expect(() => createMongoHttpHandler({} as Parameters<typeof createMongoHttpHandler>[0])).toThrow("permission");
    // A structural executor is sufficient; Mongo credentials never cross the boundary.
    const executor: MongoReadExecutor = { execute: () => Promise.resolve(documents) };
    expect(typeof createMongoHttpHandler({ authorize: () => Promise.resolve(executor) })).toBe("function");
  });

  it("preserves a shorter server deadline and server caller cancellation through the HTTP client", async () => {
    const handler = createMongoHttpHandler({ timeoutMs: 5, authorize: () => Promise.resolve({ execute: () => new Promise(() => undefined) }) });
    const transport: typeof fetch = (input, init) => handler(new Request(input instanceof Request ? input : String(input), init));
    const client = new MongoHttpClient({ endpoint: "https://app.example/mongo", connectionId: "owned", timeoutMs: 1000, fetch: transport });
    await expect(client.execute({ kind: "discover" })).rejects.toMatchObject({ name: "QueryCancelledError", reason: "deadline", message: "query deadline exceeded" });
    const cancelled = createMongoHttpHandler({ authorize: () => Promise.resolve({ execute: () => Promise.reject(new QueryCancelledError("caller")) }) });
    const remoteCaller = new MongoHttpClient({ endpoint: "https://app.example/mongo", connectionId: "owned", fetch: (input, init) => cancelled(new Request(input instanceof Request ? input : String(input), init)) });
    await expect(remoteCaller.execute({ kind: "discover" })).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
  });

  it("rejects a success whose executor fulfillment races a caller abort", async () => {
    const controller = new AbortController();
    const handler = createMongoHttpHandler({ authorize: () => Promise.resolve({ execute: () => {
      const pending = Promise.resolve(documents);
      void pending.then(() => { queueMicrotask(() => { controller.abort("redacted"); }); });
      return pending;
    } }) });
    const response = await handler(new Request("https://app.example/mongo", {
      method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ connectionId: "owned", request: { kind: "find", collection: "products", limit: 1 } }),
    }));
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: "cancelled", reason: "caller" });
  });
});
