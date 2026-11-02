import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { CloudflareKvDatabase } from "./database.js";
import { KvCoreDatabase } from "./core.js";
import { Manager, safe, type Operation } from "./operation.js";
import { CloudflareKvError, type KvEntry, type KvLimits, type KvListPage, type KvListRequest, type KvReader } from "./types.js";
import { base64, compareUtf8, copiedArray, jsonWire, keyInfo, nativeKey, only, unbase64, utf8 } from "./validation.js";
import { parseJson } from "./json.js";

type Descriptor = { kind: "getMany"; keys: readonly string[] } | { kind: "list"; request: KvListRequest };
function descriptor(value: unknown, maximumKeys: number): Descriptor {
  const input = only(value, ["kind", "keys", "request"]);
  if (input.kind === "getMany" && !Object.hasOwn(input, "request")) {
    return { kind: "getMany", keys: copiedArray(input.keys, maximumKeys).map(nativeKey) };
  }
  if (input.kind !== "list" || Object.hasOwn(input, "keys")) throw new CloudflareKvError("input");
  const request = only(input.request, ["prefix", "limit", "cursor"]);
  const prefix = utf8(request.prefix, 512, true);
  const limit = request.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) throw new CloudflareKvError("input");
  const cursor = request.cursor;
  if (cursor !== undefined && (typeof cursor !== "string" || !/^[0-9a-f]{48}$/u.test(cursor))) throw new CloudflareKvError("input");
  return { kind: "list", request: { prefix, ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) } };
}
function wireEntry(entry: KvEntry | null): unknown {
  return entry === null ? null : { key: entry.key, value: base64(entry.value), ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }), ...(entry.expiration === undefined ? {} : { expiration: entry.expiration }) };
}
function readEntry(value: unknown, expected: string, operation: Operation): KvEntry | null {
  if (value === null) return null;
  const entry = only(value, ["key", "value", "metadata", "expiration"]);
  if (entry.key !== expected) throw new CloudflareKvError("protocol");
  const info = keyInfo({ name: entry.key, ...(Object.hasOwn(entry, "metadata") ? { metadata: entry.metadata } : {}), ...(entry.expiration === undefined ? {} : { expiration: entry.expiration }) }, () => { operation.check(); });
  return { key: info.name, value: unbase64(entry.value, operation.limits.maxValueBytes), ...(info.metadata === undefined ? {} : { metadata: info.metadata }), ...(info.expiration === undefined ? {} : { expiration: info.expiration }) };
}
function response(status: number, value: unknown, operation?: Operation): Response {
  const body = operation === undefined ? JSON.stringify(value) : jsonWire(value, operation.limits.maxResponseBytes, () => { operation.check(); });
  return new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
async function readJson(body: ReadableStream<Uint8Array> | null, maximum: number, operation: Operation): Promise<unknown> {
  const bytes = await operation.bytes(body, maximum);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return parseJson(text, () => { operation.check(); });
}

export interface CloudflareKvHttpHandlerOptions extends KvLimits {
  /** Mandatory authentication, origin/CSRF and principal authorization. Return
   * a stable per-authority configured database; never use client endpoints,
   * account IDs, namespace IDs, prefix grants or API credentials. */
  readonly authorize: (request: Request, signal: AbortSignal) => CloudflareKvDatabase | undefined | Promise<CloudflareKvDatabase | undefined>;
}
/** Hosting layer must turn actual upload/disconnect into Request.signal abort. */
export function createCloudflareKvHttpHandler(options: CloudflareKvHttpHandlerOptions): (request: Request) => Promise<Response> {
  if (typeof options.authorize !== "function") throw new CloudflareKvError("configuration");
  const manager = new Manager(options);
  return async (request) => {
    if (request.method !== "POST") return response(405, { error: "input" });
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return response(415, { error: "input" });
    let operation: Operation | undefined;
    try {
      operation = manager.begin(request.signal);
      const active = operation;
      const input = descriptor(await readJson(request.body, active.limits.maxRequestBytes, active), active.limits.maxKeys);
      const database = await active.foreign(() => options.authorize(request, active.signal));
      active.check();
      if (database === undefined) throw new CloudflareKvError("permission");
      if (!(database instanceof CloudflareKvDatabase)) throw new CloudflareKvError("configuration");
      if (input.kind === "getMany") {
        return await database.mapRead(() => input.keys, (entries, check) => {
          check(); active.check(); const result = response(200, { kind: "entries", entries: entries.map(wireEntry) }, active); check(); active.check(); return result;
        }, active.signal, active);
      }
      // All serialization/response construction happens before native ACK.
      return await database.mapList(input.request, (page, check) => {
        check(); active.check(); const result = response(200, { kind: "list", ...page }, active); check(); active.check(); return result;
      }, active.signal, active);
    } catch (original) {
      let failure: Error;
      try { failure = operation === undefined ? safe(original) : operation.failure(original); }
      catch (fresh) { failure = safe(fresh); }
      if (failure instanceof QueryCancelledError) return response(408, { error: "cancelled", reason: failure.reason });
      const code = failure instanceof CloudflareKvError ? failure.code : "transport";
      const status = code === "permission" ? 403 : code === "authentication" ? 401 : code === "bounds" ? 413 : code === "input" || code === "protocol" ? 400 : code === "busy" ? 503 : 502;
      return response(status, { error: code, ...(failure instanceof CloudflareKvError && failure.status !== undefined ? { providerStatus: failure.status } : {}) });
    } finally { operation?.finish(); }
  };
}

export interface CloudflareKvHttpOptions extends KvLimits {
  readonly endpoint: string;
  /** Application bridge authentication only. Never supply Cloudflare API tokens. */
  readonly headers?: (signal: AbortSignal) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  readonly fetch?: typeof fetch;
  readonly allowLoopbackHttpForTesting?: boolean;
}

/** Browser-safe client of an authenticated fixed-authority bridge. */
export class CloudflareKvHttpDatabase implements KvReader {
  readonly #endpoint: string;
  readonly #headers: CloudflareKvHttpOptions["headers"];
  readonly #fetch: typeof fetch;
  readonly #manager: Manager;
  public constructor(options: CloudflareKvHttpOptions) {
    const url = new URL(options.endpoint, typeof location === "undefined" ? undefined : location.href);
    if ((url.protocol !== "https:" && !(options.allowLoopbackHttpForTesting === true && ["127.0.0.1", "[::1]"].includes(url.hostname) && url.protocol === "http:")) || url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== "") throw new CloudflareKvError("configuration");
    this.#endpoint = url.toString(); this.#headers = options.headers; this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init)); this.#manager = new Manager(options);
  }
  public close(): void { this.#manager.close(); }
  public asDatabase(collection: string): KvCoreDatabase { return new KvCoreDatabase(this, collection); }
  private async execute(input: Descriptor, operation: Operation): Promise<unknown> {
    const body = jsonWire(input, operation.limits.maxRequestBytes, () => { operation.check(); });
    const supplied = await operation.foreign(() => this.#headers?.(operation.signal));
    const fields = supplied === undefined ? {} : only(supplied, Object.keys(supplied));
    for (const value of Object.values(fields)) if (typeof value !== "string" || /[\r\n]/u.test(value)) throw new CloudflareKvError("input");
    const headers = new Headers();
    for (const [name, value] of Object.entries(fields)) { if (typeof value !== "string") throw new CloudflareKvError("input"); headers.set(name, value); }
    headers.set("content-type", "application/json");
    operation.request(); let owned: Response | undefined; let reading = false;
    try {
      const result = await operation.foreign(() => Promise.resolve(this.#fetch(this.#endpoint, { method: "POST", body, headers, signal: operation.signal, redirect: "error", credentials: "same-origin", cache: "no-store" })).then((value) => { owned = value; return value; }), (late) => { operation.cleanup(late.body); });
      if (result.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new CloudflareKvError("protocol");
      reading = true; const value = await readJson(result.body, operation.limits.maxResponseBytes, operation);
      if (result.status !== 200) {
        const failure = only(value, ["error", "reason", "providerStatus"]);
        if (result.status === 408 && failure.error === "cancelled" && (failure.reason === "caller" || failure.reason === "deadline")) throw new QueryCancelledError(failure.reason);
        const codes = ["configuration", "input", "permission", "authentication", "bounds", "protocol", "transport", "http", "closed", "busy"] as const;
        const code = codes.find((item) => item === failure.error);
        if (code === undefined) throw new CloudflareKvError("protocol");
        const status = failure.providerStatus;
        if (status !== undefined && (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599)) throw new CloudflareKvError("protocol");
        throw new CloudflareKvError(code, typeof status === "number" ? status : undefined);
      }
      operation.check(); return value;
    } finally { if (!reading) operation.cleanup(owned?.body); }
  }
  public async mapRead<T>(admit: (maximumKeys: number, check: () => void) => readonly string[], deliver: (values: readonly (KvEntry | null)[], check: () => void) => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    const operation = this.#manager.begin(signal);
    try {
      const keys = copiedArray(admit(operation.limits.maxKeys, () => { operation.check(); }), operation.limits.maxKeys).map(nativeKey);
      operation.rows(keys.length);
      const raw = only(await this.execute({ kind: "getMany", keys }, operation), ["kind", "entries"]);
      if (raw.kind !== "entries") throw new CloudflareKvError("protocol");
      const values = copiedArray(raw.entries, keys.length);
      if (values.length !== keys.length) throw new CloudflareKvError("protocol");
      const entries = values.map((value, index) => { const key = keys[index]; if (key === undefined) throw new CloudflareKvError("protocol"); return readEntry(value, key, operation); });
      operation.check(); const result = await operation.foreign(() => deliver(entries, () => { operation.check(); })); operation.prepareDelivery(); return result;
    } catch (error) { throw operation.failure(error); }
    finally { operation.finish(); }
  }
  public get(key: string, signal?: AbortSignal): Promise<KvEntry | null> { return this.mapRead(() => [key], (values) => values[0] ?? null, signal); }
  public getMany(keys: readonly string[], signal?: AbortSignal): Promise<readonly (KvEntry | null)[]> { return this.mapRead(() => keys, (values) => values, signal); }
  public testConnection(key: string, signal?: AbortSignal): Promise<void> { return this.mapRead(() => [key], () => undefined, signal); }
  public async list(request: KvListRequest, signal?: AbortSignal): Promise<KvListPage> {
    const operation = this.#manager.begin(signal);
    try {
      const input = descriptor({ kind: "list", request }, operation.limits.maxKeys);
      if (input.kind !== "list") throw new CloudflareKvError("protocol");
      const raw = only(await this.execute(input, operation), ["kind", "keys", "complete", "nextCursor"]);
      if (raw.kind !== "list" || typeof raw.complete !== "boolean") throw new CloudflareKvError("protocol");
      const keys = copiedArray(raw.keys, input.request.limit ?? 100).map((item) => keyInfo(item, () => { operation.check(); }));
      let previous: string | undefined;
      for (const key of keys) { if (!key.name.startsWith(input.request.prefix) || (previous !== undefined && compareUtf8(previous, key.name) >= 0)) throw new CloudflareKvError("protocol"); previous = key.name; }
      const cursor = raw.nextCursor;
      if (raw.complete ? cursor !== undefined : typeof cursor !== "string" || !/^[0-9a-f]{48}$/u.test(cursor)) throw new CloudflareKvError("protocol");
      operation.rows(keys.length); operation.check();
      const page: KvListPage = { keys, complete: raw.complete, ...(typeof cursor === "string" ? { nextCursor: cursor } : {}) };
      operation.prepareDelivery(); return page;
    } catch (error) { throw operation.failure(error); }
    finally { operation.finish(); }
  }
}
