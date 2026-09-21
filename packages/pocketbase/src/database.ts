import {
  DOCUMENT_ID,
  Key,
  NotFoundError,
  UnsupportedError,
  identityCodec,
  type Codec,
  type Database,
  type ExistingRecord,
  type QueryFilter,
  type QueryPage,
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
} from "@dal-go/dalgo";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_GET_MANY = 100;
const DEFAULT_MAX_PARALLEL_READS = 8;
const DEFAULT_MAX_QUERY_LIMIT = 100;
const DEFAULT_MAX_QUERY_WINDOW = 1_000;

export type PocketBaseFetch = typeof globalThis.fetch;
export type PocketBaseHeaders = Readonly<Record<string, string>>;
export type PocketBaseHeaderProvider = PocketBaseHeaders | (() => PocketBaseHeaders | Promise<PocketBaseHeaders>);

export interface PocketBaseDatabaseOptions {
  /** PocketBase server URL, without a path (for example `https://db.example.com`). */
  readonly baseUrl: string;
  /** Re-evaluated for each request; use it for a short-lived user auth token. */
  readonly headers?: PocketBaseHeaderProvider;
  readonly fetch?: PocketBaseFetch;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxGetManyKeys?: number;
  readonly maxParallelReads?: number;
  readonly maxQueryLimit?: number;
  /** Maximum `offset + limit` emulated with PocketBase's page API. */
  readonly maxQueryWindow?: number;
  /** Maps a top-level DALgo collection name to a PocketBase collection name or ID. */
  readonly collectionName?: (collection: string) => string;
}

/** Deliberately excludes PocketBase error bodies, which can contain application data. */
export class PocketBaseHttpError extends Error {
  public constructor(public readonly status: number) {
    super(`PocketBase request failed with HTTP ${String(status)}`);
    this.name = "PocketBaseHttpError";
  }
}

/** Redacted failure obtaining credentials, making a request, or reading a response. */
export class PocketBaseRequestError extends Error {
  public constructor() {
    super("PocketBase request could not be completed");
    this.name = "PocketBaseRequestError";
  }
}

function positive(value: number | undefined, fallback: number, name: string, maximum = 16_777_216): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`${name} must be a safe integer from 1 to ${String(maximum)}`);
  return result;
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function json(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("PocketBase JSON numbers must be finite and not -0");
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("PocketBase JSON must not contain cycles");
    seen.add(value); for (const item of value) json(item, seen); seen.delete(value); return;
  }
  if (!plainObject(value) || seen.has(value)) throw new TypeError("PocketBase JSON must contain only plain objects, arrays, and primitives");
  seen.add(value); for (const item of Object.values(value)) json(item, seen); seen.delete(value);
}

function recordData<T>(data: T, codec: Codec<T>): Record<string, unknown> {
  const encoded = codec.encode(data);
  if (!plainObject(encoded)) throw new TypeError("PocketBase DALgo records must encode to a non-null plain JSON object");
  for (const field of Object.keys(encoded)) if (RESERVED_FIELDS.has(field)) throw new TypeError("PocketBase record data must not contain system fields");
  json(encoded);
  return encoded;
}

const RESERVED_FIELDS = new Set(["id", "collectionId", "collectionName", "created", "updated", "expand"]);

function collectionId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/u.test(value)) throw new UnsupportedError("PocketBase collection names or IDs must be URL-safe identifiers");
  return value;
}

function recordId(key: Key): string {
  if (key.parent !== undefined) throw new UnsupportedError("PocketBase nested DALgo keys");
  if (typeof key.id !== "string" || !/^[A-Za-z0-9]{15}$/u.test(key.id)) throw new UnsupportedError("PocketBase record IDs must be 15 alphanumeric characters");
  return key.id;
}

function responseRecordId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9]{15}$/u.test(value)) throw new PocketBaseRequestError();
  return value;
}

function field(value: unknown): string {
  if (value === DOCUMENT_ID) return "id";
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,254}$/u.test(value)) throw new UnsupportedError("PocketBase query field names");
  return value;
}

function filterValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new UnsupportedError("PocketBase query numbers");
    return String(value);
  }
  if (typeof value === "string") return `'${value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`;
  throw new UnsupportedError("PocketBase query value types");
}

function compileFilter<T>(filter: QueryFilter<T>): string {
  const name = field(filter.field);
  const one = (): string => filterValue(filter.value);
  const many = (): readonly string[] => {
    if (!Array.isArray(filter.value) || filter.value.length === 0) throw new TypeError("PocketBase in query filters require a non-empty array");
    return filter.value.map(filterValue);
  };
  switch (filter.operator) {
    case "==": return `${name} = ${one()}`;
    case "!=": return `${name} != ${one()}`;
    case "<": return `${name} < ${one()}`;
    case "<=": return `${name} <= ${one()}`;
    case ">": return `${name} > ${one()}`;
    case ">=": return `${name} >= ${one()}`;
    case "in": return `(${many().map((value) => `${name} = ${value}`).join(" || ")})`;
    case "not-in": return `(${many().map((value) => `${name} != ${value}`).join(" && ")})`;
    case "array-contains": return `${name} ?= ${one()}`;
    default: throw new UnsupportedError(`PocketBase ${String(filter.operator)} query filters`);
  }
}

function validateHeaders(headers: PocketBaseHeaders): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string" || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) throw new TypeError("PocketBase configured headers must be CR/LF-safe strings");
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new PocketBaseRequestError());
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new PocketBaseRequestError());
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function cancel(body: ReadableStream<Uint8Array> | null): void { void body?.cancel().catch(() => undefined); }

async function readJson(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) { cancel(response.body); throw new RangeError("PocketBase response exceeds maxResponseBytes"); }
  if (response.body === null) return undefined;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) { void reader.cancel().catch(() => undefined); throw new RangeError("PocketBase response exceeds maxResponseBytes"); }
      chunks.push(item.value);
    }
  } finally { if (signal.aborted) void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* cancellation can retain a read */ } }
  const bytes = new Uint8Array(total); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes.byteLength === 0 ? undefined : JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export class PocketBaseDatabase implements Database {
  readonly #base: string; readonly #collectionName: (collection: string) => string; readonly #headers: PocketBaseHeaderProvider | undefined;
  readonly #fetch: PocketBaseFetch; readonly #timeoutMs: number; readonly #maxRequestBytes: number; readonly #maxResponseBytes: number;
  readonly #maxGetManyKeys: number; readonly #maxParallelReads: number; readonly #maxQueryLimit: number; readonly #maxQueryWindow: number;

  public constructor(options: PocketBaseDatabaseOptions) {
    const url = new URL(options.baseUrl.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new TypeError("baseUrl must use HTTPS, except for loopback development");
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new TypeError("baseUrl must not contain credentials, a path, a query, or a fragment");
    this.#base = `${url.toString().replace(/\/+$/u, "")}/api/collections/`;
    this.#collectionName = options.collectionName ?? ((collection) => collection);
    this.#headers = options.headers; this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 120_000);
    this.#maxRequestBytes = positive(options.maxRequestBytes, DEFAULT_MAX_BYTES, "maxRequestBytes"); this.#maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_MAX_BYTES, "maxResponseBytes");
    this.#maxGetManyKeys = positive(options.maxGetManyKeys, DEFAULT_MAX_GET_MANY, "maxGetManyKeys", 1_000);
    this.#maxParallelReads = positive(options.maxParallelReads, Math.min(DEFAULT_MAX_PARALLEL_READS, this.#maxGetManyKeys), "maxParallelReads", this.#maxGetManyKeys);
    this.#maxQueryLimit = positive(options.maxQueryLimit, DEFAULT_MAX_QUERY_LIMIT, "maxQueryLimit", 1_000);
    this.#maxQueryWindow = positive(options.maxQueryWindow, DEFAULT_MAX_QUERY_WINDOW, "maxQueryWindow", 16_777_216);
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    try { return this.record(await this.request(this.recordUrl(key), "GET", undefined, true), key, codec); }
    catch (error) { if (error instanceof PocketBaseHttpError && error.status === 404) return { key, exists: false }; throw error; }
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#maxGetManyKeys) throw new UnsupportedError(`PocketBase getMany above ${String(this.#maxGetManyKeys)} keys`);
    const result: RecordSnapshot<T>[] = new Array(keys.length); let next = 0;
    const worker = async (): Promise<void> => { for (;;) { const index = next++; const item = keys[index]; if (item === undefined) return; result[index] = await this.get(item, codec); } };
    await Promise.all(Array.from({ length: Math.min(keys.length, this.#maxParallelReads) }, worker)); return result;
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    this.assertMutationRecord(await this.request(this.recordsUrl(key.collection), "POST", { id: recordId(key), ...recordData(data, codecOrIdentity(codec)) }, true), key);
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    void key; void data; void codec;
    // PATCH + POST would race and PocketBase's batch upsert is optional server
    // configuration, not a portable single-record operation.
    throw new UnsupportedError("PocketBase atomic DALgo set/upsert");
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    try { this.assertMutationRecord(await this.request(this.recordUrl(key), "PATCH", recordData(data, identityCodec as Codec<UpdateData>), true), key); }
    catch (error) { if (error instanceof PocketBaseHttpError && error.status === 404) throw new NotFoundError(key, { cause: error }); throw error; }
  }

  public async delete(key: Key): Promise<void> {
    try { await this.request(this.recordUrl(key), "DELETE", undefined, false); }
    catch (error) { if (error instanceof PocketBaseHttpError && error.status === 404) return; throw error; }
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("PocketBase collection-group or nested-collection queries");
    if (query.startAt !== undefined || query.startAfter !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("PocketBase DALgo query cursors");
    const limit = query.limit ?? this.#maxQueryLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#maxQueryLimit) throw new UnsupportedError(`PocketBase query limit above ${String(this.#maxQueryLimit)}`);
    const offset = query.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("PocketBase query offset must be a non-negative safe integer");
    const window = offset + limit;
    if (!Number.isSafeInteger(window) || window > this.#maxQueryWindow) throw new UnsupportedError(`PocketBase query offset plus limit above ${String(this.#maxQueryWindow)}`);
    const url = this.recordsUrl(query.source.name); url.searchParams.set("page", "1"); url.searchParams.set("perPage", String(window)); url.searchParams.set("skipTotal", "true");
    if (query.filters.length > 0) url.searchParams.set("filter", query.filters.map(compileFilter).map((item) => `(${item})`).join(" && "));
    if (query.orders.length > 0) url.searchParams.set("sort", query.orders.map((order) => {
      if (order.direction !== "asc" && order.direction !== "desc") throw new UnsupportedError("PocketBase query order directions");
      return `${order.direction === "desc" ? "-" : "+"}${field(order.field)}`;
    }).join(","));
    const payload = await this.request(url, "GET", undefined, true);
    if (!plainObject(payload) || payload.page !== 1 || payload.perPage !== window || !Array.isArray(payload.items) || payload.items.length > window || !payload.items.every(plainObject)) throw new PocketBaseRequestError();
    return { records: payload.items.slice(offset, window).map((row) => this.record(row, undefined, query.source.codec, query.source.name)) };
  }

  public async runReadwriteTransaction<Result>(callback: (transaction: import("@dal-go/dalgo").ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    void callback; throw new UnsupportedError("PocketBase callback transactions");
  }

  private recordsUrl(collection: string): URL { return new URL(`${encodeURIComponent(collectionId(this.#collectionName(collection)))}/records`, this.#base); }
  private recordUrl(key: Key): URL { return new URL(`${encodeURIComponent(collectionId(this.#collectionName(key.collection)))}/records/${encodeURIComponent(recordId(key))}`, this.#base); }

  private async request(url: URL, method: string, body: unknown | undefined, decode: boolean): Promise<unknown> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined && new TextEncoder().encode(text).byteLength > this.#maxRequestBytes) throw new RangeError("PocketBase request exceeds maxRequestBytes");
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const provided = await abortable(Promise.resolve().then(() => typeof this.#headers === "function" ? this.#headers() : this.#headers), controller.signal);
      if (provided !== undefined) validateHeaders(provided);
      const headers = new Headers(provided); headers.set("accept", "application/json"); if (text !== undefined) headers.set("content-type", "application/json");
      const response = await abortable(Promise.resolve().then(() => this.#fetch(url, { method, headers, redirect: "error", credentials: "omit", ...(text === undefined ? {} : { body: text }), signal: controller.signal })), controller.signal);
      if (!response.ok) { cancel(response.body); throw new PocketBaseHttpError(response.status); }
      if (!decode) { cancel(response.body); return undefined; }
      return await readJson(response, this.#maxResponseBytes, controller.signal);
    } catch (error) { if (error instanceof PocketBaseHttpError || error instanceof PocketBaseRequestError || error instanceof NotFoundError) throw error; throw new PocketBaseRequestError(); }
    finally { clearTimeout(timeout); }
  }

  private record<T>(row: unknown, requested: Key | undefined, codec?: Codec<T>, collection?: string): ExistingRecord<T> {
    if (!plainObject(row)) throw new PocketBaseRequestError();
    const id = responseRecordId(row.id); const parsed = requested ?? new Key(collection ?? (() => { throw new PocketBaseRequestError(); })(), id);
    if (requested !== undefined && id !== recordId(requested)) throw new PocketBaseRequestError();
    const data = { ...row }; for (const name of RESERVED_FIELDS) delete data[name];
    return { key: parsed, exists: true, data: codecOrIdentity(codec).decode(data) };
  }

  private assertMutationRecord(row: unknown, requested: Key): void {
    if (!plainObject(row) || responseRecordId(row.id) !== recordId(requested)) throw new PocketBaseRequestError();
    const expectedCollection = collectionId(this.#collectionName(requested.collection));
    const name = row.collectionName;
    const id = row.collectionId;
    if (name !== undefined && typeof name !== "string") throw new PocketBaseRequestError();
    if (id !== undefined && typeof id !== "string") throw new PocketBaseRequestError();
    if ((name !== undefined || id !== undefined) && name !== expectedCollection && id !== expectedCollection) throw new PocketBaseRequestError();
  }
}
