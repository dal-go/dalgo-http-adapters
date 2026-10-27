import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { DOCUMENT_ID, UnsupportedError, collection, key } from "@dalgo/core";
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
    expect(POSTGREST_READ_CAPABILITIES.query.discovery.status).toBe("unsupported");
    expect(POSTGREST_READ_CAPABILITIES.bounds.filterOperators).toContain("array-contains-any");
  });
});
