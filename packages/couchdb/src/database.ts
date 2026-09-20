import {
  AlreadyExistsError,
  DOCUMENT_ID,
  Key,
  UnsupportedError,
  identityCodec,
  type Codec,
  type Database,
  type ExistingRecord,
  type QueryFilter,
  type QueryPage,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
  type WriteSession,
} from "@dal-go/dalgo";

const DEFAULT_MAX_GET_MANY = 100;
const DEFAULT_MAX_PARALLEL_READS = 8;
const DEFAULT_MAX_QUERY_LIMIT = 100;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 15_000;

export type CouchDbFetch = typeof globalThis.fetch;
export type CouchDbHeaders = Readonly<Record<string, string>>;
export type CouchDbHeaderProvider = CouchDbHeaders | (() => CouchDbHeaders | Promise<CouchDbHeaders>);

export interface CouchDbDatabaseOptions {
  /** Existing CouchDB database, as an HTTPS URL or loopback HTTP URL. */
  readonly databaseUrl: string;
  /** Re-evaluated for every request, for safely refreshed bearer/cookie headers. */
  readonly headers?: CouchDbHeaderProvider;
  readonly fetch?: CouchDbFetch;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxGetManyKeys?: number;
  readonly maxParallelReads?: number;
  readonly maxQueryLimit?: number;
}

interface CouchDocument {
  readonly _id: string;
  readonly _rev: string;
  readonly __dalgo_collection: string;
  readonly __dalgo_id: string | number;
  readonly data: unknown;
}

interface MangoResponse { readonly docs: readonly CouchDocument[]; readonly bookmark?: string; }
interface CouchCursor { readonly adapter: "@dal-go/dalgo2couchdb"; readonly version: 1; readonly databaseUrl: string; readonly bookmark: string; }

export class CouchDbHttpError extends Error {
  public readonly status: number;
  public constructor(status: number) {
    super(`CouchDB request failed with HTTP ${String(status)}`);
    this.name = "CouchDbHttpError";
    this.status = status;
  }
}

/** A 409 returned while applying an explicit document revision. */
export class CouchDbConflictError extends Error {
  public readonly key: Key;
  public constructor(key: Key) {
    super(`CouchDB MVCC conflict for record: ${key.path}`);
    this.name = "CouchDbConflictError";
    this.key = key;
  }
}

function positive(value: number | undefined, fallback: number, field: string, maximum = 16_777_216): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`${field} must be a safe integer from 1 to ${String(maximum)}`);
  return result;
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("CouchDB JSON numbers must be finite and not -0");
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("CouchDB JSON must not contain cycles");
    seen.add(value); for (const entry of value) assertJson(entry, seen); seen.delete(value); return;
  }
  if (!isPlainObject(value)) throw new TypeError("CouchDB JSON values must be plain objects, arrays, or primitives");
  if (seen.has(value)) throw new TypeError("CouchDB JSON must not contain cycles");
  seen.add(value); for (const entry of Object.values(value)) assertJson(entry, seen); seen.delete(value);
}

function validateData(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError("CouchDB DALgo records must encode to a non-null plain object");
  assertJson(value);
}

function keyId(value: unknown): asserts value is string | number {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0))) {
    throw new TypeError("CouchDB DALgo key IDs must be strings or safe integers, excluding -0");
  }
}

function storageId(key: Key): string {
  keyId(key.id);
  const json = JSON.stringify([key.collectionPath, key.id]);
  const encoded = new TextEncoder().encode(json);
  let binary = ""; for (const byte of encoded) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=/gu, "");
}

function validateHeaders(headers: CouchDbHeaders): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string" || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) throw new TypeError("CouchDB configured headers must be CR/LF-safe strings");
  }
}

async function readResponse(response: Response, maximum: number, signal: AbortSignal): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
    await response.body?.cancel(); throw new RangeError("CouchDB response exceeds maxResponseBytes");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  let rejectAbort: ((error: Error) => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => { rejectAbort = reject as (error: Error) => void; });
  const cancel = () => { rejectAbort?.(new Error("CouchDB response timed out")); void reader.cancel(); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), abort]);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) { await reader.cancel(); throw new RangeError("CouchDB response exceeds maxResponseBytes"); }
      chunks.push(next.value);
    }
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  const joined = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

function couchDocument(value: unknown, key: Key): CouchDocument {
  if (!isObject(value) || typeof value._id !== "string" || typeof value._rev !== "string" || typeof value.__dalgo_collection !== "string" || (typeof value.__dalgo_id !== "string" && typeof value.__dalgo_id !== "number") || !Object.hasOwn(value, "data")) {
    throw new TypeError("malformed CouchDB DALgo document");
  }
  if (value._id !== storageId(key) || value.__dalgo_collection !== key.collectionPath || value.__dalgo_id !== key.id) throw new TypeError("CouchDB document does not match requested DALgo key");
  return value as unknown as CouchDocument;
}

function metadata(document: CouchDocument): Readonly<Record<string, unknown>> { return { revision: document._rev }; }
function selectorField(field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(field)) throw new UnsupportedError("CouchDB non-simple query field paths");
  return `data.${field}`;
}
function selectorFilter<T>(filter: QueryFilter<T>): Record<string, unknown> {
  const field = filter.field === DOCUMENT_ID ? "__dalgo_id" : selectorField(String(filter.field));
  if (filter.value === null || filter.value === undefined) throw new UnsupportedError("CouchDB null or undefined query filters");
  assertJson(filter.value);
  if ((filter.operator === "in" || filter.operator === "not-in" || filter.operator === "array-contains-any") && !Array.isArray(filter.value)) throw new TypeError(`${filter.operator} requires an array`);
  switch (filter.operator) {
    case "==": return { [field]: { $eq: filter.value } };
    case "!=": return { [field]: { $ne: filter.value } };
    case "<": return { [field]: { $lt: filter.value } };
    case "<=": return { [field]: { $lte: filter.value } };
    case ">": return { [field]: { $gt: filter.value } };
    case ">=": return { [field]: { $gte: filter.value } };
    case "in": return { [field]: { $in: filter.value } };
    case "not-in": return { [field]: { $nin: filter.value } };
    default: throw new UnsupportedError(`CouchDB ${filter.operator} filters`);
  }
}

export class CouchDbDatabase implements Database, WriteSession {
  readonly #databaseUrl: string;
  readonly #headers: CouchDbHeaderProvider | undefined;
  readonly #fetch: CouchDbFetch;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxGetManyKeys: number;
  readonly #maxParallelReads: number;
  readonly #maxQueryLimit: number;

  public constructor(options: CouchDbDatabaseOptions) {
    const url = new URL(options.databaseUrl.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new TypeError("databaseUrl must use HTTPS, except for loopback development");
    if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) throw new TypeError("databaseUrl must not contain credentials, a query, or a fragment");
    if (url.pathname === "/" || /\/_/u.test(url.pathname)) throw new TypeError("databaseUrl must name one existing application database, not a CouchDB management endpoint");
    this.#databaseUrl = url.toString().replace(/\/+$/u, "");
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 120_000);
    this.#maxRequestBytes = positive(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, "maxRequestBytes");
    this.#maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
    this.#maxGetManyKeys = positive(options.maxGetManyKeys, DEFAULT_MAX_GET_MANY, "maxGetManyKeys", 1_000);
    this.#maxParallelReads = positive(options.maxParallelReads, Math.min(DEFAULT_MAX_PARALLEL_READS, this.#maxGetManyKeys), "maxParallelReads", this.#maxGetManyKeys);
    this.#maxQueryLimit = positive(options.maxQueryLimit, DEFAULT_MAX_QUERY_LIMIT, "maxQueryLimit", 1_000);
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const raw = await this.rawGet(key);
    if (raw === undefined) return { key, exists: false };
    return { key, exists: true, data: codecOrIdentity(codec).decode(raw.data), metadata: metadata(raw) };
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#maxGetManyKeys) throw new UnsupportedError(`CouchDB getMany above maxGetManyKeys (${String(this.#maxGetManyKeys)})`);
    const results: RecordSnapshot<T>[] = new Array(keys.length); let next = 0;
    const worker = async (): Promise<void> => { for (;;) { const index = next++; if (index >= keys.length) return; const item = keys[index]; if (item === undefined) return; results[index] = await this.get(item, codec); } };
    await Promise.all(Array.from({ length: Math.min(this.#maxParallelReads, keys.length) }, () => worker()));
    return results;
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const body = this.document(key, codecOrIdentity(codec).encode(data));
    const response = await this.request("PUT", `/${encodeURIComponent(storageId(key))}`, body, [409]);
    if (response.status === 409) throw new AlreadyExistsError(key, { cause: new CouchDbHttpError(409) });
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const existing = await this.rawGet(key);
    const body = { ...this.document(key, codecOrIdentity(codec).encode(data)), ...(existing === undefined ? {} : { _rev: existing._rev }) };
    const response = await this.request("PUT", `/${encodeURIComponent(storageId(key))}`, body, [409]);
    if (response.status === 409) throw new CouchDbConflictError(key);
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    void key; void data;
    throw new UnsupportedError("CouchDB DALgo partial update");
  }

  public async delete(key: Key): Promise<void> {
    const existing = await this.rawGet(key);
    if (existing === undefined) return;
    const response = await this.request("DELETE", `/${encodeURIComponent(storageId(key))}`, undefined, [409], { "if-match": existing._rev });
    if (response.status === 409) throw new CouchDbConflictError(key);
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("CouchDB collection-group or nested collection queries");
    if (query.orders.length > 0 || query.offset !== undefined || query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("CouchDB ordered, offset, or inclusive/end cursor queries");
    if (query.limit !== undefined && query.limit > this.#maxQueryLimit) throw new UnsupportedError(`CouchDB query limit above maxQueryLimit (${String(this.#maxQueryLimit)})`);
    let bookmark: string | undefined;
    if (query.startAfter !== undefined) {
      const cursor = query.startAfter.values[0];
      if (!isObject(cursor) || cursor.adapter !== "@dal-go/dalgo2couchdb" || cursor.version !== 1 || cursor.databaseUrl !== this.#databaseUrl || typeof cursor.bookmark !== "string" || query.startAfter.values.length !== 1) throw new TypeError("CouchDB query cursor must be returned by this adapter");
      bookmark = cursor.bookmark;
    }
    const limit = query.limit ?? this.#maxQueryLimit;
    const body = { selector: { $and: [{ __dalgo_collection: { $eq: query.source.name } }, ...query.filters.map((filter) => selectorFilter(filter))] }, limit, ...(bookmark === undefined ? {} : { bookmark }) };
    const response = await this.request("POST", "/_find", body);
    if (!isObject(response.body) || !Array.isArray(response.body.docs) || (response.body.bookmark !== undefined && typeof response.body.bookmark !== "string")) throw new TypeError("malformed CouchDB Mango response");
    const mango = response.body as unknown as MangoResponse;
    const records = mango.docs.map((document): ExistingRecord<T> => {
      const key = new Key(query.source.name, document.__dalgo_id);
      const valid = couchDocument(document, key);
      return { key, exists: true, data: codecOrIdentity(query.source.codec).decode(valid.data), metadata: metadata(valid) };
    });
    const nextCursor = records.length === limit && mango.bookmark !== undefined ? { values: [{ adapter: "@dal-go/dalgo2couchdb", version: 1, databaseUrl: this.#databaseUrl, bookmark: mango.bookmark } satisfies CouchCursor] } : undefined;
    return { records, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    if (typeof callback !== "function") throw new TypeError("transaction callback is required");
    return Promise.reject(new UnsupportedError("CouchDB callback transactions or bulk ACID writes"));
  }

  private document(key: Key, data: unknown): Omit<CouchDocument, "_rev"> {
    keyId(key.id); validateData(data);
    return { _id: storageId(key), __dalgo_collection: key.collectionPath, __dalgo_id: key.id, data };
  }

  private async rawGet(key: Key): Promise<CouchDocument | undefined> {
    const response = await this.request("GET", `/${encodeURIComponent(storageId(key))}`, undefined, [404]);
    return response.status === 404 ? undefined : couchDocument(response.body, key);
  }

  private async request(method: string, path: string, body?: unknown, accepted: readonly number[] = [], extraHeaders: CouchDbHeaders = {}): Promise<{ readonly status: number; readonly body: unknown }> {
    const supplied = typeof this.#headers === "function" ? await this.#headers() : (this.#headers ?? {});
    validateHeaders(supplied); validateHeaders(extraHeaders);
    let serialized: string | undefined;
    if (body !== undefined) { assertJson(body); serialized = JSON.stringify(body); if (byteLength(serialized) > this.#maxRequestBytes) throw new RangeError("CouchDB request exceeds maxRequestBytes"); }
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#databaseUrl}${path}`, { method, redirect: "error", signal: controller.signal, headers: { ...supplied, ...extraHeaders, accept: "application/json", ...(serialized === undefined ? {} : { "content-type": "application/json" }) }, ...(serialized === undefined ? {} : { body: serialized }) });
      const text = await readResponse(response, this.#maxResponseBytes, controller.signal);
      if (!response.ok && !accepted.includes(response.status)) throw new CouchDbHttpError(response.status);
      if (text.length === 0) return { status: response.status, body: undefined };
      try { return { status: response.status, body: JSON.parse(text) }; } catch { throw new TypeError("CouchDB returned invalid JSON"); }
    } finally { clearTimeout(timeout); }
  }
}
