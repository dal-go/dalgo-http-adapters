import { expect, it, vi } from "vitest";
import { WorkersKvDatabase } from "../src/index.js";
import { CloudflareKvHttpDatabase, createCloudflareKvHttpHandler } from "../src/http.js";
import { bounded, deferred, namespace, options } from "./helpers.js";

it("requires host authorization and rejects client authority/endpoint descriptors", async () => {
  let auth = 0; const native = new WorkersKvDatabase(namespace(), options);
  const handler = createCloudflareKvHttpHandler({ authorize: (request) => { auth++; return request.headers.get("authorization") === "Bearer application-reader" ? native : undefined; } });
  const send = (value: unknown, token = ""): Promise<Response> => handler(new Request("https://owned.invalid/kv", { method: "POST", headers: { "content-type": "application/json", authorization: token }, body: JSON.stringify(value) }));
  expect((await send({ kind: "getMany", keys: ["tenant:a"], endpoint: "https://private.invalid", token: "private" })).status).toBe(400); expect(auth).toBe(0);
  expect((await send({ kind: "getMany", keys: ["tenant:a"] })).status).toBe(403);
  const result = await send({ kind: "getMany", keys: ["foreign:a"] }, "Bearer application-reader"); expect(result.status).toBe(403); native.close();
});
it("round-trips byte tags/missing/metadata through the fixed trusted bridge and pure browser client", async () => {
  const native = new WorkersKvDatabase(namespace(), options);
  const handler = createCloudflareKvHttpHandler({ authorize: () => native });
  const database = new CloudflareKvHttpDatabase({ endpoint: "https://owned.invalid/kv", fetch: (input, init) => handler(new Request(input, init)) });
  const rows = await database.getMany(["tenant:a", "tenant:missing", "tenant:a", "tenant:empty"]);
  expect(rows[0]?.value).toEqual(Uint8Array.of(0, 255, 128)); expect(rows[1]).toBeNull(); expect(rows[3]?.value.byteLength).toBe(0); expect(rows[0]?.metadata).toEqual({ nested: [false, null, 3] });
  rows[0]?.value.fill(7); expect(rows[2]?.value).toEqual(Uint8Array.of(0, 255, 128));
  expect((await database.list({ prefix: "tenant:", limit: 1 })).keys[0]).toEqual({ name: "tenant:a", metadata: false, expiration: 123 }); database.close(); native.close();
});
it("preserves the server deadline reason, omits raw causes, and has no anonymous fallback", async () => {
  vi.useFakeTimers(); const started = deferred<undefined>();
  const handler = createCloudflareKvHttpHandler({ timeoutMs: 10, authorize: (_request, signal) => new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => { reject(new Error("PRIVATE_TOKEN")); }, { once: true }); started.resolve(undefined); }) });
  const database = new CloudflareKvHttpDatabase({ endpoint: "https://owned.invalid/kv", timeoutMs: 1000, fetch: (input, init) => handler(new Request(input, init)) });
  try {
    const pending = database.get("tenant:a"); await bounded(started.promise);
    const outcome = expect(pending).rejects.toMatchObject({ reason: "deadline" });
    await vi.advanceTimersByTimeAsync(10); await outcome;
  } finally { database.close(); vi.useRealTimers(); }
});
it("rejects forged byte/result shape and bounded request expansion before headers/fetch", async () => {
  let headers = 0; let io = 0;
  const database = new CloudflareKvHttpDatabase({ endpoint: "https://owned.invalid/kv", maxRequestBytes: 30, headers: () => { headers++; return {}; }, fetch: () => { io++; return Promise.resolve(Response.json({})); } });
  await expect(database.get("tenant:" + "\u0000".repeat(100))).rejects.toMatchObject({ code: "bounds" }); expect(headers).toBe(0); expect(io).toBe(0); database.close();
  const forged = new CloudflareKvHttpDatabase({ endpoint: "https://owned.invalid/kv", fetch: () => Promise.resolve(Response.json({ kind: "entries", entries: [{ key: "other", value: "AA==" }] })) });
  await expect(forged.get("tenant:a")).rejects.toMatchObject({ code: "protocol" }); forged.close();
});
