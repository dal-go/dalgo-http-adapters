import { collection, type Codec } from "@dalgo/core";
import { isCancellableQueryExecutor, QueryCancelledError } from "@dalgo/adapter-runtime";
import { describe, expect, it, vi } from "vitest";
import { InfluxDB3Database, InfluxDB3HttpError, InfluxDB3TransportError, type InfluxDB3DatabaseOptions } from "../src/index.js";

const items = collection<{ value: string }>("items");
const secret = "synthetic-private-provider-detail";
const row = (id = "one"): Response => new Response(JSON.stringify([{ __dalgo_key: id, value: "ok" }]));

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve: (value: T) => void = () => { throw new Error("uninitialized deferred"); };
  let reject: (error: unknown) => void = () => { throw new Error("uninitialized deferred"); };
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function database(options: Partial<InfluxDB3DatabaseOptions> = {}): InfluxDB3Database {
  return new InfluxDB3Database({
    database: "owned_fixture", serverUrl: "https://influx.example.test",
    accessToken: () => "synthetic-token", timeoutMs: 1000,
    tables: { items: { table: "existing_items", keyColumn: { column: "id", nullable: false }, columns: { value: { column: "value" } } } },
    fetch: () => Promise.resolve(row()), ...options,
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error: unknown) { return error; }
  throw new Error("expected operation refusal");
}

function cancelled(error: unknown, reason: "caller" | "deadline"): void {
  expect(error).toBeInstanceOf(QueryCancelledError);
  expect(error).toMatchObject({ reason });
  expect(String(error)).not.toContain(secret);
  expect(error).not.toHaveProperty("cause");
}

describe("Influx whole-operation lifecycle", () => {
  it("exposes additive signals without invoking token or fetch for pre-abort", async () => {
    const accessToken = vi.fn(() => "synthetic-token");
    const fetch = vi.fn(() => Promise.resolve(row()));
    const db = database({ accessToken, fetch });
    expect(isCancellableQueryExecutor(db)).toBe(true);
    const abort = new AbortController(); abort.abort(new Error(secret));
    for (const request of [
      () => db.getWithSignal(items.key("one"), abort.signal),
      () => db.getManyWithSignal([items.key("one")], abort.signal),
      () => db.queryWithSignal(items.query().limit(1).build(), abort.signal),
      () => db.appendLineProtocolWithSignal(["owned value=1"], abort.signal),
    ]) cancelled(await rejection(request()), "caller");
    expect(accessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("starts the deadline before a never-resolving credential provider", async () => {
    vi.useFakeTimers();
    try {
      const entered = deferred<void>();
      const fetch = vi.fn(() => Promise.resolve(row()));
      let received: AbortSignal | undefined;
      const db = database({ timeoutMs: 30, fetch, accessToken: (signal) => {
        received = signal; entered.resolve(undefined); return new Promise<string>(() => undefined);
      } });
      const outcome = rejection(db.get(items.key("one")));
      await entered.promise;
      await vi.advanceTimersByTimeAsync(30);
      cancelled(await outcome, "deadline");
      expect(received?.aborted).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("refuses elapsed deadlines after synchronous token or codec work before timers run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = 100;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      for (const phase of ["token", "codec"] as const) {
        now = 100;
        const fetch = vi.fn(() => Promise.resolve(row()));
        const db = database({ timeoutMs: 30, fetch, accessToken: () => {
          if (phase === "token") now = 131;
          return "synthetic-token";
        } });
        const codec: Codec<{ value: string }> = { encode: (value) => value, decode: () => { now = 131; return { value: "ok" }; } };
        cancelled(await rejection(db.get(items.key("one"), codec)), "deadline");
        expect(fetch).toHaveBeenCalledTimes(phase === "token" ? 0 : 1);
        expect(vi.getTimerCount()).toBe(0);
      }
      now = 100;
      const abort = new AbortController();
      const fetch = vi.fn(() => Promise.resolve(row()));
      const db = database({ timeoutMs: 30, fetch, accessToken: () => {
        abort.abort(new Error(secret));
        now = 131;
        return "synthetic-token";
      } });
      cancelled(await rejection(db.getWithSignal(items.key("one"), abort.signal)), "caller");
      expect(fetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { clock.mockRestore(); vi.useRealTimers(); }
  });

  it("cancels token acquisition and observes its late rejection without dispatch", async () => {
    const entered = deferred<void>(), token = deferred<string>();
    const fetch = vi.fn(() => Promise.resolve(row()));
    const db = database({ fetch, accessToken: () => { entered.resolve(undefined); return token.promise; } });
    const abort = new AbortController();
    const outcome = rejection(db.queryWithSignal(items.query().limit(1).build(), abort.signal));
    await entered.promise; abort.abort(new Error(secret));
    cancelled(await outcome, "caller");
    token.reject(new Error(secret));
    await Promise.resolve(); await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("owns a late signal-ignoring fetch response exactly once and can reopen", async () => {
    const entered = deferred<void>(), response = deferred<Response>();
    let calls = 0;
    const db = database({ fetch: () => {
      calls += 1;
      if (calls === 1) { entered.resolve(undefined); return response.promise; }
      return Promise.resolve(row());
    } });
    const abort = new AbortController();
    const outcome = rejection(db.getWithSignal(items.key("one"), abort.signal));
    await entered.promise; abort.abort(new Error(secret));
    cancelled(await outcome, "caller");
    const cancel = vi.fn(() => Promise.reject(new Error(secret)));
    const body = new ReadableStream<Uint8Array>({ cancel });
    response.resolve(new Response(body));
    await Promise.resolve(); await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    await expect(db.get(items.key("one"))).resolves.toMatchObject({ exists: true, data: { value: "ok" } });
    expect(calls).toBe(2);
  });

  it("bounds a signal-ignoring fetch by the same deadline", async () => {
    vi.useFakeTimers();
    try {
      const entered = deferred<void>();
      const db = database({ timeoutMs: 20, fetch: () => { entered.resolve(undefined); return new Promise<Response>(() => undefined); } });
      const outcome = rejection(db.query(items.query().limit(1).build()));
      await entered.promise; await vi.advanceTimersByTimeAsync(20);
      cancelled(await outcome, "deadline");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("stops a stalled body without awaiting its noncooperative cancel", async () => {
    const reading = deferred<void>();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({ pull: () => { reading.resolve(undefined); }, cancel }, { highWaterMark: 0 });
    const db = database({ fetch: () => Promise.resolve(new Response(body)) });
    const abort = new AbortController();
    const outcome = rejection(db.getWithSignal(items.key("one"), abort.signal));
    await reading.promise;
    // Zero high-water mark makes pull evidence of an actual pending read.
    abort.abort(new Error(secret));
    cancelled(await outcome, "caller");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("retains byte overflow when cancellation itself rejects", async () => {
    const cancel = vi.fn(() => Promise.reject(new Error(secret)));
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("too large")); }, cancel });
    const db = database({ maxResponseBytes: 2, fetch: () => Promise.resolve(new Response(body)) });
    const error = await rejection(db.get(items.key("one")));
    expect(String(error)).toContain("maxResponseBytes");
    expect(String(error)).not.toContain(secret);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it("cleans unused error, header-refused and append bodies without waiting", async () => {
    for (const mode of ["http", "length", "append"] as const) {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const body = new ReadableStream<Uint8Array>({ cancel });
      const response = new Response(body, { status: mode === "http" ? 403 : 200, headers: mode === "length" ? { "content-length": "100" } : {} });
      const db = database({ maxResponseBytes: 10, fetch: () => Promise.resolve(response) });
      if (mode === "append") await expect(db.appendLineProtocol(["owned value=1"])).resolves.toBeUndefined();
      else {
        const error = await rejection(db.get(items.key("one")));
        if (mode === "http") expect(error).toBeInstanceOf(InfluxDB3HttpError);
        else expect(String(error)).toContain("maxResponseBytes");
      }
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    }
  });

  it("redacts arbitrary token, fetch and reader failures", async () => {
    for (const overrides of [
      { accessToken: () => { throw new Error(secret); } },
      { fetch: () => Promise.reject(new Error(secret)) },
      { fetch: () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(secret)); } }))) },
    ]) {
      const error = await rejection(database(overrides).get(items.key("one")));
      expect(error).toBeInstanceOf(InfluxDB3TransportError);
      expect(String(error)).not.toContain(secret);
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("checks caller cancellation after codec work before returning a record or page", async () => {
    for (const query of [false, true]) {
      const abort = new AbortController();
      const codec: Codec<{ value: string }> = {
        encode: (value) => value,
        decode: () => { queueMicrotask(() => abort.abort(new Error(secret))); return { value: "ok" }; },
      };
      const db = database();
      const operation = query
        ? db.queryWithSignal(collection("items", { codec }).query().limit(1).build(), abort.signal)
        : db.getWithSignal(items.key("one"), abort.signal, codec);
      cancelled(await rejection(operation), "caller");
    }
  });

  it("checks abort triggered by append-body cleanup without retrying the write", async () => {
    const abort = new AbortController();
    const cancel = vi.fn(() => { abort.abort(new Error(secret)); });
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi.fn(() => Promise.resolve(new Response(body)));
    const db = database({ fetch });
    cancelled(await rejection(db.appendLineProtocolWithSignal(["owned value=1"], abort.signal)), "caller");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shares a deadline across sequential getMany requests and starts no later work", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<Response>(), secondEntered = deferred<void>();
      let calls = 0;
      const db = database({ timeoutMs: 30, fetch: () => {
        calls += 1;
        if (calls === 1) return first.promise;
        secondEntered.resolve(undefined);
        return new Promise<Response>(() => undefined);
      } });
      const outcome = rejection(db.getMany([items.key("one"), items.key("two"), items.key("three")]));
      await vi.advanceTimersByTimeAsync(20);
      expect(calls).toBe(1);
      first.resolve(row()); await secondEntered.promise;
      await vi.advanceTimersByTimeAsync(10);
      cancelled(await outcome, "deadline");
      expect(calls).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("enforces aggregate getMany bytes, stops later dispatch and retains order", async () => {
    const payload = JSON.stringify([{ __dalgo_key: "one", value: "ok" }]);
    let calls = 0;
    const fetch = vi.fn(() => { calls += 1; return Promise.resolve(row(calls === 1 ? "one" : "two")); });
    const db = database({ fetch, maxResponseBytes: new TextEncoder().encode(payload).byteLength + 1 });
    await expect(db.getMany([items.key("one"), items.key("two"), items.key("three")])).rejects.toThrow("maxResponseBytes");
    expect(calls).toBe(2);
    const ordered = database({ fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { params: { p0: string } };
      return body.params.p0 === "missing" ? new Response("[]") : row(body.params.p0);
    } });
    const snapshots = await ordered.getMany([items.key("two"), items.key("missing"), items.key("one")]);
    expect(snapshots.map((snapshot) => [snapshot.key.id, snapshot.exists])).toEqual([["two", true], ["missing", false], ["one", true]]);
  });

  it("getMany caller abort stops later keys, including an empty pre-aborted operation", async () => {
    const abort = new AbortController();
    const fetch = vi.fn(() => Promise.resolve(row()));
    const codec: Codec<{ value: string }> = { encode: (value) => value, decode: () => { abort.abort(new Error(secret)); return { value: "ok" }; } };
    const db = database({ fetch });
    cancelled(await rejection(db.getManyWithSignal([items.key("one"), items.key("two")], abort.signal, codec)), "caller");
    expect(fetch).toHaveBeenCalledTimes(1);
    cancelled(await rejection(db.getManyWithSignal([], abort.signal)), "caller");
  });

  it("does not admit keys added while an earlier getMany read is pending", async () => {
    const entered = deferred<void>(), first = deferred<Response>();
    const fetch = vi.fn(() => { entered.resolve(undefined); return first.promise; });
    const keys = [items.key("one")];
    const db = database({ fetch, maxRows: 1 });
    const pending = db.getMany(keys);
    await entered.promise;
    keys.push(items.key("not-admitted"));
    first.resolve(row());
    await expect(pending).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses server rows beyond the generated lookahead instead of silently truncating", async () => {
    const db = database({ fetch: () => Promise.resolve(new Response(JSON.stringify(["one", "two", "three"].map((id) => ({ __dalgo_key: id, value: "ok" }))))) });
    await expect(db.query(items.query().limit(1).build())).rejects.toThrow("requested row bound");
  });
});
