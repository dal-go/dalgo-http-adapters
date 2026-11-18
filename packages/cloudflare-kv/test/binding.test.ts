import { afterEach, describe, expect, it, vi } from "vitest";
import { Key } from "@dalgo/core";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { WorkersKvDatabase } from "../src/index.js";
import { bounded, deferred, namespace, options, stream } from "./helpers.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("native existing Workers KV", () => {
  it("preserves raw bytes, empty/missing, metadata and independent duplicate order", async () => {
    const binding = namespace(); const call = vi.spyOn(binding, "getWithMetadata");
    const database = new WorkersKvDatabase(binding, { ...options, cacheTtl: 30 });
    expect(call).not.toHaveBeenCalled();
    const rows = await database.getMany(["tenant:a", "tenant:missing", "tenant:a", "tenant:empty"]);
    expect(rows[0]?.value).toEqual(Uint8Array.of(0, 255, 128)); expect(rows[1]).toBeNull();
    expect(rows[3]?.value.byteLength).toBe(0); expect(rows[0]?.metadata).toEqual({ nested: [false, null, 3] });
    expect(rows[0]).not.toBe(rows[2]); expect(rows[0]?.value).not.toBe(rows[2]?.value);
    rows[0]?.value.fill(7); expect(rows[2]?.value).toEqual(Uint8Array.of(0, 255, 128));
    expect(call).toHaveBeenCalledWith("tenant:a", { type: "stream", cacheTtl: 30 });
    database.close(); await expect(database.get("tenant:a")).rejects.toMatchObject({ code: "closed" });
  });

  it("keeps valid UTF8 keys and refuses invalid scope/surrogates before binding I/O", async () => {
    const binding = namespace(); const call = vi.spyOn(binding, "getWithMetadata");
    const database = new WorkersKvDatabase(binding, options);
    for (const key of ["tenant:🙂/!%2F\u0000", "tenant:" + "é".repeat(252)]) await database.get(key);
    expect(call).toHaveBeenCalledTimes(2);
    for (const key of ["foreign:a", "", ".", "..", "tenant:\ud800", "tenant:" + "é".repeat(253)]) await expect(database.get(key)).rejects.toBeInstanceOf(Error);
    expect(call).toHaveBeenCalledTimes(2);
    expect(() => new WorkersKvDatabase(binding, { allowedPrefixes: [""] })).toThrow();
    expect(() => new WorkersKvDatabase(binding, { ...options, cacheTtl: 29 })).toThrow();
    database.close();
  });

  it("has no binary bulk fallback and closes an acquired reader on byte failure", async () => {
    let cancelled = 0; let receiver = false;
    const binding = namespace();
    binding.getWithMetadata = function (key) {
      receiver = this === binding; expect(typeof key).toBe("string");
      return Promise.resolve({ value: new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(Uint8Array.of(1, 2, 3)); }, cancel() { cancelled++; } }), metadata: null });
    };
    const database = new WorkersKvDatabase(binding, { ...options, maxValueBytes: 2 });
    await expect(database.get("tenant:a")).rejects.toMatchObject({ code: "bounds" });
    expect(receiver).toBe(true); expect(cancelled).toBe(1); database.close();
  });

  it("bounds aggregate bytes and stops later binary reads", async () => {
    const binding = namespace();
    const get = vi.fn(() => Promise.resolve({ value: stream([1, 2, 3]), metadata: null })); binding.getWithMetadata = get;
    const database = new WorkersKvDatabase(binding, { ...options, maxResponseBytes: 10 });
    await expect(database.getMany(["tenant:a", "tenant:b", "tenant:c"])).rejects.toMatchObject({ code: "bounds" });
    expect(get).toHaveBeenCalledTimes(2); database.close();
  });

  it("does not invoke metadata getters or custom iterators", async () => {
    let getters = 0;
    const metadata = Object.defineProperty({}, "hidden", { enumerable: true, get() { getters++; return "private"; } });
    const binding = namespace(); binding.getWithMetadata = () => Promise.resolve({ value: stream(), metadata });
    const database = new WorkersKvDatabase(binding, options);
    await expect(database.get("tenant:a")).rejects.toMatchObject({ code: "protocol" }); expect(getters).toBe(0);
    const keys = ["tenant:a"]; Object.defineProperty(keys, "0", { get() { getters++; return "tenant:a"; } });
    await expect(database.getMany(keys)).rejects.toBeInstanceOf(Error); expect(getters).toBe(0); database.close();
  });

  it("keeps ignored binding work admitted and cancels the exact late stream", async () => {
    const pending = deferred<{ value: ReadableStream<Uint8Array>; metadata: unknown }>();
    const started = deferred<undefined>(); const cleanup = deferred<undefined>(); let calls = 0;
    const binding = namespace(); binding.getWithMetadata = () => { if (++calls === 1) { started.resolve(undefined); return pending.promise; } return Promise.resolve({ value: stream(), metadata: null }); };
    const database = new WorkersKvDatabase(binding, { ...options, maxConcurrent: 1 });
    const caller = new AbortController(); const result = database.get("tenant:a", caller.signal); await bounded(started.promise);
    caller.abort(new Error("PRIVATE_REASON")); await expect(result).rejects.toMatchObject({ reason: "caller" });
    await expect(database.get("tenant:b")).rejects.toMatchObject({ code: "busy" }); expect(calls).toBe(1);
    pending.resolve({ value: new ReadableStream<Uint8Array>({ cancel() { cleanup.resolve(undefined); } }), metadata: null });
    await bounded(cleanup.promise); await Promise.resolve(); await Promise.resolve();
    await expect(database.get("tenant:b")).resolves.toMatchObject({ key: "tenant:b" }); database.close();
  });

  it("cancels after an actual pending stream read and releases its lock", async () => {
    const reading = deferred<undefined>(); const cancelled = deferred<undefined>();
    const value = new ReadableStream<Uint8Array>({ pull() { reading.resolve(undefined); return new Promise<void>(() => undefined); }, cancel() { cancelled.resolve(undefined); } }, { highWaterMark: 0 });
    const binding = namespace(); binding.getWithMetadata = () => Promise.resolve({ value, metadata: null });
    const database = new WorkersKvDatabase(binding, options); const caller = new AbortController();
    const pending = database.get("tenant:a", caller.signal); await bounded(reading.promise); caller.abort("PRIVATE");
    await expect(pending).rejects.toBeInstanceOf(QueryCancelledError); await bounded(cancelled.promise); expect(value.locked).toBe(false); database.close();
  });

  it("checks monotonic expiry after a synchronous binding callback and owns late cleanup", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const cancelled = deferred<undefined>();
    const value = new ReadableStream<Uint8Array>({ cancel() { cancelled.resolve(undefined); } });
    const binding = namespace(); binding.getWithMetadata = () => { now = 11; return Promise.resolve({ value, metadata: null }); };
    const database = new WorkersKvDatabase(binding, { ...options, timeoutMs: 10 });
    await expect(database.get("tenant:a")).rejects.toMatchObject({ reason: "deadline" }); await bounded(cancelled.promise); database.close();
  });

  it("retains a pending cleanup lease without blocking the original cancellation", async () => {
    const reading = deferred<undefined>(); const cancelling = deferred<undefined>(); const release = deferred<undefined>();
    const value = new ReadableStream<Uint8Array>({ pull() { reading.resolve(undefined); return new Promise<void>(() => undefined); }, cancel() { cancelling.resolve(undefined); return release.promise; } }, { highWaterMark: 0 });
    const binding = namespace(); binding.getWithMetadata = () => Promise.resolve({ value, metadata: null });
    const database = new WorkersKvDatabase(binding, { ...options, maxConcurrent: 1 }); const caller = new AbortController();
    const result = database.get("tenant:a", caller.signal); await bounded(reading.promise); caller.abort();
    await expect(result).rejects.toMatchObject({ reason: "caller" }); await bounded(cancelling.promise);
    await expect(database.get("tenant:b")).rejects.toMatchObject({ code: "busy" }); release.resolve(undefined); database.close();
  });

  it("starts cancellation before binding or codec and checks each core decoder", async () => {
    const binding = namespace(); const calls = vi.spyOn(binding, "getWithMetadata");
    const database = new WorkersKvDatabase(binding, options); const caller = new AbortController(); caller.abort();
    await expect(database.get("tenant:a", caller.signal)).rejects.toMatchObject({ reason: "caller" }); expect(calls).not.toHaveBeenCalled();
    const second = new AbortController(); let decodes = 0;
    const codec = { encode: (value: Uint8Array) => value, decode: () => { decodes++; second.abort(); return Uint8Array.of(7); } };
    await expect(database.asDatabase("items").getManyWithSignal([new Key("items", "tenant:a"), new Key("items", "tenant:b")], second.signal, codec)).rejects.toMatchObject({ reason: "caller" });
    expect(decodes).toBe(1); database.close();
  });

  it("exposes configured metadata and explicitly refuses SQL and transactions", async () => {
    const database = new WorkersKvDatabase(namespace(), options);
    expect(database.configuredMetadata()).toEqual({ source: "configured", prefixes: ["tenant:"], transport: "binding", dynamicDiscovery: false });
    const core = database.asDatabase("items"); const worker = vi.fn(() => Promise.resolve(1));
    await expect(core.runReadwriteTransaction(worker)).rejects.toBeInstanceOf(Error); expect(worker).not.toHaveBeenCalled();
    const row = await core.get<Uint8Array>(new Key("items", "tenant:a")); expect(row.exists && row.data).toEqual(Uint8Array.of(0, 255, 128)); database.close();
  });
});
