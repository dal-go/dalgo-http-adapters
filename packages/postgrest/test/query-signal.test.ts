import { QueryCancelledError } from "@dalgo/adapter-runtime";
import {
  DOCUMENT_ID,
  UnsupportedError,
  collection,
  key,
  type Codec,
  type Key,
  type RecordSnapshot,
} from "@dalgo/core";
import { describe, expect, it, vi } from "vitest";

import {
  POSTGREST_READ_CAPABILITIES,
  PostgrestDatabase,
  PostgrestHttpError,
  PostgrestRequestError,
} from "../src/index.js";

function response(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers });
}

function database(options: Partial<ConstructorParameters<typeof PostgrestDatabase>[0]> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const headers = vi.fn(() => ({ authorization: "Bearer opaque" }));
  return {
    fetch,
    headers,
    database: new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      fetch,
      headers,
      ...options,
    }),
  };
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve(value: T): void {
      resolve?.(value);
    },
    reject(error: unknown): void {
      reject?.(error);
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function request(fetch: ReturnType<typeof vi.fn>, call = 0): RequestInit {
  return fetch.mock.calls[call]?.[1] as RequestInit;
}

const items = collection<{ done: boolean; priority: number }>("items");

describe("PostgrestDatabase.queryWithSignal", () => {
  it("performs no header or HTTP work for an already-aborted caller", async () => {
    const { database: db, fetch, headers } = database();
    const controller = new AbortController();
    controller.abort(new Error("Bearer secret must not escape"));

    const error = await db.queryWithSignal(items.query().build(), controller.signal).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(error).toMatchObject({ reason: "caller", message: "query cancelled by caller" });
    expect(String(error)).not.toContain("secret");
    expect(headers).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a caller abort while headers are pending and never starts the request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const pending = deferred<Readonly<Record<string, string>>>();
    const db = new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      fetch,
      headers: () => pending.promise,
    });
    const controller = new AbortController();
    const query = db.queryWithSignal(items.query().build(), controller.signal);
    controller.abort();

    await expect(query).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    pending.resolve({ authorization: "Bearer secret" });
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not start fetch when a header provider aborts the caller synchronously", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const controller = new AbortController();
    const db = new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      fetch,
      headers: () => {
        controller.abort();
        return { authorization: "Bearer opaque" };
      },
    });

    await expect(db.queryWithSignal(items.query().build(), controller.signal))
      .rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("applies one deadline while headers are pending", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const db = new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      fetch,
      headers: () => new Promise<Readonly<Record<string, string>>>(() => undefined),
      timeoutMs: 1,
    });

    await expect(db.queryWithSignal(items.query().build(), new AbortController().signal))
      .rejects.toMatchObject({ name: "QueryCancelledError", reason: "deadline" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops an in-flight request, discards a late response and cleans its body", async () => {
    const { database: db, fetch } = database();
    const pending = deferred<Response>();
    fetch.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const query = db.queryWithSignal(items.query().build(), controller.signal);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    const late = response(200, [{ id: "milk", done: false, priority: 1 }]);
    const cancel = vi.spyOn(late.body as ReadableStream<Uint8Array>, "cancel");
    controller.abort(new Error("Bearer secret"));
    await expect(query).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    pending.resolve(late);
    await flush();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(request(fetch).signal).toBeInstanceOf(AbortSignal);
  });

  it("cancels a hanging body without awaiting a hostile cancel", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel,
    });
    const db = new PostgrestDatabase({ baseUrl: "https://api.example.com/rest/v1", fetch });
    fetch.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    const controller = new AbortController();
    const query = db.queryWithSignal(items.query().build(), controller.signal);
    const settled = query.catch((reason: unknown) => reason);
    await vi.waitFor(() => {
      expect(stream.locked).toBe(true);
    }, { interval: 1 });

    controller.abort();
    expect(await settled).toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("stops a hanging body at the deadline", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel,
    });
    fetch.mockResolvedValueOnce(new Response(stream, { status: 200 }));
    const db = new PostgrestDatabase({ baseUrl: "https://api.example.com/rest/v1", fetch, timeoutMs: 50 });
    const query = db.queryWithSignal(items.query().build(), new AbortController().signal);
    const settled = query.catch((reason: unknown) => reason);
    await vi.waitFor(() => {
      expect(stream.locked).toBe(true);
    }, { interval: 1 });

    expect(await settled).toMatchObject({ name: "QueryCancelledError", reason: "deadline" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns a page and issues no later offset request after abort", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [{ id: "milk", done: false, priority: 1 }]));
    const controller = new AbortController();
    const page = await db.queryWithSignal(items.query().orderBy("priority").limit(1).build(), controller.signal);
    expect(page.records).toHaveLength(1);

    controller.abort();
    await expect(
      db.queryWithSignal(items.query().orderBy("priority").limit(1).offset(1).build(), controller.signal),
    ).rejects.toMatchObject({ reason: "caller" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("redacts header-provider and fetch failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const headerFailure = new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      fetch,
      headers: () => {
        throw new Error("Bearer secret header token");
      },
    });
    const headerError = await headerFailure
      .queryWithSignal(items.query().build(), new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(headerError).toBeInstanceOf(PostgrestRequestError);
    expect(String(headerError)).not.toContain("secret");
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockRejectedValueOnce(new Error("fetch failed with Bearer secret token"));
    const { database: db } = database({ fetch });
    const fetchError = await db
      .queryWithSignal(items.query().build(), new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(fetchError).toBeInstanceOf(PostgrestRequestError);
    expect(String(fetchError)).not.toContain("secret");
  });

  it("keeps deliberate unsupported and configuration errors precise", async () => {
    const { database: db, fetch } = database();
    await expect(
      db.queryWithSignal(items.in(key("parents", "one")).query().build(), new AbortController().signal),
    ).rejects.toBeInstanceOf(UnsupportedError);
    await expect(
      db.queryWithSignal(items.query().startAfter("opaque").build(), new AbortController().signal),
    ).rejects.toBeInstanceOf(UnsupportedError);
    await expect(
      db.queryWithSignal(items.query().where(DOCUMENT_ID, "in", []).build(), new AbortController().signal),
    ).rejects.toThrow("non-empty array");
    await expect(
      db.queryWithSignal(items.query().limit(101).build(), new AbortController().signal),
    ).rejects.toBeInstanceOf(UnsupportedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enforces request, response and HTTP-status bounds", async () => {
    const { database: db, fetch } = database({ maxResponseBytes: 20 });
    fetch.mockResolvedValueOnce(response(200, [], { "content-length": "99" }));
    await expect(db.queryWithSignal(items.query().build(), new AbortController().signal))
      .rejects.toEqual(new PostgrestRequestError());

    const cancel = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(21));
      },
      cancel,
    });
    fetch.mockResolvedValueOnce(new Response(oversized, { status: 200 }));
    await expect(db.queryWithSignal(items.query().build(), new AbortController().signal))
      .rejects.toEqual(new PostgrestRequestError());
    expect(cancel).toHaveBeenCalled();

    fetch.mockResolvedValueOnce(response(503, { detail: "secret internals" }));
    const httpError = await db
      .queryWithSignal(items.query().build(), new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(httpError).toEqual(new PostgrestHttpError(503));
    expect(String(httpError)).not.toContain("secret");
  });

  it("publishes capability bounds that match enforced code", () => {
    expect(POSTGREST_READ_CAPABILITIES).toMatchObject({
      storage: "native-rows",
      read: { get: true, getMany: true },
      bounds: {
        maxQueryLimit: { default: 100, maximum: 1_000 },
        maxRequestBytes: { default: 1_048_576, maximum: 16_777_216 },
        maxResponseBytes: { default: 1_048_576, maximum: 16_777_216 },
      },
    });
    expect(POSTGREST_READ_CAPABILITIES.query.sort.status).toBe("native");
    expect(POSTGREST_READ_CAPABILITIES.query.filter.status).toBe("native");
    expect(POSTGREST_READ_CAPABILITIES.query.projection.status).toBe("unsupported");
    expect(POSTGREST_READ_CAPABILITIES.query.native.status).toBe("unsupported");
    expect(POSTGREST_READ_CAPABILITIES.query.discovery.status).toBe("native");
    expect(POSTGREST_READ_CAPABILITIES.query.pagination.detail).toContain("opaque keyset cursor");
    expect(POSTGREST_READ_CAPABILITIES.bounds.maxQueryOffset.default).toBe(100_000);
    expect(POSTGREST_READ_CAPABILITIES.bounds.filterOperators).toContain("array-contains-any");
  });
});

type Item = { done: boolean; priority: number };

function isItem(data: unknown): data is Item {
  if (typeof data !== "object" || data === null) return false;
  const row = data as Record<string, unknown>;
  return typeof row.done === "boolean" && typeof row.priority === "number";
}

function decodeItem(data: unknown): Item {
  if (!isItem(data)) throw new TypeError("unexpected item response");
  return data;
}

function readCodec(
  decode: (data: unknown, entered: number) => Item,
): { readonly codec: Codec<Item>; readonly entered: () => number } {
  let entries = 0;
  return {
    codec: {
      encode: (value) => value,
      decode: (data) => {
        entries += 1;
        return decode(data, entries);
      },
    },
    entered: () => entries,
  };
}

function expectCallerCancellation(error: unknown, privateMessage: string): void {
  expect(error).toBeInstanceOf(QueryCancelledError);
  expect(error).toMatchObject({
    name: "QueryCancelledError",
    reason: "caller",
    message: "query cancelled by caller",
  });
  expect(String(error)).not.toContain(privateMessage);
  expect((error as { cause?: unknown }).cause).toBeUndefined();
}

describe("PostgrestDatabase read codec cancellation", () => {
  it("stops after the first synchronous caller-aborting query codec", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [
      { id: "milk", done: false, priority: 1 },
      { id: "eggs", done: true, priority: 2 },
    ]));
    const controller = new AbortController();
    const privateReason = new Error("private synchronous codec reason");
    const { codec, entered } = readCodec((data, count) => {
      if (count === 1) controller.abort(privateReason);
      return decodeItem(data);
    });
    const items = collection<Item>("items", { codec });

    const error = await db
      .queryWithSignal(items.query().build(), controller.signal)
      .catch((reason: unknown) => reason);

    expect(entered()).toBe(1);
    expectCallerCancellation(error, privateReason.message);
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch.mockResolvedValueOnce(response(200, [{ id: "bread", done: true, priority: 3 }]));
    const page = await db.queryWithSignal(items.query().build(), new AbortController().signal);
    expect(page.records).toEqual([
      { key: key("items", "bread"), exists: true, data: { done: true, priority: 3 } },
    ]);
    expect(entered()).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a codec-queued caller abort after the final inner check", async () => {
    const point = database();
    const pointController = new AbortController();
    const pointReason = new Error("private point reason");
    const pointCodec = readCodec((data, count) => {
      if (count === 1) queueMicrotask(() => { pointController.abort(pointReason); });
      return decodeItem(data);
    });
    point.fetch.mockResolvedValueOnce(response(200, [{ id: "milk", done: false, priority: 1 }]));

    const pointError = await point.database
      .getWithSignal(key("items", "milk"), pointController.signal, pointCodec.codec)
      .catch((reason: unknown) => reason);

    expect(pointCodec.entered()).toBe(1);
    expectCallerCancellation(pointError, pointReason.message);
    expect(point.fetch).toHaveBeenCalledTimes(1);

    const query = database();
    const queryController = new AbortController();
    const queryReason = new Error("private query reason");
    const queryCodec = readCodec((data, count) => {
      if (count === 1) queueMicrotask(() => { queryController.abort(queryReason); });
      return decodeItem(data);
    });
    const items = collection<Item>("items", { codec: queryCodec.codec });
    query.fetch.mockResolvedValueOnce(response(200, [{ id: "milk", done: false, priority: 1 }]));

    const queryError = await query.database
      .queryWithSignal(items.query().build(), queryController.signal)
      .catch((reason: unknown) => reason);

    expect(queryCodec.entered()).toBe(1);
    expectCallerCancellation(queryError, queryReason.message);
    expect(query.fetch).toHaveBeenCalledTimes(1);
  });

  it("lets caller cancellation win over a codec callback throw", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, [
      { id: "milk", done: false, priority: 1 },
      { id: "eggs", done: true, priority: 2 },
    ]));
    const controller = new AbortController();
    const privateReason = new Error("private callback abort reason");
    const callbackError = new Error("private callback error marker");
    const { codec, entered } = readCodec((data, count) => {
      if (count === 1) {
        controller.abort(privateReason);
        throw callbackError;
      }
      return decodeItem(data);
    });
    const items = collection<Item>("items", { codec });

    const error = await db
      .queryWithSignal(items.query().build(), controller.signal)
      .catch((reason: unknown) => reason);

    expect(entered()).toBe(1);
    expectCallerCancellation(error, callbackError.message);
    expect(String(error)).not.toContain(privateReason.message);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("lets caller cancellation win when a relation callback aborts and throws before fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const headers = vi.fn(() => ({ authorization: "Bearer opaque" }));
    const controller = new AbortController();
    const privateReason = new Error("private relation abort reason");
    const callbackError = new Error("private relation error marker");
    const db = new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      fetch,
      headers,
      relationName: () => {
        controller.abort(privateReason);
        throw callbackError;
      },
    });
    const items = collection<Item>("items");

    const error = await db
      .queryWithSignal(items.query().build(), controller.signal)
      .catch((reason: unknown) => reason);

    expectCallerCancellation(error, callbackError.message);
    expect(String(error)).not.toContain(privateReason.message);
    expect(headers).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enforces the original deadline across a synchronous codec even when its timer cannot run", async () => {
    const timeoutMs = 100;
    const { database: db, fetch } = database({ timeoutMs });
    fetch.mockResolvedValueOnce(response(200, [
      { id: "milk", done: false, priority: 1 },
      { id: "eggs", done: true, priority: 2 },
    ]));
    const { codec, entered } = readCodec((data) => {
      const until = performance.now() + timeoutMs + 1;
      while (performance.now() < until) { /* spin on the real monotonic clock */ }
      return decodeItem(data);
    });
    const items = collection<Item>("items", { codec });

    const error = await db
      .queryWithSignal(items.query().build(), new AbortController().signal)
      .catch((reason: unknown) => reason);

    expect(entered()).toBe(1);
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(error).toMatchObject({ name: "QueryCancelledError", reason: "deadline" });
    expect(fetch).toHaveBeenCalledTimes(1);
  }, 2_000);

  it("keeps the unsignalled deadline error redacted across a synchronous codec", async () => {
    const timeoutMs = 100;
    const { database: db, fetch } = database({ timeoutMs });
    fetch.mockResolvedValueOnce(response(200, [{ id: "milk", done: false, priority: 1 }]));
    const { codec, entered } = readCodec((data) => {
      const until = performance.now() + timeoutMs + 1;
      while (performance.now() < until) { /* spin on the real monotonic clock */ }
      return decodeItem(data);
    });
    const items = collection<Item>("items", { codec });

    const error = await db.query(items.query().build()).catch((reason: unknown) => reason);

    expect(entered()).toBe(1);
    expect(error).toEqual(new PostgrestRequestError());
    expect(fetch).toHaveBeenCalledTimes(1);
  }, 2_000);

  it("public point promise commits before a two-hop post-commit abort", async () => {
    const point = database();
    const controller = new AbortController();
    const privateReason = new Error("private post-commit point reason");
    const events: string[] = [];
    const markerGate = deferred<boolean>();
    let firstHopEntered = false;
    let secondHopEntered = false;
    let abortedAtProbe = false;
    const publicPending: { value: Promise<unknown> | undefined } = { value: undefined };
    const pointCodec = readCodec((data, count) => {
      if (count === 1) {
        queueMicrotask(() => {
          firstHopEntered = true;
          queueMicrotask(() => {
            secondHopEntered = true;
            controller.abort(privateReason);
            abortedAtProbe = controller.signal.aborted;
            const pending = publicPending.value;
            if (pending === undefined) throw new Error("public point promise was not captured before the codec ran");
            void pending.then(
              () => { events.push("public-reaction"); },
              () => { events.push("public-rejected"); },
            );
            queueMicrotask(() => {
              events.push("marker");
              markerGate.resolve(true);
            });
          });
        });
      }
      return decodeItem(data);
    });
    point.fetch.mockResolvedValueOnce(response(200, [{ id: "milk", done: false, priority: 1 }]));

    const pending = point.database.getWithSignal(key("items", "milk"), controller.signal, pointCodec.codec);
    publicPending.value = pending;

    await markerGate.promise;
    const publicResult = await pending;
    await flush();

    expect(pointCodec.entered()).toBe(1);
    expect(firstHopEntered).toBe(true);
    expect(secondHopEntered).toBe(true);
    expect(abortedAtProbe).toBe(true);
    expect(events).toEqual(["public-reaction", "marker"]);
    expect(decodeItem(publicResult.data)).toEqual({ done: false, priority: 1 });
    expect(publicResult.key).toEqual(key("items", "milk"));
    expect(point.fetch).toHaveBeenCalledTimes(1);
  }, 2_000);
});

type PointSnapshot = RecordSnapshot<Item>;
type PointEntry = "get" | "getWithSignal";

const pointEntries = ["get", "getWithSignal"] as const;

async function readPoint(
  entry: PointEntry,
  db: PostgrestDatabase,
  target: Key,
  codec: Codec<Item>,
  controller: AbortController,
): Promise<PointSnapshot> {
  if (entry === "get") return db.get(target, codec);
  return db.getWithSignal(target, controller.signal, codec);
}

async function withinBound<T>(promise: Promise<T>, timeoutMs = 1_500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("bounded wait exceeded"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const POINT_TIMEOUT_MS = 1_000;
const POINT_OUTER_BOUND_MS = 1_500;

type PointSettlement =
  | { readonly ok: true; readonly value: PointSnapshot }
  | { readonly ok: false; readonly error: unknown };

function settle(promise: Promise<PointSnapshot>): Promise<PointSettlement> {
  return promise.then(
    (value): PointSettlement => ({ ok: true, value }),
    (error: unknown): PointSettlement => ({ ok: false, error }),
  );
}

function expectFulfilled(
  settlement: PointSettlement,
): asserts settlement is { readonly ok: true; readonly value: PointSnapshot } {
  expect(settlement.ok).toBe(true);
}

type EntryOutcome =
  | { readonly kind: "entered" }
  | { readonly kind: "terminal"; readonly outcome: PointSettlement };

function expectEnteredBeforeTerminal(outcome: EntryOutcome): asserts outcome is { readonly kind: "entered" } {
  expect(outcome.kind).toBe("entered");
}

describe("PostgrestDatabase point key ownership", () => {
  for (const entry of pointEntries) {
    for (const present of [true, false]) {
      it(`keeps the original key when relation, header and codec callbacks mutate the caller in ${entry} ${present ? "present" : "missing"}`, async () => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        const expectedId = present ? "milk" : "missing";
        const callerKey = key("items", expectedId);
        const controller = new AbortController();
        let relationEntries = 0;
        let headerEntries = 0;
        const headers = vi.fn(() => {
          headerEntries += 1;
          Reflect.set(callerKey, "collection", "header-mutated");
          Reflect.set(callerKey, "id", "header-spoof");
          Reflect.set(callerKey, "parent", key("parents", "header"));
          return { authorization: "Bearer opaque" };
        });
        const { codec, entered } = readCodec((data) => {
          Reflect.set(callerKey, "collection", "codec-mutated");
          Reflect.set(callerKey, "id", "codec-spoof");
          Reflect.set(callerKey, "parent", key("parents", "codec"));
          return decodeItem(data);
        });
        const db = new PostgrestDatabase({
          baseUrl: "https://api.example.com/rest/v1",
          fetch,
          headers,
          timeoutMs: POINT_TIMEOUT_MS,
          relationName: (name) => {
            relationEntries += 1;
            if (relationEntries === 1) {
              Reflect.set(callerKey, "collection", "relation-mutated");
              Reflect.set(callerKey, "id", "relation-spoof");
              Reflect.set(callerKey, "parent", key("parents", "relation"));
            }
            return name;
          },
        });
        fetch.mockResolvedValueOnce(present
          ? response(200, [{ id: "milk", done: false, priority: 1 }])
          : response(200, []));

        const publicSettlement = settle(readPoint(entry, db, callerKey, codec, controller));
        let cleanupFailure: unknown;
        try {
          const settled = await withinBound(publicSettlement, POINT_OUTER_BOUND_MS);
          expectFulfilled(settled);
          const result = settled.value;

          expect(relationEntries).toBe(1);
          expect(headerEntries).toBe(1);
          expect(fetch).toHaveBeenCalledTimes(1);
          const url = new URL(String(fetch.mock.calls[0]?.[0]));
          expect(url.pathname).toBe("/rest/v1/items");
          expect(url.searchParams.getAll("id")).toEqual([`eq.${expectedId}`]);
          expect(url.searchParams.getAll("select")).toEqual(["*"]);
          expect(url.searchParams.getAll("limit")).toEqual(["1"]);
          expect(result.key).toEqual(key("items", expectedId));
          expect(result.key).not.toBe(callerKey);
          expect(callerKey.id).not.toBe(expectedId);
          if (present) {
            expect(result.exists).toBe(true);
            expect(result.data).toEqual({ done: false, priority: 1 });
            expect(entered()).toBe(1);
            expect(callerKey.id).toBe("codec-spoof");
          } else {
            expect(result).toEqual({ key: key("items", expectedId), exists: false });
            expect(entered()).toBe(0);
            expect(callerKey.id).toBe("header-spoof");
          }
        } finally {
          try {
            controller.abort();
            const settled = await withinBound(publicSettlement, POINT_OUTER_BOUND_MS);
            if (!settled.ok) cleanupFailure = settled.error;
          } catch (error) {
            cleanupFailure = error;
          }
        }
        expect(cleanupFailure).toBeUndefined();
        expect(controller.signal.aborted).toBe(true);
      });
    }
  }

  for (const entry of pointEntries) {
    for (const present of [true, false]) {
      it(`keeps the original key when the caller mutates it during ${entry} ${present ? "present" : "missing"}`, async () => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        const expectedId = present ? "milk" : "missing";
        const callerKey = key("items", expectedId);
        const controller = new AbortController();
        const pending = deferred<Response>();
        const entryAcked = deferred<boolean>();
        fetch.mockImplementation(() => {
          entryAcked.resolve(true);
          return pending.promise;
        });
        const { codec, entered } = readCodec((data) => decodeItem(data));
        const db = new PostgrestDatabase({
          baseUrl: "https://api.example.com/rest/v1",
          fetch,
          headers: { authorization: "Bearer opaque" },
          timeoutMs: POINT_TIMEOUT_MS,
        });
        const publicSettlement = settle(readPoint(entry, db, callerKey, codec, controller));
        let pendingSettled = false;
        let cleanupFailure: unknown;

        try {
          const entryOutcome = await withinBound(
            Promise.race<EntryOutcome>([
              entryAcked.promise.then((): EntryOutcome => ({ kind: "entered" })),
              publicSettlement.then((outcome): EntryOutcome => ({ kind: "terminal", outcome })),
            ]),
            POINT_OUTER_BOUND_MS,
          );
          expectEnteredBeforeTerminal(entryOutcome);
          expect(fetch).toHaveBeenCalledTimes(1);
          const enteredUrl = new URL(String(fetch.mock.calls[0]?.[0]));
          expect(enteredUrl.pathname).toBe("/rest/v1/items");
          expect(enteredUrl.searchParams.getAll("id")).toEqual([`eq.${expectedId}`]);
          expect(enteredUrl.searchParams.getAll("select")).toEqual(["*"]);
          expect(enteredUrl.searchParams.getAll("limit")).toEqual(["1"]);

          Reflect.set(callerKey, "collection", "pending-mutated");
          Reflect.set(callerKey, "id", "pending-spoof");
          Reflect.set(callerKey, "parent", key("parents", "pending"));
          pending.resolve(present
            ? response(200, [{ id: "milk", done: false, priority: 1 }])
            : response(200, []));
          pendingSettled = true;

          const settled = await withinBound(publicSettlement, POINT_OUTER_BOUND_MS);
          expectFulfilled(settled);
          const result = settled.value;
          expect(result.key).toEqual(key("items", expectedId));
          expect(result.key).not.toBe(callerKey);
          if (present) {
            expect(result.exists).toBe(true);
            expect(result.data).toEqual({ done: false, priority: 1 });
            expect(entered()).toBe(1);
          } else {
            expect(result).toEqual({ key: key("items", expectedId), exists: false });
            expect(entered()).toBe(0);
          }

          Reflect.set(callerKey, "collection", "after-mutated");
          Reflect.set(callerKey, "id", "after-spoof");
          Reflect.set(callerKey, "parent", key("parents", "after"));
          expect(result.key).toEqual(key("items", expectedId));
          expect(result.key.id).toBe(expectedId);
          expect(result.key.collection).toBe("items");
          expect(result.key.parent).toBeUndefined();
          const finalUrl = new URL(String(fetch.mock.calls[0]?.[0]));
          expect(finalUrl.searchParams.getAll("id")).toEqual([`eq.${expectedId}`]);
          expect(fetch).toHaveBeenCalledTimes(1);
        } finally {
          try {
            controller.abort();
            if (!pendingSettled) {
              pending.resolve(response(200, []));
              pendingSettled = true;
            }
            const settled = await withinBound(publicSettlement, POINT_OUTER_BOUND_MS);
            if (!settled.ok) cleanupFailure = settled.error;
          } catch (error) {
            cleanupFailure = error;
          }
        }
        expect(cleanupFailure).toBeUndefined();
        expect(controller.signal.aborted).toBe(true);
        expect(pendingSettled).toBe(true);
      });
    }
  }

  it("keeps preaborted and malformed point admission ahead of every callback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const headers = vi.fn(() => ({ authorization: "Bearer opaque" }));
    const relationName = vi.fn((name: string) => name);
    const db = new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      fetch,
      headers,
      relationName,
    });

    const preaborted = new AbortController();
    const privateReason = new Error("private point preabort reason");
    preaborted.abort(privateReason);
    const nested = key("items", "nested");
    Reflect.set(nested, "parent", key("parents", "one"));
    const preabortError = await db
      .getWithSignal(nested, preaborted.signal)
      .catch((reason: unknown) => reason);
    expect(preabortError).toBeInstanceOf(QueryCancelledError);
    expect(preabortError).toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    expect(String(preabortError)).not.toContain(privateReason.message);
    expect(relationName).not.toHaveBeenCalled();
    expect(headers).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    const unsafeError = await db.get(key("items", 2 ** 53)).catch((reason: unknown) => reason);
    expect(unsafeError).toBeInstanceOf(TypeError);
    expect(String(unsafeError)).toContain("lossless");
    expect(relationName).not.toHaveBeenCalled();
    expect(headers).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    const nestedError = await db.get(nested).catch((reason: unknown) => reason);
    expect(nestedError).toBeInstanceOf(UnsupportedError);
    expect(String(nestedError)).toContain("nested DALgo keys");
    expect(relationName).not.toHaveBeenCalled();
    expect(headers).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
