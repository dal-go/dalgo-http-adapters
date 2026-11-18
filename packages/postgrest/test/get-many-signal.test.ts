import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { UnsupportedError, key, type Key } from "@dalgo/core";
import { describe, expect, it, vi } from "vitest";

import { PostgrestDatabase, PostgrestHttpError } from "../src/index.js";

const BASE_URL = "https://api.example.com/rest/v1";

function response(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers });
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

describe("PostgrestDatabase.getMany signal and admission", () => {
  it("captures every Key value and fixed membership before first relation callback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const first = key("items", "one");
    const later = key("items", "two");
    const missing = key("items", "missing");
    const keys: Key[] = [first, later, first, missing];
    let relationEntries = 0;
    const db = new PostgrestDatabase({
      baseUrl: BASE_URL,
      fetch,
      headers: { authorization: "Bearer opaque" },
      maxGetManyKeys: 4,
      maxParallelReads: 1,
      relationName: (name) => {
        relationEntries += 1;
        if (relationEntries === 1) {
          Reflect.set(first, "id", "spoof");
          Reflect.set(later, "collection", "mutated");
          Reflect.set(later, "id", "mutated-id");
          Reflect.set(missing, "parent", key("parents", "one"));
          keys[1] = key("items", "replacement");
          keys.push(key("items", "extra"));
        }
        return name;
      },
    });
    fetch.mockResolvedValueOnce(response(200, [{ id: "one", done: false, priority: 1 }]));
    fetch.mockResolvedValueOnce(response(200, [{ id: "two", done: true, priority: 2 }]));
    fetch.mockResolvedValueOnce(response(200, [{ id: "one", done: false, priority: 1 }]));
    fetch.mockResolvedValueOnce(response(200, []));

    const records = await db.getMany(keys);

    expect(relationEntries).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(records).toHaveLength(4);
    expect(records[0]).toEqual({ key: key("items", "one"), exists: true, data: { done: false, priority: 1 } });
    expect(records[1]).toEqual({ key: key("items", "two"), exists: true, data: { done: true, priority: 2 } });
    expect(records[2]).toEqual({ key: key("items", "one"), exists: true, data: { done: false, priority: 1 } });
    expect(records[3]).toEqual({ key: key("items", "missing"), exists: false });
    expect(records.map((record) => `${record.key.collection}/${String(record.key.id)}`))
      .toEqual(["items/one", "items/two", "items/one", "items/missing"]);
    const recordKeys = records.map((record) => record.key);
    expect(recordKeys).not.toContain(first);
    expect(new Set(recordKeys).size).toBe(4);
    const urls = fetch.mock.calls.map(([input]) => new URL(input.toString()));
    expect(urls.map((url) => url.pathname)).toEqual(["/rest/v1/items", "/rest/v1/items", "/rest/v1/items", "/rest/v1/items"]);
    expect(urls.map((url) => url.searchParams.get("id"))).toEqual(["eq.one", "eq.two", "eq.one", "eq.missing"]);
    expect(keys).toHaveLength(5);
    expect(keys[0]).toBe(keys[2]);
    expect(keys.map((entry) => `${entry.collection}/${String(entry.id)}`))
      .toEqual(["items/spoof", "items/replacement", "items/spoof", "items/missing", "items/extra"]);
    expect(first.id).toBe("spoof");
    expect(`${later.collection}/${String(later.id)}`).toBe("mutated/mutated-id");
    expect(keys[3]?.parent).toEqual(key("parents", "one"));
  });

  it("one original batch deadline spans completed first read and pending second headers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const firstHeaders = deferred<Readonly<Record<string, string>>>();
    const secondHeaders = deferred<Readonly<Record<string, string>>>();
    const marker = deferred<boolean>();
    let headerCalls = 0;
    let firstHeaderEntered = false;
    let secondHeaderEntered = false;
    let publicSettled = false;
    let publicError: unknown;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    let markerTimer: ReturnType<typeof setTimeout> | undefined;
    const db = new PostgrestDatabase({
      baseUrl: BASE_URL,
      fetch,
      timeoutMs: 600,
      maxParallelReads: 1,
      headers: () => {
        headerCalls += 1;
        if (headerCalls === 1) {
          firstHeaderEntered = true;
          markerTimer = setTimeout(() => { marker.resolve(true); }, 750);
          releaseTimer = setTimeout(() => {
            firstHeaders.resolve({ authorization: "Bearer first" });
          }, 300);
          return firstHeaders.promise;
        }
        if (headerCalls === 2) {
          secondHeaderEntered = true;
          return secondHeaders.promise;
        }
        return { authorization: "Bearer later" };
      },
    });
    fetch.mockResolvedValueOnce(response(200, [{ id: "one", done: false }]));
    const keys = [key("items", "one"), key("items", "two"), key("items", "three")];
    const publicSettlement = db.getManyWithSignal(keys, new AbortController().signal).then(
      () => {
        publicSettled = true;
        return { resolved: true as const };
      },
      (error: unknown) => {
        publicSettled = true;
        publicError = error;
        return { resolved: false as const, error };
      },
    );

    try {
      await marker.promise;
      expect(firstHeaderEntered).toBe(true);
      expect(secondHeaderEntered).toBe(true);
      expect(publicSettled).toBe(true);
      expect(publicError).toBeInstanceOf(QueryCancelledError);
      expect(publicError).toMatchObject({ name: "QueryCancelledError", reason: "deadline" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(headerCalls).toBe(2);
    } finally {
      if (releaseTimer !== undefined) clearTimeout(releaseTimer);
      if (markerTimer !== undefined) clearTimeout(markerTimer);
      firstHeaders.resolve({ authorization: "Bearer cleanup" });
      secondHeaders.resolve({ authorization: "Bearer cleanup" });
      await publicSettlement;
      await flush();
    }

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(headerCalls).toBe(2);
  }, 2_000);

  it("first real HTTP failure aborts sibling and prevents later dispatch without waiting for hostile work", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const dispatchEntry = deferred<boolean>();
    const cancelEntry = deferred<boolean>();
    const signals: AbortSignal[] = [];
    let dispatch = 0;
    fetch.mockImplementation((_input, init) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) throw new Error("request signal missing");
      signals.push(signal);
      dispatch += 1;
      if (dispatch === 1) return first.promise;
      if (dispatch === 2) {
        dispatchEntry.resolve(true);
        return second.promise;
      }
      return Promise.resolve(response(200, []));
    });
    const headers = vi.fn(() => ({ authorization: "Bearer opaque" }));
    const db = new PostgrestDatabase({ baseUrl: BASE_URL, fetch, headers, maxParallelReads: 2 });
    const keys = ["one", "two", "three", "four"].map((id) => key("items", id));
    let siblingAborted = false;
    let publicError: unknown;
    let settlementGuard: ReturnType<typeof setTimeout> | undefined;
    const publicSettlement = db.getMany(keys).then(
      () => ({ resolved: true as const }),
      (error: unknown) => {
        publicError = error;
        return { resolved: false as const, error };
      },
    );
    const settlementDeadline = new Promise<never>((_resolve, reject) => {
      settlementGuard = setTimeout(() => {
        reject(new Error("public settlement did not occur within the test bound"));
      }, 1_500);
    });
    let lateCancelAcked = false;
    const hostileBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        lateCancelAcked = true;
        cancelEntry.resolve(true);
        return Promise.reject(new Error("hostile late cancel"));
      },
    });
    try {
      await Promise.race([dispatchEntry.promise, settlementDeadline]);
      const siblingSignal = signals[1];
      if (siblingSignal === undefined) throw new Error("sibling request signal missing");
      siblingSignal.addEventListener("abort", () => { siblingAborted = true; }, { once: true });
      first.resolve(response(403, { detail: "secret row values never leak" }));
      const settlement = await Promise.race([publicSettlement, settlementDeadline]);

      expect(settlement.resolved).toBe(false);
      expect(publicError).toEqual(new PostgrestHttpError(403));
      expect(siblingAborted).toBe(true);
      expect(signals[1]?.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(headers).toHaveBeenCalledTimes(2);
      second.resolve(new Response(hostileBody, { status: 200 }));
      await Promise.race([cancelEntry.promise, settlementDeadline]);
      expect(lateCancelAcked).toBe(true);
    } finally {
      if (settlementGuard !== undefined) clearTimeout(settlementGuard);
      dispatchEntry.resolve(true);
      cancelEntry.resolve(true);
      first.resolve(response(200, []));
      second.resolve(response(200, []));
      void hostileBody.cancel().catch(() => undefined);
      void publicSettlement.catch(() => undefined);
      await flush();
    }

    fetch.mockImplementation(() => Promise.resolve(response(200, [{ id: "fresh", done: false }])));
    await expect(db.get(key("items", "fresh"))).resolves.toEqual({
      key: key("items", "fresh"), exists: true, data: { done: false },
    });
  }, 2_000);

  it("real caller abort after dispatch owns the whole batch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const signals: AbortSignal[] = [];
    let dispatch = 0;
    fetch.mockImplementation((_input, init) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) throw new Error("request signal missing");
      signals.push(signal);
      dispatch += 1;
      if (dispatch === 1) return first.promise;
      if (dispatch === 2) return second.promise;
      return Promise.resolve(response(200, []));
    });
    const db = new PostgrestDatabase({
      baseUrl: BASE_URL,
      fetch,
      headers: { authorization: "Bearer opaque" },
      maxParallelReads: 2,
    });
    const controller = new AbortController();
    const privateReason = new Error("private caller reason");
    let publicError: unknown;
    let settlementGuard: ReturnType<typeof setTimeout> | undefined;
    const keys = ["one", "two", "three", "four"].map((id) => key("items", id));
    const publicSettlement = db.getManyWithSignal(keys, controller.signal).then(
      () => ({ resolved: true as const }),
      (error: unknown) => {
        publicError = error;
        return { resolved: false as const, error };
      },
    );
    const settlementDeadline = new Promise<never>((_resolve, reject) => {
      settlementGuard = setTimeout(() => {
        reject(new Error("public settlement did not occur within the test bound"));
      }, 1_500);
    });

    try {
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(2);
      }, { timeout: 1_000 });
      controller.abort(privateReason);
      const settlement = await Promise.race([publicSettlement, settlementDeadline]);

      expect(settlement.resolved).toBe(false);
      expect(publicError).toBeInstanceOf(QueryCancelledError);
      expect(publicError).toMatchObject({
        name: "QueryCancelledError",
        reason: "caller",
        message: "query cancelled by caller",
      });
      expect(String(publicError)).not.toContain(privateReason.message);
      expect((publicError as { cause?: unknown }).cause).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(signals).toHaveLength(2);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(true);
    } finally {
      if (settlementGuard !== undefined) clearTimeout(settlementGuard);
      first.resolve(response(200, [{ id: "one", done: false }]));
      second.resolve(response(200, [{ id: "two", done: true }]));
      void publicSettlement.catch(() => undefined);
      await flush();
    }

    fetch.mockImplementation(() => Promise.resolve(response(200, [{ id: "fresh", done: false }])));
    await expect(db.get(key("items", "fresh"))).resolves.toEqual({
      key: key("items", "fresh"), exists: true, data: { done: false },
    });
  }, 2_000);

  it("empty and invalid/preaborted admission has zero external work", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const headers = vi.fn(() => ({ authorization: "Bearer opaque" }));
    const relationName = vi.fn((name: string) => name);
    const db = new PostgrestDatabase({
      baseUrl: BASE_URL,
      fetch,
      headers,
      relationName,
      maxGetManyKeys: 2,
    });

    await expect(db.getMany([])).resolves.toEqual([]);
    expect(relationName).not.toHaveBeenCalled();
    expect(headers).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    const preaborted = new AbortController();
    const privateReason = new Error("private preabort reason");
    preaborted.abort(privateReason);
    const sparseBeforeAbort: Key[] = [];
    sparseBeforeAbort.length = 1;
    const preabortError = await db
      .getManyWithSignal(sparseBeforeAbort, preaborted.signal)
      .catch((reason: unknown) => reason);
    expect(preabortError).toBeInstanceOf(QueryCancelledError);
    expect(preabortError).toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    expect(String(preabortError)).not.toContain(privateReason.message);
    expect(relationName).not.toHaveBeenCalled();
    expect(headers).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    const live = new AbortController().signal;
    const sparse: Key[] = [];
    sparse[1] = key("items", "one");
    const sparseError = await db.getManyWithSignal(sparse, live).catch((reason: unknown) => reason);
    expect(sparseError).toBeInstanceOf(UnsupportedError);
    expect(String(sparseError)).toContain("sparse");

    const nested = key("items", "nested");
    Reflect.set(nested, "parent", key("parents", "one"));
    const nestedError = await db.getManyWithSignal([nested], live).catch((reason: unknown) => reason);
    expect(nestedError).toBeInstanceOf(UnsupportedError);
    expect(String(nestedError)).toContain("nested DALgo keys");

    const countError = await db
      .getManyWithSignal([key("items", "one"), key("items", "two"), key("items", "three")], live)
      .catch((reason: unknown) => reason);
    expect(countError).toBeInstanceOf(UnsupportedError);
    expect(String(countError)).toContain("above 2");

    const unsafeError = await db
      .getManyWithSignal([key("items", 2 ** 53)], live)
      .catch((reason: unknown) => reason);
    expect(unsafeError).toBeInstanceOf(TypeError);
    expect(String(unsafeError)).toContain("lossless");

    expect(relationName).not.toHaveBeenCalled();
    expect(headers).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
