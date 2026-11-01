import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, NumberValue, type BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { Buffer } from "node:buffer";
import { collection, type Codec } from "@dalgo/core";
import { isCancellableQueryExecutor, QueryCancelledError } from "@dalgo/adapter-runtime";
import { describe, expect, it, vi } from "vitest";
import { DynamoDbDatabase, DynamoDbReadError, type DynamoDbTableOptions, type DynamoDbDocumentClientLike } from "../src/index.js";

const items = collection<{ value: string }>("items");
const secret = "synthetic-private-sdk-detail";
const item = (id = "one", data: unknown = { value: "ok" }) => ({ pk: "items", sk: "items/" + id, __dalgo_id: id, data });

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve: (value: T) => void = () => { throw new Error("uninitialized deferred"); };
  let reject: (error: unknown) => void = () => { throw new Error("uninitialized deferred"); };
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(options: Partial<DynamoDbTableOptions> = {}) {
  const send = vi.fn(), destroy = vi.fn();
  const client = { send, destroy } as unknown as DynamoDBDocumentClient;
  const db = new DynamoDbDatabase(client, { tableName: "owned", ...options });
  return { db, send, destroy, client };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try { await promise; } catch (error: unknown) { return error; }
  throw new Error("expected read refusal");
}

function cancelled(error: unknown, reason: "caller" | "deadline"): void {
  expect(error).toBeInstanceOf(QueryCancelledError);
  expect(error).toMatchObject({ reason });
  expect(String(error)).not.toContain(secret);
  expect(error).not.toHaveProperty("cause");
}

describe("DynamoDB bounded read lifecycle", () => {
  it("pre-aborts all additive read APIs without invoking or destroying the borrowed client", async () => {
    const { db, send, destroy } = fixture();
    const abort = new AbortController(); abort.abort(new Error(secret));
    expect(isCancellableQueryExecutor(db)).toBe(true);
    for (const request of [
      () => db.getWithSignal(items.key("one"), abort.signal),
      () => db.getManyWithSignal([items.key("one")], abort.signal),
      () => db.getManyWithSignal([], abort.signal),
      () => db.queryWithSignal(items.query().limit(1).build(), abort.signal),
    ]) cancelled(await rejection(request()), "caller");
    expect(send).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled();
  });

  it("passes one owned signal to SDK.send, rejects after dispatch, handles late errors and reopens", async () => {
    const { db, send, destroy, client } = fixture();
    const entered = deferred<undefined>(), pending = deferred<unknown>();
    let received: AbortSignal | undefined;
    send.mockImplementationOnce((_command: unknown, options: { abortSignal: AbortSignal }) => {
      received = options.abortSignal; entered.resolve(undefined); return pending.promise;
    });
    const abort = new AbortController();
    const outcome = rejection(db.getWithSignal(items.key("one"), abort.signal));
    await entered.promise;
    expect(received).not.toBe(abort.signal);
    abort.abort(new Error(secret));
    cancelled(await outcome, "caller");
    expect(received?.aborted).toBe(true);
    expect(send.mock.contexts[0]).toBe(client);
    pending.reject(new Error(secret));
    await Promise.resolve(); await Promise.resolve();
    send.mockResolvedValueOnce({ Item: item() });
    await expect(db.get(items.key("one"))).resolves.toMatchObject({ exists: true, data: { value: "ok" } });
    expect(send).toHaveBeenCalledTimes(2); expect(destroy).not.toHaveBeenCalled();
  });

  it("does not return an SDK result that arrives after cancellation", async () => {
    const { db, send, destroy } = fixture();
    const entered = deferred<undefined>(), pending = deferred<unknown>();
    send.mockImplementation(() => { entered.resolve(undefined); return pending.promise; });
    const abort = new AbortController();
    const decode = vi.fn(() => ({ value: "private-late" }));
    const codec: Codec<{ value: string }> = { encode: (value) => value, decode };
    const outcome = rejection(db.getManyWithSignal([items.key("one")], abort.signal, codec));
    await entered.promise; abort.abort(); cancelled(await outcome, "caller");
    pending.resolve({ Responses: { owned: [item()] } });
    await Promise.resolve(); await Promise.resolve();
    expect(decode).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled();
  });

  it("bounds credential waiting inside the actual SDK without destroying its client", async () => {
    const entered = deferred<undefined>(), credentials = deferred<{ accessKeyId: string; secretAccessKey: string }>();
    const native = new DynamoDBClient({ region: "us-east-1", maxAttempts: 1, credentials: () => { entered.resolve(undefined); return credentials.promise; } });
    const client = DynamoDBDocumentClient.from(native);
    const publicClient: DynamoDbDocumentClientLike = client;
    const destroy = vi.spyOn(client, "destroy");
    const db = new DynamoDbDatabase(publicClient, { tableName: "owned", timeoutMs: 10000 });
    const abort = new AbortController();
    try {
      const outcome = rejection(db.getWithSignal(items.key("one"), abort.signal));
      await entered.promise; abort.abort(new Error(secret));
      cancelled(await outcome, "caller");
      expect(destroy).not.toHaveBeenCalled();
      credentials.reject(new Error(secret));
      await Promise.resolve(); await Promise.resolve();
    } finally {
      // The test owns this client. Product reads borrow it and never destroy it.
      destroy.mockRestore(); client.destroy();
    }
  });

  it("uses the same deadline through empty query pages and noncooperative send", async () => {
    vi.useFakeTimers();
    try {
      const { db, send, destroy } = fixture({ timeoutMs: 30 });
      const first = deferred<unknown>(), secondEntered = deferred<undefined>();
      send.mockReturnValueOnce(first.promise).mockImplementationOnce(() => { secondEntered.resolve(undefined); return new Promise<unknown>(() => undefined); });
      const outcome = rejection(db.query(items.query().limit(1).build()));
      await vi.advanceTimersByTimeAsync(20);
      first.resolve({ Items: [], LastEvaluatedKey: { pk: "items", sk: "items/a" } });
      await secondEntered.promise;
      await vi.advanceTimersByTimeAsync(10);
      cancelled(await outcome, "deadline");
      expect(send).toHaveBeenCalledTimes(2);
      const firstOptions = send.mock.calls[0]?.[1] as { abortSignal: AbortSignal } | undefined;
      const secondOptions = send.mock.calls[1]?.[1] as { abortSignal: AbortSignal } | undefined;
      expect(firstOptions?.abortSignal).toBe(secondOptions?.abortSignal);
      expect(secondOptions?.abortSignal.aborted).toBe(true);
      expect(destroy).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("prevents later pages and late success when a codec aborts after SDK completion", async () => {
    for (const limit of [1, 2]) {
      const { db, send, destroy } = fixture();
      const abort = new AbortController();
      const codec: Codec<{ value: string }> = { encode: (value) => value, decode: () => {
        if (limit === 1) queueMicrotask(() => { abort.abort(new Error(secret)); });
        else abort.abort(new Error(secret));
        return { value: "ok" };
      } };
      send.mockResolvedValue({ Items: [item()], LastEvaluatedKey: { pk: "items", sk: "items/one" } });
      const query = collection("items", { codec }).query().limit(limit).build();
      cancelled(await rejection(db.queryWithSignal(query, abort.signal)), "caller");
      expect(send).toHaveBeenCalledTimes(1); expect(destroy).not.toHaveBeenCalled();
    }
  });

  it("observes elapsed time after synchronous send/codec work before timers run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = 100;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      for (const phase of ["send", "codec"] as const) {
        now = 100;
        const { db, send, destroy } = fixture({ timeoutMs: 30 });
        const decode = vi.fn(() => { now = 131; return { value: "ok" }; });
        send.mockImplementation(() => { if (phase === "send") now = 131; return Promise.resolve({ Item: item() }); });
        const codec: Codec<{ value: string }> = { encode: (value) => value, decode };
        cancelled(await rejection(db.get(items.key("one"), codec)), "deadline");
        expect(decode).toHaveBeenCalledTimes(phase === "send" ? 0 : 1);
        expect(destroy).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
      }
      now = 100;
      const { db, send } = fixture({ timeoutMs: 30 });
      const abort = new AbortController();
      send.mockImplementation(() => { abort.abort(new Error(secret)); now = 131; return Promise.resolve({}); });
      cancelled(await rejection(db.getWithSignal(items.key("one"), abort.signal)), "caller");
      expect(vi.getTimerCount()).toBe(0);
    } finally { clock.mockRestore(); vi.useRealTimers(); }
  });

  it("redacts SDK failures and does not destroy or poison the shared client", async () => {
    const { db, send, destroy } = fixture();
    send.mockRejectedValueOnce(Object.assign(new Error(secret), { $metadata: { requestId: secret }, cause: new Error(secret) }));
    const error = await rejection(db.get(items.key("one")));
    expect(error).toBeInstanceOf(DynamoDbReadError);
    expect(error).toMatchObject({ code: "transport" });
    expect(String(error)).not.toContain(secret); expect(error).not.toHaveProperty("cause");
    send.mockResolvedValueOnce({});
    await expect(db.get(items.key("missing"))).resolves.toMatchObject({ exists: false });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("distinguishes native batch100 admission from logical duplicate expansion", async () => {
    const { db, send } = fixture({ maxReadRecords: 2 });
    await expect(db.getMany([items.key("one"), items.key("one"), items.key("one")])).rejects.toMatchObject({ code: "limit" });
    expect(send).not.toHaveBeenCalled();
    const ordinary = fixture();
    ordinary.send.mockResolvedValue({ Responses: { owned: [item()] } });
    await expect(ordinary.db.getMany(Array.from({ length: 101 }, () => items.key("one")))).resolves.toHaveLength(101);
    const batchCommand = ordinary.send.mock.calls[0]?.[0] as BatchGetCommand | undefined;
    expect(batchCommand?.input.RequestItems?.owned?.Keys).toHaveLength(1);
    await expect(ordinary.db.getMany(Array.from({ length: 101 }, (_, index) => items.key(String(index))))).rejects.toThrow("100 distinct keys");
    expect(ordinary.send).toHaveBeenCalledTimes(1);
  });

  it("accounts batch duplicate bytes before codecs and returns no partial snapshots", async () => {
    const { db, send } = fixture({ maxReadBytes: 400 });
    send.mockResolvedValue({ Responses: { owned: [item("one", { value: "x".repeat(80) })] } });
    await expect(db.getMany([items.key("one")])).resolves.toHaveLength(1);
    await expect(db.getMany([items.key("one"), items.key("one"), items.key("one")])).rejects.toMatchObject({ code: "limit" });
  });

  it("retains exact SDK binary, bigint, sets and NumberValue objects without JSON coercion", async () => {
    const { db, send } = fixture();
    const exact = NumberValue.from("9007199254740993.0001");
    const bytes = new Uint8Array([0, 255, 128]);
    const buffer = new Uint8Array([3, 4]).buffer;
    const nativeBuffer = Buffer.from([7, 255]);
    const dataView = new DataView(new Uint8Array([1, 2]).buffer);
    const floats = new Float64Array([1.5]);
    const data = { exact, big: 9007199254740993n, bytes, buffer, nativeBuffer, dataView, floats, binarySet: new Set([bytes]), numericSet: new Set([1, 2n, exact]), strings: new Set(["x", "y"]) };
    send.mockResolvedValueOnce({ Item: item("one", data) });
    const result = await db.get<typeof data>(items.key("one"));
    expect(result.exists).toBe(true);
    if (!result.exists) throw new Error("fixture record missing");
    expect(result.data.exact).toBe(exact); expect(result.data.exact.toString()).toBe("9007199254740993.0001");
    expect(result.data.big).toBe(9007199254740993n);
    expect(result.data.bytes).toBe(bytes); expect(result.data.buffer).toBe(buffer);
    expect(result.data.nativeBuffer).toBe(nativeBuffer); expect(result.data.dataView).toBe(dataView); expect(result.data.floats).toBe(floats);
    expect(result.data.binarySet).toBe(data.binarySet); expect(result.data.numericSet).toBe(data.numericSet);
  });

  it("rejects cyclic/accessor/unsupported parsed payloads without executing getters", async () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let getters = 0;
    const accessor = Object.defineProperty({}, "private", { enumerable: true, get() { getters += 1; throw new Error(secret); } });
    for (const value of [cycle, accessor, new Date(0)]) {
      const { db, send } = fixture(); send.mockResolvedValueOnce({ Item: item("one", value) });
      await expect(db.get(items.key("one"))).rejects.toMatchObject({ code: "invalid-response" });
    }
    expect(getters).toBe(0);
  });

  it("refuses native iterator/accessor/extra-field disguises without executing them", async () => {
    let callbacks = 0;
    const hiddenSet = new Set(["x".repeat(4096)]);
    Object.defineProperty(hiddenSet, Symbol.iterator, { get() { callbacks += 1; return () => new Set<string>().values(); } });
    const hiddenBytes = new Uint8Array([1]);
    Object.defineProperty(hiddenBytes, "byteLength", { get() { callbacks += 1; return 0; } });
    const hiddenBacking = new ArrayBuffer(1);
    Object.defineProperty(hiddenBacking, "private", { get() { callbacks += 1; return secret; } });
    const hiddenNumber = NumberValue.from("123");
    Object.defineProperty(hiddenNumber, "value", { get() { callbacks += 1; return "0"; } });
    const extraNumber = NumberValue.from("123");
    Object.defineProperty(extraNumber, "extra", { value: "x".repeat(4096) });
    class CustomSet extends Set<string> {}
    class CustomBytes extends Uint8Array {}
    class CustomArray extends Array<string> {}
    for (const data of [hiddenSet, hiddenBytes, new Uint8Array(hiddenBacking), hiddenNumber, extraNumber, new CustomSet(["x"]), new CustomBytes([1]), new CustomArray("x")]) {
      const { db, send } = fixture({ maxReadBytes: 512 });
      send.mockResolvedValueOnce({ Item: item("one", data) });
      await expect(db.get(items.key("one"))).rejects.toMatchObject({ code: "invalid-response" });
    }
    expect(callbacks).toBe(0);
    const { db, send } = fixture({ maxReadBytes: 512 });
    send.mockResolvedValueOnce({ Item: item("one", new Set(["x".repeat(4096)])) });
    await expect(db.get(items.key("one"))).rejects.toMatchObject({ code: "limit" });
  });

  it("bounds parsed structure depth and binary bytes", async () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < 70; i += 1) nested = { next: nested };
    for (const { data, maxReadBytes } of [{ data: nested, maxReadBytes: 10000 }, { data: { bytes: new Uint8Array(1024) }, maxReadBytes: 512 }]) {
      const { db, send } = fixture({ maxReadBytes }); send.mockResolvedValueOnce({ Item: item("one", data) });
      await expect(db.get(items.key("one"))).rejects.toMatchObject({ code: "limit" });
    }
  });

  it("does not expand a batch key list mutated after admission", async () => {
    const { db, send } = fixture({ maxReadRecords: 1 });
    const entered = deferred<undefined>(), response = deferred<unknown>();
    send.mockImplementation(() => { entered.resolve(undefined); return response.promise; });
    const keys = [items.key("one")];
    const pending = db.getMany(keys);
    await entered.promise; keys.push(items.key("not-admitted"));
    response.resolve({ Responses: { owned: [item()] } });
    await expect(pending).resolves.toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects query over-return before a negative remaining count or another page", async () => {
    const { db, send } = fixture();
    send.mockResolvedValue({ Items: [item("one"), item("two")], LastEvaluatedKey: { pk: "items", sk: "items/two" } });
    await expect(db.query(items.query().limit(1).build())).rejects.toMatchObject({ code: "limit" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("accumulates parsed-byte and row budgets across native pages", async () => {
    for (const options of [{ maxReadBytes: 250 }, { maxReadRecords: 1 }]) {
      const { db, send } = fixture(options);
      send.mockResolvedValueOnce({ Items: [item("one", { value: "x".repeat(80) })], LastEvaluatedKey: { pk: "items", sk: "items/one" } });
      send.mockResolvedValueOnce({ Items: [item("two", { value: "x".repeat(80) })] });
      await expect(db.query(items.query().build())).rejects.toMatchObject({ code: "limit" });
      expect(send).toHaveBeenCalledTimes(2);
    }
  });

  it("charges empty pages to the existing request limit and preserves UnprocessedKeys refusal", async () => {
    const { db, send } = fixture({ maxQueryPages: 2 });
    let page = 0;
    send.mockImplementation(() => Promise.resolve({ Items: [], LastEvaluatedKey: { pk: "items", sk: "items/" + String(page++) } }));
    await expect(db.query(items.query().limit(1).build())).rejects.toThrow("2-page safety limit");
    expect(send).toHaveBeenCalledTimes(2);
    send.mockResolvedValueOnce({ Responses: { owned: [item()] }, UnprocessedKeys: { owned: { Keys: [{ pk: "items", sk: "items/two" }] } } });
    await expect(db.getMany([items.key("one"), items.key("two")])).rejects.toThrow("unprocessed keys");
  });
});
