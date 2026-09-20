import {
  AlreadyExistsError,
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
  type WriteSession,
} from "@dal-go/dalgo";

const DEFAULT_MAX_GET_MANY = 100;
const DEFAULT_MAX_PARALLEL_READS = 8;
const DEFAULT_MAX_QUERY_LIMIT = 100;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 15_000;

export type PostgrestFetch = typeof globalThis.fetch;
export type PostgrestHeaders = Readonly<Record<string, string>>;
export type PostgrestHeaderProvider = PostgrestHeaders | (() => PostgrestHeaders | Promise<PostgrestHeaders>);

export interface PostgrestDatabaseOptions {
  /** PostgREST API root, normally the configured server origin or a proxy subpath. */
  readonly baseUrl: string;
  /** Name of the primary-key column shared by exposed adapter relations. Defaults to `id`. */
  readonly idColumn?: string;
  /** Maps a top-level DALgo collection name to an exposed PostgREST relation. */
  readonly relationName?: (collection: string) => string;
  /** Re-evaluated for every request; use it for refreshed Bearer or cookie headers. */
  readonly headers?: PostgrestHeaderProvider;
  readonly fetch?: PostgrestFetch;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxGetManyKeys?: number;
  readonly maxParallelReads?: number;
  readonly maxQueryLimit?: number;
}

/** Deliberately excludes PostgREST/PostgreSQL error bodies, which can contain row values. */
export class PostgrestHttpError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super(`PostgREST request failed with HTTP ${String(status)}`);
    this.name = "PostgrestHttpError";
    this.status = status;
  }
}

function positive(value: number | undefined, fallback: number, field: string, maximum = 16_777_216): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new TypeError(`${field} must be a safe integer from 1 to ${String(maximum)}`);
  }
  return result;
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("PostgREST JSON numbers must be finite and not -0");
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("PostgREST JSON must not contain cycles");
    seen.add(value);
    for (const item of value) validateJson(item, seen);
    seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) throw new TypeError("PostgREST JSON values must be plain objects, arrays, or primitives");
  if (seen.has(value)) throw new TypeError("PostgREST JSON must not contain cycles");
  seen.add(value);
  for (const item of Object.values(value)) validateJson(item, seen);
  seen.delete(value);
}

function encodedRecord<T>(value: T, codec: Codec<T>, idColumn: string): Record<string, unknown> {
  const encoded = codec.encode(value);
  if (!isPlainObject(encoded)) throw new TypeError("PostgREST DALgo records must encode to a non-null plain JSON object");
  if (Object.hasOwn(encoded, idColumn)) throw new TypeError(`PostgREST record data must not contain the adapter-owned ${idColumn} column`);
  validateJson(encoded);
  return encoded;
}

function validateHeaders(headers: PostgrestHeaders): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string" || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) {
      throw new TypeError("PostgREST configured headers must be CR/LF-safe strings");
    }
  }
}

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new UnsupportedError(`PostgREST ${label} names`);
  return value;
}

function scalar(value: unknown): string {
  if (typeof value === "string") return `"${value.replaceAll(/(["\\])/gu, "\\$1")}"`;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("PostgREST filter numbers must be finite and not -0");
    return String(value);
  }
  if (typeof value === "boolean") return String(value);
  throw new UnsupportedError("PostgREST filter value types");
}

function filterValue(value: unknown): string {
  if (Array.isArray(value)) return `{${value.map(scalar).join(",")}}`;
  return scalar(value);
}

function filterParameter<T>(filter: QueryFilter<T>, idColumn: string): readonly [string, string] {
  const field = filter.field === DOCUMENT_ID ? idColumn : identifier(String(filter.field), "query field");
  if (filter.value === undefined) throw new UnsupportedError("PostgREST undefined query filters");
  if (filter.value === null) {
    if (filter.operator === "==") return [field, "is.null"];
    if (filter.operator === "!=") return [field, "not.is.null"];
    throw new UnsupportedError(`PostgREST ${filter.operator} null query filters`);
  }
  switch (filter.operator) {
    case "==": return [field, `eq.${filterValue(filter.value)}`];
    case "!=": return [field, `neq.${filterValue(filter.value)}`];
    case "<": return [field, `lt.${scalar(filter.value)}`];
    case "<=": return [field, `lte.${scalar(filter.value)}`];
    case ">": return [field, `gt.${scalar(filter.value)}`];
    case ">=": return [field, `gte.${scalar(filter.value)}`];
    case "in":
      if (!Array.isArray(filter.value) || filter.value.length === 0) throw new TypeError("PostgREST in filters require a non-empty array");
      return [field, `in.(${filter.value.map(scalar).join(",")})`];
    case "not-in":
      if (!Array.isArray(filter.value) || filter.value.length === 0) throw new TypeError("PostgREST not-in filters require a non-empty array");
      return [field, `not.in.(${filter.value.map(scalar).join(",")})`];
    case "array-contains":
      if (!Array.isArray(filter.value)) throw new TypeError("PostgREST array-contains filters require an array");
      return [field, `cs.${filterValue(filter.value)}`];
    case "array-contains-any":
      if (!Array.isArray(filter.value) || filter.value.length === 0) throw new TypeError("PostgREST array-contains-any filters require a non-empty array");
      return [field, `ov.${filterValue(filter.value)}`];
    default: throw new UnsupportedError(`PostgREST ${String(filter.operator)} query filters`);
  }
}

async function readJson(response: Response, maximum: number): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximum)) {
    await response.body?.cancel();
    throw new RangeError("PostgREST response exceeds maxResponseBytes");
  }
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new RangeError("PostgREST response exceeds maxResponseBytes");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength === 0) return undefined;
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export class PostgrestDatabase implements Database, WriteSession {
  readonly #baseUrl: string;
  readonly #idColumn: string;
  readonly #relationName: (collection: string) => string;
  readonly #headers: PostgrestHeaderProvider | undefined;
  readonly #fetch: PostgrestFetch;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxGetManyKeys: number;
  readonly #maxParallelReads: number;
  readonly #maxQueryLimit: number;

  public constructor(options: PostgrestDatabaseOptions) {
    const url = new URL(options.baseUrl.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new TypeError("baseUrl must use HTTPS, except for loopback development");
    if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) throw new TypeError("baseUrl must not contain credentials, a query, or a fragment");
    this.#baseUrl = `${url.toString().replace(/\/+$/u, "")}/`;
    this.#idColumn = identifier(options.idColumn ?? "id", "id column");
    this.#relationName = options.relationName ?? ((collection) => collection);
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
    const url = this.keyUrl(key);
    url.searchParams.set("select", "*");
    url.searchParams.set("limit", "1");
    const response = await this.request(url, "GET", { accept: "application/json" });
    const rows = await this.rows(response);
    const row = rows[0];
    return row === undefined ? { key, exists: false } : this.record(row, key, codec);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#maxGetManyKeys) throw new UnsupportedError(`PostgREST getMany above ${String(this.#maxGetManyKeys)} keys`);
    const records: RecordSnapshot<T>[] = new Array(keys.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        const key = keys[index];
        if (key === undefined) return;
        records[index] = await this.get(key, codec);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#maxParallelReads, keys.length) }, worker));
    return records;
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const payload = this.payload(key, data, codec);
    try {
      const response = await this.request(this.relationUrl(key), "POST", this.writeHeaders("return=minimal"), payload);
      await response.body?.cancel();
    } catch (error) {
      if (error instanceof PostgrestHttpError && error.status === 409) throw new AlreadyExistsError(key, { cause: error });
      throw error;
    }
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const payload = this.payload(key, data, codec);
    const response = await this.request(this.relationUrl(key), "POST", this.writeHeaders("resolution=merge-duplicates, return=minimal"), payload);
    await response.body?.cancel();
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    const payload = encodedRecord(data, identityCodec as Codec<UpdateData>, this.#idColumn);
    const response = await this.request(this.keyUrl(key), "PATCH", this.writeHeaders("return=representation"), payload);
    if ((await this.rows(response)).length === 0) throw new NotFoundError(key);
  }

  public async delete(key: Key): Promise<void> {
    const response = await this.request(this.keyUrl(key), "DELETE", this.writeHeaders("return=minimal"));
    await response.body?.cancel();
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) {
      throw new UnsupportedError("PostgREST collection-group or nested-collection queries");
    }
    if (query.startAt !== undefined || query.startAfter !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
      throw new UnsupportedError("PostgREST DALgo query cursors");
    }
    const url = this.relationUrlForCollection(query.source.name);
    url.searchParams.set("select", "*");
    for (const filter of query.filters) {
      const [field, value] = filterParameter(filter, this.#idColumn);
      url.searchParams.append(field, value);
    }
    if (query.orders.length > 0) {
      url.searchParams.set("order", query.orders.map((order) => {
        if (order.direction !== "asc" && order.direction !== "desc") throw new UnsupportedError("PostgREST query order directions");
        return `${order.field === DOCUMENT_ID ? this.#idColumn : identifier(String(order.field), "order field")}.${order.direction}`;
      }).join(","));
    }
    const limit = query.limit ?? this.#maxQueryLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#maxQueryLimit) throw new UnsupportedError(`PostgREST query limit above ${String(this.#maxQueryLimit)}`);
    url.searchParams.set("limit", String(limit));
    if (query.offset !== undefined) {
      if (!Number.isSafeInteger(query.offset) || query.offset < 0) throw new TypeError("PostgREST query offset must be a non-negative safe integer");
      url.searchParams.set("offset", String(query.offset));
    }
    const response = await this.request(url, "GET", { accept: "application/json" });
    const rows = await this.rows(response);
    return { records: rows.map((row) => this.record(row, undefined, query.source.codec, query.source.name)) };
  }

  public async runReadwriteTransaction<Result>(
    callback: (transaction: import("@dal-go/dalgo").ReadwriteTransaction) => Promise<Result>,
  ): Promise<Result> {
    void callback;
    throw new UnsupportedError("PostgREST callback transactions");
  }

  private relationUrl(key: Key): URL {
    if (key.parent !== undefined) throw new UnsupportedError("PostgREST nested DALgo keys");
    return this.relationUrlForCollection(key.collection);
  }

  private relationUrlForCollection(collection: string): URL {
    return new URL(encodeURIComponent(identifier(this.#relationName(collection), "relation")), this.#baseUrl);
  }

  private keyUrl(key: Key): URL {
    const url = this.relationUrl(key);
    url.searchParams.set(this.#idColumn, `eq.${scalar(key.id)}`);
    return url;
  }

  private payload<T>(key: Key, data: T, codec?: Codec<T>): Record<string, unknown> {
    return { [this.#idColumn]: key.id, ...encodedRecord(data, codecOrIdentity(codec), this.#idColumn) };
  }

  private writeHeaders(prefer: string): Record<string, string> {
    return { accept: "application/json", "content-type": "application/json", prefer };
  }

  private async request(url: URL, method: string, requiredHeaders: Record<string, string>, body?: unknown): Promise<Response> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined && new TextEncoder().encode(text).byteLength > this.#maxRequestBytes) throw new RangeError("PostgREST request exceeds maxRequestBytes");
    const provided = typeof this.#headers === "function" ? await this.#headers() : this.#headers;
    if (provided !== undefined) validateHeaders(provided);
    const headers = new Headers(provided);
    for (const [name, value] of Object.entries(requiredHeaders)) headers.set(name, value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, { method, headers, ...(text === undefined ? {} : { body: text }), signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PostgrestHttpError(response.status);
    }
    return response;
  }

  private async rows(response: Response): Promise<readonly Record<string, unknown>[]> {
    const body = await readJson(response, this.#maxResponseBytes);
    if (!Array.isArray(body) || !body.every(isPlainObject)) throw new TypeError("PostgREST response must be a JSON array of row objects");
    return body;
  }

  private record<T>(
    row: Record<string, unknown>,
    requestedKey: Key | undefined,
    codec?: Codec<T>,
    collection?: string,
  ): ExistingRecord<T> {
    const id = row[this.#idColumn];
    if ((typeof id !== "string" && typeof id !== "number") || (typeof id === "number" && (!Number.isFinite(id) || Object.is(id, -0)))) {
      throw new TypeError(`PostgREST response row is missing a valid ${this.#idColumn} column`);
    }
    let key: Key;
    if (requestedKey !== undefined) {
      key = requestedKey;
    } else {
      if (collection === undefined) throw new Error("PostgREST query record collection is required");
      key = new Key(collection, id);
    }
    if (requestedKey !== undefined && !Object.is(requestedKey.id, id)) throw new TypeError("PostgREST response row does not match requested DALgo key");
    const data = { ...row };
    delete data[this.#idColumn];
    return { key, exists: true, data: codecOrIdentity(codec).decode(data) };
  }

}
