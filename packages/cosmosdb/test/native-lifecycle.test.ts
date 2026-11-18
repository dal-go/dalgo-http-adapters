import { identityCodec, type Codec } from "@dalgo/core";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeCosmosError, NativeCosmosHttpError, nativeCosmosResourceToken, type NativeCosmosCredential } from "../src/index.js";
import { deferred, nativeDocument, nativeKey, response, setup } from "./native-fixture.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("native Cosmos owned lifecycle", () => {
  it("refuses pre-abort before credential acquisition or borrowed fetch", async () => {
    const { database, authorization, fetch } = setup(); const caller = new AbortController(); caller.abort("PRIVATE");
    await expect(database.getNative(nativeKey, { signal: caller.signal })).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    expect(authorization).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); database.close();
  });
  it("bounds credential waiting and retains its physical lease until the actual ignored provider settles", async () => {
    const entered = deferred<undefined>(); const credential = deferred<NativeCosmosCredential>(); const caller = new AbortController();
    const { database, fetch } = setup({ maxConcurrent: 1, authorization: () => { entered.resolve(undefined); return credential.promise; } });
    const outcome = expect(database.getNative(nativeKey, { signal: caller.signal })).rejects.toMatchObject({ reason: "caller" });
    await entered.promise; caller.abort(); await outcome;
    await expect(database.getNative(nativeKey)).rejects.toMatchObject({ code: "busy" });
    credential.resolve(nativeCosmosResourceToken("type=resource&ver=1.0&sig=owned"));
    fetch.mockImplementation(() => Promise.resolve(response()));
    await vi.waitFor(async () => { expect((await database.getNative(nativeKey)).document?.key).toEqual(nativeKey); });
    expect(fetch).toHaveBeenCalledTimes(1); database.close();
  });
  it("starts the deadline before credentials and handles late rejection without dispatch", async () => {
    vi.useFakeTimers(); const entered = deferred<undefined>(); const credential = deferred<NativeCosmosCredential>();
    const { database, fetch } = setup({ timeoutMs: 10, authorization: () => { entered.resolve(undefined); return credential.promise; } });
    const outcome = expect(database.getNative(nativeKey)).rejects.toMatchObject({ name: "QueryCancelledError", reason: "deadline" });
    await entered.promise; await vi.advanceTimersByTimeAsync(10); await outcome;
    credential.reject(new Error("PRIVATE_CREDENTIAL")); await Promise.resolve(undefined);
    expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); database.close();
  });
  it("observes a synchronous credential callback crossing an unserviced monotonic deadline", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const { database, fetch } = setup({ timeoutMs: 10, authorization: () => { now = 11; return nativeCosmosResourceToken("type=resource&ver=1.0&sig=owned"); } });
    await expect(database.getNative(nativeKey)).rejects.toMatchObject({ reason: "deadline" }); expect(fetch).not.toHaveBeenCalled(); database.close();
  });
  it("owns late fetch bodies and hostile cleanup without early physical-slot release", async () => {
    const entered = deferred<undefined>(); const late = deferred<Response>(); const cleaned = deferred<undefined>(); const cancelDone = deferred<undefined>(); const caller = new AbortController();
    const { database, fetch } = setup({ maxConcurrent: 1 });
    const cancel = vi.fn(() => { cleaned.resolve(undefined); return cancelDone.promise; });
    fetch.mockImplementationOnce(() => { entered.resolve(undefined); return late.promise; });
    const outcome = expect(database.getNative(nativeKey, { signal: caller.signal })).rejects.toMatchObject({ reason: "caller" });
    await entered.promise; caller.abort(); await outcome;
    await expect(database.getNative(nativeKey)).rejects.toMatchObject({ code: "busy" });
    late.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await cleaned.promise; expect(cancel).toHaveBeenCalledTimes(1);
    await expect(database.getNative(nativeKey)).rejects.toMatchObject({ code: "busy" });
    cancelDone.resolve(undefined); fetch.mockImplementation(() => Promise.resolve(response()));
    await vi.waitFor(async () => { expect((await database.getNative(nativeKey)).document?.key).toEqual(nativeKey); });
    database.close();
  });
  it("establishes acquired reader ownership before a synchronous getReader revokes the caller", async () => {
    const caller = new AbortController(); const cancel = vi.fn(); const body = new ReadableStream<Uint8Array>({ cancel }); const owned = new Response(body);
    const getReader = body.getReader.bind(body);
    vi.spyOn(body, "getReader").mockImplementation(() => { const reader = getReader(); caller.abort(); return reader; });
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(owned);
    await expect(database.getNative(nativeKey, { signal: caller.signal })).rejects.toMatchObject({ reason: "caller" });
    expect(cancel).toHaveBeenCalledTimes(1); expect(body.locked).toBe(false); database.close();
  });
  it("freshly classifies reader release callbacks after EOF and never returns a successful prefix", async () => {
    const caller = new AbortController(); const owned = response(); const body = owned.body;
    if (body === null) throw new Error("fixture requires body");
    const getReader = body.getReader.bind(body);
    vi.spyOn(body, "getReader").mockImplementation(() => {
      const reader = getReader(); const release = reader.releaseLock.bind(reader);
      vi.spyOn(reader, "releaseLock").mockImplementation(() => { release(); caller.abort(); throw new Error("PRIVATE_RELEASE"); });
      return reader;
    });
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(owned);
    await expect(database.getNative(nativeKey, { signal: caller.signal })).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    expect(body.locked).toBe(false); database.close();
  });
  it("uses one aggregate response budget and copied native batch keys without later dispatch on failure", async () => {
    const keys = [{ ...nativeKey }, { id: "b", partition: "tenant:a" }, { id: "c", partition: "tenant:a" }];
    const bytes = new TextEncoder().encode(nativeDocument).length;
    const { database, fetch } = setup({ maxResponseBytes: bytes + 1 });
    fetch.mockImplementation(() => { keys[1] = { id: "changed", partition: "other" }; return Promise.resolve(response()); });
    await expect(database.getManyNative(keys)).rejects.toMatchObject({ code: "bounds" });
    expect(fetch).toHaveBeenCalledTimes(2); const second = fetch.mock.calls[1]?.[0];
    if (typeof second !== "string") throw new Error("fixture expects a URL string");
    expect(second).toMatch(/\/docs\/b$/u); database.close();
  });
  it("preserves caller priority when an HTTP-error body cleanup cancels the original caller", async () => {
    const caller = new AbortController(); const cancel = vi.fn(() => { caller.abort("PRIVATE"); return Promise.reject(new Error("PRIVATE_CANCEL")); });
    const owned = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 403 });
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(owned);
    await expect(database.getNative(nativeKey, { signal: caller.signal })).rejects.toMatchObject({ reason: "caller" });
    expect(cancel).toHaveBeenCalledTimes(1); database.close();
  });
  it("guards final caller codecs and Close before successful delivery", async () => {
    for (const close of [false, true]) {
      const caller = new AbortController(); const { database, fetch } = setup(); fetch.mockResolvedValueOnce(response());
      const codec: Codec<unknown> = { ...identityCodec, decode: value => { if (close) database.close(); else caller.abort(); return value; } };
      const error: unknown = await database.getNative(nativeKey, { signal: caller.signal, codec }).catch((failure: unknown) => failure);
      if (close) expect(error).toMatchObject({ code: "closed" }); else expect(error).toBeInstanceOf(QueryCancelledError);
      database.close();
    }
  });
  it("bounds declared lengths, invalid UTF8 and structural headers with safe errors and cleanup", async () => {
    const { database, fetch } = setup({ maxResponseBytes: 1024 });
    for (const owned of [response(nativeDocument, { "content-length": "1025" }), new Response(new Uint8Array([0xff])), response(nativeDocument, { "x-ms-session-token": "x".repeat(16_385) }), response(nativeDocument, { "x-ms-request-charge": "NaN" })]) {
      fetch.mockResolvedValueOnce(owned); const error: unknown = await database.getNative(nativeKey).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("original"); expect(owned.body?.locked).toBe(false);
    }
    database.close();
  });
  it("redacts foreign errors even when a callback forges or mutates public error classes", async () => {
    const forged = new NativeCosmosHttpError(403, { activityId: "PRIVATE_PAYLOAD" }); forged.message = "PRIVATE_TOKEN";
    const { database, fetch } = setup(); fetch.mockRejectedValueOnce(forged);
    const failure: unknown = await database.getNative(nativeKey).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "transport" }); expect(JSON.stringify(failure)).not.toContain("PRIVATE"); expect(String(failure)).not.toContain("PRIVATE");
    const mutable = new NativeCosmosError("input"); mutable.message = "PRIVATE_CODEC";
    const codec: Codec<unknown> = { ...identityCodec, decode: () => { throw mutable; } };
    fetch.mockResolvedValueOnce(response());
    const decoded: unknown = await database.getNative(nativeKey, { codec }).catch((error: unknown) => error);
    expect(decoded).toMatchObject({ code: "transport" }); expect(String(decoded)).not.toContain("PRIVATE"); database.close();
  });
  it("uses authentic pre-abort state despite a genuine signal's false or throwing own property", async () => {
    for (const throwing of [false, true]) {
      const caller = new AbortController(); const getter = vi.fn(() => { throw new Error("PRIVATE_SIGNAL_GETTER"); });
      Object.defineProperty(caller.signal, "aborted", throwing ? { get: getter } : { value: false });
      caller.abort("PRIVATE_CALLER_REASON");
      const { database, fetch, authorization } = setup();
      const failure: unknown = await database.getNative(nativeKey, { signal: caller.signal }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ name: "QueryCancelledError", reason: "caller" }); expect(String(failure)).not.toContain("PRIVATE");
      expect(getter).not.toHaveBeenCalled(); expect(authorization).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); database.close();
    }
  });
  it("classifies actual dispatched caller abort behind genuine signal shadow properties and can reopen", async () => {
    for (const throwing of [false, true]) {
      const caller = new AbortController(); const getter = vi.fn(() => { throw new Error("PRIVATE_SIGNAL_GETTER"); });
      Object.defineProperty(caller.signal, "aborted", throwing ? { get: getter } : { value: false });
      const entered = deferred<undefined>(); const { database, fetch } = setup();
      fetch.mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal; if (signal == null) throw new Error("fixture requires owned signal");
        signal.addEventListener("abort", () => { reject(new Error("PRIVATE_FETCH_FAILURE")); }, { once: true });
        entered.resolve(undefined);
      }));
      const outcome = expect(database.getNative(nativeKey, { signal: caller.signal })).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
      await entered.promise; caller.abort("PRIVATE_CALLER_REASON"); await outcome;
      expect(getter).not.toHaveBeenCalled(); fetch.mockResolvedValueOnce(response());
      expect((await database.getNative(nativeKey)).document?.key).toEqual(nativeKey); database.close();
    }
  });
  it("preserves authentic caller priority when body cleanup aborts a signal with a throwing own getter", async () => {
    const caller = new AbortController(); const getter = vi.fn(() => { throw new Error("PRIVATE_SIGNAL_GETTER"); });
    Object.defineProperty(caller.signal, "aborted", { get: getter });
    const cancelled = vi.fn(() => { caller.abort("PRIVATE_CALLER_REASON"); return Promise.reject(new Error("PRIVATE_CLEANUP")); });
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), { status: 403 }));
    const failure: unknown = await database.getNative(nativeKey, { signal: caller.signal }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "QueryCancelledError", reason: "caller" }); expect(String(failure)).not.toContain("PRIVATE");
    expect(getter).not.toHaveBeenCalled(); expect(cancelled).toHaveBeenCalledTimes(1); database.close();
  });
  it("normalizes an unexpected clock failure at freshness rather than forwarding a foreign exception", async () => {
    let failed = false; vi.spyOn(performance, "now").mockImplementation(() => { if (failed) throw new Error("PRIVATE_CLOCK_FAILURE"); return 0; });
    const { database, fetch } = setup({ authorization: () => { failed = true; return nativeCosmosResourceToken("type=resource&ver=1.0&sig=owned"); } });
    try {
      const failure: unknown = await database.getNative(nativeKey).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NativeCosmosError); expect(failure).toMatchObject({ code: "transport" });
      expect(String(failure)).not.toContain("PRIVATE"); expect(fetch).not.toHaveBeenCalled();
    } finally { failed = false; database.close(); }
  });
  it("ignores a borrowed fetch's owned-signal getter while retaining late-body cleanup and its physical lease", async () => {
    const caller = new AbortController(); const getter = vi.fn(() => { throw new Error("PRIVATE_OWNED_SIGNAL_GETTER"); });
    const cleaned = deferred<undefined>(); const cleanupDone = deferred<undefined>();
    const cancel = vi.fn(() => { cleaned.resolve(undefined); return cleanupDone.promise; });
    const body = new ReadableStream<Uint8Array>({ cancel }); const owned = new Response(body);
    const { database, fetch } = setup({ maxConcurrent: 1 });
    fetch.mockImplementationOnce((_url, init) => {
      const signal = init?.signal; if (signal == null) throw new Error("fixture requires owned signal");
      Object.defineProperty(signal, "aborted", { get: getter }); caller.abort("PRIVATE_CALLER_REASON");
      return Promise.resolve(owned);
    });
    await expect(database.getNative(nativeKey, { signal: caller.signal })).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    await cleaned.promise; expect(cancel).toHaveBeenCalledTimes(1); expect(getter).not.toHaveBeenCalled(); expect(body.locked).toBe(false);
    await expect(database.getNative(nativeKey)).rejects.toMatchObject({ code: "busy" });
    cleanupDone.resolve(undefined); fetch.mockImplementation(() => Promise.resolve(response()));
    await vi.waitFor(async () => { expect((await database.getNative(nativeKey)).document?.key).toEqual(nativeKey); }); database.close();
  });
});
