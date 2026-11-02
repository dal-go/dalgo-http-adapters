import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { CloudflareKvRestDatabase } from "../src/rest.js";
import { bounded, deferred, options } from "./helpers.js";

afterEach(() => { vi.restoreAllMocks(); });
function rest(fetcher: typeof fetch, extra: Partial<ConstructorParameters<typeof CloudflareKvRestDatabase>[0]> = {}): CloudflareKvRestDatabase {
  return new CloudflareKvRestDatabase({ ...options, accountId: "account", namespaceId: "namespace", token: () => "synthetic-reader", fetch: fetcher, ...extra });
}
const raw = (): Response => new Response(Uint8Array.of(0, 255, 128), { headers: { expiration: "123" } });
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input !== "string") throw new Error("owned REST fixture expected the fixed serialized URL");
  return input;
}
it("uses one exactly encoded key segment and bearer-only fixed authority", async () => {
  const calls: string[] = [];
  const database = rest((input, init) => {
    calls.push(requestUrl(input)); expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-reader");
    return Promise.resolve(raw());
  });
  expect(calls).toEqual([]); const value = await database.get("tenant:/!%2F🙂");
  expect(calls).toEqual(["https://api.cloudflare.com/client/v4/accounts/account/storage/kv/namespaces/namespace/values/tenant%3A%2F%21%252F%F0%9F%99%82"]);
  expect(value?.value).toEqual(Uint8Array.of(0, 255, 128)); expect(value?.expiration).toBe(123); database.close();
});
it("never turns namespace/auth404 into missing and never retries429", async () => {
  for (const status of [401, 403, 404, 429, 302]) {
    let calls = 0; const database = rest(() => { calls++; return Promise.resolve(new Response("PRIVATE_PROVIDER_BODY", { status })); });
    await expect(database.get("tenant:missing")).rejects.toMatchObject({ status }); expect(calls).toBe(1); database.close();
  }
});
it("validates scope, full escaped request bytes, minimumRESTpage and token expiry before fetch", async () => {
  let auth = 0; let io = 0;
  const database = rest(() => { io++; return Promise.resolve(raw()); }, { token: () => { auth++; return "synthetic"; }, maxRequestBytes: 150 });
  await expect(database.get("tenant:" + "\u0000".repeat(100))).rejects.toMatchObject({ code: "bounds" });
  await expect(database.get("other:a")).rejects.toMatchObject({ code: "permission" });
  await expect(database.list({ prefix: "tenant:", limit: 1 })).rejects.toMatchObject({ code: "bounds" });
  expect(auth).toBe(0); expect(io).toBe(0); database.close();
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  const expired = rest(() => { io++; return Promise.resolve(raw()); }, { token: () => { now = 11; return "private"; }, timeoutMs: 10 });
  await expect(expired.get("tenant:a")).rejects.toMatchObject({ reason: "deadline" }); expect(io).toBe(0); expired.close();
});
it("uses REST opaque cursor EOF and refuses an unusable successor before ACK", async () => {
  let calls = 0;
  const database = rest((input) => {
    const url = new URL(requestUrl(input)); expect(url.searchParams.get("limit")).toBe("10"); expect(url.searchParams.get("prefix")).toBe("tenant:");
    return Promise.resolve(Response.json(++calls === 1 ? { success: true, result: [], result_info: { cursor: "native-a", count: 0 } } : { success: true, result: [{ name: "tenant:a", metadata: 7 }], result_info: { cursor: "", count: 1 } }));
  });
  const first = await database.list({ prefix: "tenant:", limit: 10 }); expect(first.complete).toBe(false); if (first.nextCursor === undefined) throw new Error("no cursor");
  const second = await database.list({ prefix: "tenant:", limit: 10, cursor: first.nextCursor }); expect(second.complete).toBe(true); expect(second.keys[0]?.metadata).toBe(7); expect(calls).toBe(2); database.close();
  const huge = rest(() => Promise.resolve(Response.json({ success: true, result: [], result_info: { cursor: "x".repeat(1000) } })), { maxRequestBytes: 250 });
  await expect(huge.list({ prefix: "tenant:", limit: 10 })).rejects.toMatchObject({ code: "bounds" }); huge.close();
});
it("caps raw wire before parse and rejects duplicate JSON and malformed fields", async () => {
  for (const [body, code] of [['{"success":true,"success":true,"result":[]}', "protocol"], ['{"success":true,"result":[{"name":"tenant:a","metadata":"\\ud800"}]}', "protocol"], ['{"success":true,"result":[{"name":"other:a"}]}', "permission"]] as const) {
    const database = rest(() => Promise.resolve(new Response(body)));
    await expect(database.list({ prefix: "tenant:", limit: 10 })).rejects.toMatchObject({ code }); database.close();
  }
  let cancelled = 0;
  const database = rest(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(20)); }, cancel() { cancelled++; } }))), { maxResponseBytes: 10 });
  await expect(database.list({ prefix: "tenant:", limit: 10 })).rejects.toMatchObject({ code: "bounds" }); expect(cancelled).toBe(1); database.close();
});
it("retains ignored credentials, owns a late response, and never leaks raw causes", async () => {
  const started = deferred<undefined>(); const pending = deferred<Response>(); const cleaned = deferred<undefined>(); let calls = 0;
  const database = rest(() => { calls++; started.resolve(undefined); return pending.promise; }, { maxConcurrent: 1 });
  const caller = new AbortController(); const result = database.get("tenant:a", caller.signal); await bounded(started.promise); caller.abort(new Error("PRIVATE_CAUSE"));
  await expect(result).rejects.toMatchObject({ reason: "caller" }); await expect(database.get("tenant:b")).rejects.toMatchObject({ code: "busy" });
  pending.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cleaned.resolve(undefined); return Promise.reject(new Error("PRIVATE_CANCEL")); } })));
  await bounded(cleaned.promise); await Promise.resolve(); expect(calls).toBe(1); database.close();
  const failed = rest(() => Promise.reject(new Error("PRIVATE_ENDPOINT_TOKEN")));
  try { await failed.get("tenant:a"); throw new Error("expected failure"); } catch (error) { expect(error).toMatchObject({ code: "transport" }); expect(error).not.toHaveProperty("cause"); expect(String(error)).not.toContain("PRIVATE"); } finally { failed.close(); }
});
it("retains noncooperative token work and never dispatches its late result", async () => {
  const started = deferred<undefined>(); const pending = deferred<string>(); let tokens = 0; let requests = 0;
  const database = rest(() => { requests++; return Promise.resolve(raw()); }, { maxConcurrent: 1, token: () => { if (++tokens === 1) { started.resolve(undefined); return pending.promise; } return "synthetic-reader"; } });
  const caller = new AbortController(); const result = database.get("tenant:a", caller.signal); await bounded(started.promise); caller.abort();
  await expect(result).rejects.toMatchObject({ reason: "caller" }); await expect(database.get("tenant:b")).rejects.toMatchObject({ code: "busy" }); expect(requests).toBe(0);
  pending.resolve("late-private"); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(requests).toBe(0); expect((await database.get("tenant:b"))?.value).toEqual(Uint8Array.of(0, 255, 128)); expect(tokens).toBe(2); database.close();
});
it("classifies cancellation triggered by failure cleanup without aborting successful scope disposal", async () => {
  const caller = new AbortController();
  const database = rest(() => Promise.reject(new Error("PRIVATE_PROVIDER")), { token: (signal) => { signal.addEventListener("abort", () => { caller.abort(); }, { once: true }); return "synthetic-reader"; } });
  await expect(database.get("tenant:a", caller.signal)).rejects.toMatchObject({ reason: "caller" }); database.close();
  const second = new AbortController();
  const success = rest(() => Promise.resolve(raw()), { token: (signal) => { signal.addEventListener("abort", () => { second.abort(); }, { once: true }); return "synthetic-reader"; } });
  expect((await success.get("tenant:a", second.signal))?.value).toEqual(Uint8Array.of(0, 255, 128)); expect(second.signal.aborted).toBe(false); success.close();
});
it("uses owned Node HTTP agents and proves dispatched caller abort, disconnect and reopen", async () => {
  const started = deferred<undefined>(); const disconnected = deferred<undefined>(); let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    if (request.headers.authorization !== "Bearer synthetic-reader") { response.writeHead(403).end(); return; }
    if (request.url?.endsWith("/tenant%3Acancel") === true) {
      response.once("close", () => { if (!response.writableFinished) disconnected.resolve(undefined); }); started.resolve(undefined); return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" }); response.end(Uint8Array.of(0, 255, 128));
  });
  await bounded(new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); }));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("owned address absent");
  const database = new CloudflareKvRestDatabase({ ...options, accountId: "account", namespaceId: "namespace", token: () => "synthetic-reader", endpoint: `http://127.0.0.1:${String(address.port)}/client/v4`, allowLoopbackHttpForTesting: true, timeoutMs: 1000 });
  try {
    const caller = new AbortController(); const pending = database.get("tenant:cancel", caller.signal); await bounded(started.promise); caller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "caller" }); await bounded(disconnected.promise);
    expect((await database.get("tenant:a"))?.value).toEqual(Uint8Array.of(0, 255, 128)); expect(calls).toBe(2);
  } finally { database.close(); server.closeAllConnections(); await bounded(new Promise<void>((resolve) => { server.close(() => { resolve(); }); })); }
});
