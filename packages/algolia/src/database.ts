import {
  DOCUMENT_ID,
  Key,
  UnsupportedError,
  identityCodec,
  type Codec,
  type Database,
  type QueryFilter,
  type QueryPage,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
  type WriteSession,
} from "@dal-go/dalgo";

const DEFAULT_MAX_GET_MANY = 100;
const DEFAULT_MAX_QUERY_LIMIT = 1_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 15_000;

export type AlgoliaFetch = typeof globalThis.fetch;
export type AlgoliaHeaders = Readonly<Record<string, string>>;
export type AlgoliaHeaderProvider = AlgoliaHeaders | (() => AlgoliaHeaders | Promise<AlgoliaHeaders>);

/** A search key is browser-safe only when its Algolia restrictions expose exactly the intended data. */
export type AlgoliaAccess = "search" | "write";

export interface AlgoliaDatabaseOptions {
  /** Algolia application ID, used to derive its documented DSN API host. */
  readonly applicationId: string;
  /** An Algolia Search API key for browser reads, or a trusted write-capable key for mutations. */
  readonly apiKey: string;
  /** Defaults to search. Write-capable operation requires an explicit trusted-runtime declaration. */
  readonly access?: AlgoliaAccess;
  /** Maps each top-level DALgo collection to one Algolia index. */
  readonly indexes: Readonly<Record<string, string>>;
  /** Optional non-secret headers, re-evaluated per request. Do not provide API keys here. */
  readonly headers?: AlgoliaHeaderProvider;
  readonly fetch?: AlgoliaFetch;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxGetManyKeys?: number;
  readonly maxQueryLimit?: number;
}

export class AlgoliaHttpError extends Error {
  public readonly status: number;
  public constructor(status: number) {
    super(`Algolia request failed with HTTP ${String(status)}`);
    this.name = "AlgoliaHttpError";
    this.status = status;
  }
}

/** Redacts provider response bodies, URLs, API keys, and transport causes. */
export class AlgoliaRequestError extends Error {
  public constructor(message = "Algolia request could not be completed") {
    super(message);
    this.name = "AlgoliaRequestError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 16_777_216) throw new TypeError(`${name} must be a positive safe integer no greater than 16777216`);
  return result;
}

function plainJson(value: unknown, location: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return;
    throw new TypeError(`${location} numbers must be finite and not -0`);
  }
  if (typeof value !== "object") throw new TypeError(`${location} must be JSON-safe`);
  if (ancestors.has(value)) throw new TypeError(`${location} must not contain cycles`);
  if (Array.isArray(value)) {
    ancestors.add(value);
    value.forEach((item, index) => { plainJson(item, `${location}[${String(index)}]`, ancestors); });
    ancestors.delete(value);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError(`${location} must use plain JSON objects`);
  ancestors.add(value);
  Object.entries(value).forEach(([name, item]) => { plainJson(item, `${location}.${name}`, ancestors); });
  ancestors.delete(value);
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function safeName(value: string, label: string): string {
  if (value.length === 0 || value.length > 255 || hasControl(value)) throw new TypeError(`Algolia ${label} must be a non-empty, control-character-free string of at most 255 characters`);
  return value;
}

function validateHeaders(headers: AlgoliaHeaders): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string" || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) throw new TypeError("Algolia configured headers must be CR/LF-safe strings");
    if (name.toLowerCase() === "x-algolia-api-key" || name.toLowerCase() === "x-algolia-application-id") throw new TypeError("Algolia authentication must use applicationId and apiKey options");
  }
}

function documentId(key: Key): string {
  if (key.parent !== undefined) throw new UnsupportedError("Algolia nested collection keys");
  if (typeof key.id !== "string" || key.id.length === 0 || hasControl(key.id)) throw new TypeError("Algolia DALgo document IDs must be non-empty control-character-free strings");
  return key.id;
}

function encodedRecord<T>(data: T, codec: Codec<T>): Record<string, unknown> {
  const encoded = codec.encode(data);
  if (!isObject(encoded) || Object.getPrototypeOf(encoded) !== Object.prototype && Object.getPrototypeOf(encoded) !== null) throw new TypeError("Algolia DALgo documents must encode to plain JSON objects");
  if (Object.hasOwn(encoded, "objectID")) throw new TypeError("Algolia document data must not contain adapter-owned objectID");
  plainJson(encoded, "Algolia document");
  return encoded;
}

function responseObject(value: unknown, context: string): Record<string, unknown> {
  if (!isObject(value)) throw new TypeError(`malformed Algolia ${context} response`);
  return value;
}

function recordPayload(value: unknown, expectedId: string, context: string): Record<string, unknown> {
  const record = responseObject(value, context);
  if (record.objectID !== expectedId) throw new TypeError(`Algolia ${context} response does not match the requested objectID`);
  const data = { ...record };
  delete data.objectID;
  plainJson(data, `Algolia ${context} record`);
  return data;
}

function quoted(value: string): string {
  return `"${value.replaceAll(/([\\"])/gu, "\\$1")}"`;
}

function attribute(field: unknown): string {
  const value = String(field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new UnsupportedError("Algolia query attribute names");
  return value;
}

function filterValue(value: unknown, operator: string): string {
  if (typeof value === "string") return quoted(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return String(value);
  throw new UnsupportedError(`Algolia ${operator} filter values`);
}

function numericValue(value: unknown, operator: string): number {
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  throw new UnsupportedError(`Algolia ${operator} filters require finite numeric values`);
}

function filter<T>(item: QueryFilter<T>): string {
  const field = item.field === DOCUMENT_ID ? "objectID" : attribute(item.field);
  switch (item.operator) {
    case "==": return `${field}:${filterValue(item.value, item.operator)}`;
    case "!=": return `NOT ${field}:${filterValue(item.value, item.operator)}`;
    case "<": return `${field}<${String(numericValue(item.value, item.operator))}`;
    case "<=": return `${field}<=${String(numericValue(item.value, item.operator))}`;
    case ">": return `${field}>${String(numericValue(item.value, item.operator))}`;
    case ">=": return `${field}>=${String(numericValue(item.value, item.operator))}`;
    case "in": {
      if (!Array.isArray(item.value) || item.value.length === 0) throw new TypeError("Algolia in filters require a non-empty array");
      return `(${item.value.map((value) => `${field}:${filterValue(value, "in")}`).join(" OR ")})`;
    }
    case "not-in": {
      if (!Array.isArray(item.value) || item.value.length === 0) throw new TypeError("Algolia not-in filters require a non-empty array");
      return `NOT (${item.value.map((value) => `${field}:${filterValue(value, "not-in")}`).join(" OR ")})`;
    }
    default: throw new UnsupportedError(`Algolia ${item.operator} filters`);
  }
}

interface AlgoliaResponse { readonly status: number; readonly body: unknown; }

function cancelBody(body: ReadableStream<Uint8Array> | null): void { void body?.cancel().catch(() => undefined); }

async function responseText(response: Response, maximum: number): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
    cancelBody(response.body);
    throw new RangeError("Algolia response exceeds maxResponseBytes");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) {
        void reader.cancel().catch(() => undefined);
        throw new RangeError("Algolia response exceeds maxResponseBytes");
      }
      chunks.push(item.value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* a cancelled reader may retain its lock */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export class AlgoliaDatabase implements Database, WriteSession {
  readonly #searchHost: string;
  readonly #writeHost: string;
  readonly #applicationId: string;
  readonly #apiKey: string;
  readonly #access: AlgoliaAccess;
  readonly #indexes: Readonly<Record<string, string>>;
  readonly #headers: AlgoliaHeaderProvider | undefined;
  readonly #fetch: AlgoliaFetch;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxGetManyKeys: number;
  readonly #maxQueryLimit: number;

  public constructor(options: AlgoliaDatabaseOptions) {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(options.applicationId)) throw new TypeError("Algolia applicationId must contain only letters, numbers, underscores, or hyphens");
    if (typeof options.apiKey !== "string" || options.apiKey.length === 0 || /[\r\n]/u.test(options.apiKey)) throw new TypeError("Algolia apiKey must be a non-empty CR/LF-safe string");
    if (!isObject(options.indexes)) throw new TypeError("indexes must be an explicit DALgo collection mapping");
    for (const [collection, index] of Object.entries(options.indexes)) {
      safeName(collection, "collection name");
      if (typeof index !== "string") throw new TypeError("each Algolia index mapping must be a string");
      safeName(index, "index name");
    }
    this.#searchHost = `https://${options.applicationId}-dsn.algolia.net`;
    this.#writeHost = `https://${options.applicationId}.algolia.net`;
    this.#applicationId = options.applicationId;
    this.#apiKey = options.apiKey;
    this.#access = options.access ?? "search";
    this.#indexes = { ...options.indexes };
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.#maxRequestBytes = positive(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, "maxRequestBytes");
    this.#maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
    this.#maxGetManyKeys = positive(options.maxGetManyKeys, DEFAULT_MAX_GET_MANY, "maxGetManyKeys");
    this.#maxQueryLimit = positive(options.maxQueryLimit, DEFAULT_MAX_QUERY_LIMIT, "maxQueryLimit");
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const id = documentId(key);
    const response = await this.request("search", "GET", `/1/indexes/${encodeURIComponent(this.indexForKey(key))}/${encodeURIComponent(id)}`, undefined, [404]);
    if (response.status === 404) return { key, exists: false };
    return { key, exists: true, data: codecOrIdentity(codec).decode(recordPayload(response.body, id, "get")) };
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length === 0) return [];
    if (keys.length > this.#maxGetManyKeys) throw new RangeError(`Algolia getMany supports at most ${String(this.#maxGetManyKeys)} keys per request`);
    const requests = keys.map((key) => ({ indexName: this.indexForKey(key), objectID: documentId(key) }));
    const response = await this.request("search", "POST", "/1/indexes/*/objects", { requests });
    const body = responseObject(response.body, "getMany");
    if (!Array.isArray(body.results) || body.results.length !== keys.length) throw new TypeError("malformed Algolia getMany response");
    return body.results.map((item, index) => {
      const key = keys[index];
      if (key === undefined) throw new TypeError("malformed Algolia getMany result order");
      if (item === null) return { key, exists: false };
      return { key, exists: true, data: codecOrIdentity(codec).decode(recordPayload(item, documentId(key), "getMany")) };
    });
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    if (query.source.kind !== "collection") throw new UnsupportedError("Algolia collection-group queries");
    if (query.source.parent !== undefined) throw new UnsupportedError("Algolia nested collection queries");
    if (query.orders.length > 0) throw new UnsupportedError("Algolia ordering; configure a replica and map it as a separate collection");
    if (query.startAt !== undefined || query.startAfter !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("Algolia DALgo cursors");
    const limit = query.limit ?? this.#maxQueryLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#maxQueryLimit) throw new RangeError(`Algolia query limit must be a positive safe integer no greater than ${String(this.#maxQueryLimit)}`);
    const offset = query.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % limit !== 0) throw new UnsupportedError("Algolia query offset must be a non-negative multiple of limit");
    const response = await this.request("search", "POST", `/1/indexes/${encodeURIComponent(this.indexForCollection(query.source.name))}/query`, {
      query: "",
      hitsPerPage: limit,
      page: offset / limit,
      ...(query.filters.length === 0 ? {} : { filters: query.filters.map((item) => filter(item)).join(" AND ") }),
    });
    const body = responseObject(response.body, "query");
    if (!Array.isArray(body.hits) || body.hits.length > limit) throw new TypeError("malformed Algolia query response");
    return { records: body.hits.map((hit) => {
      const record = responseObject(hit, "query hit");
      if (typeof record.objectID !== "string" || record.objectID.length === 0) throw new TypeError("malformed Algolia query objectID");
      return { key: new Key(query.source.name, record.objectID), exists: true, data: codecOrIdentity(query.source.codec).decode(recordPayload(record, record.objectID, "query")) };
    }) };
  }

  public insert(...arguments_: [key: Key, data: unknown, codec?: Codec<unknown>]): Promise<void> { return this.rejectUnsupported("Algolia atomic insert", arguments_); }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    this.requireWrite();
    const id = documentId(key);
    const body = { ...encodedRecord(data, codecOrIdentity(codec)), objectID: id };
    const response = await this.request("write", "PUT", `/1/indexes/${encodeURIComponent(this.indexForKey(key))}/${encodeURIComponent(id)}`, body);
    this.validateTask(response.body, "set", id);
  }

  public update(...arguments_: [key: Key, data: UpdateData]): Promise<void> { return this.rejectUnsupported("Algolia atomic update", arguments_); }

  public async delete(key: Key): Promise<void> {
    this.requireWrite();
    documentId(key);
    const response = await this.request("write", "DELETE", `/1/indexes/${encodeURIComponent(this.indexForKey(key))}/${encodeURIComponent(documentId(key))}`);
    this.validateTask(response.body, "delete");
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    if (typeof callback !== "function") throw new TypeError("transaction callback is required");
    return Promise.reject(new UnsupportedError("Algolia transactions"));
  }

  private indexForKey(key: Key): string { documentId(key); return this.indexForCollection(key.collection); }
  private indexForCollection(collection: string): string {
    const index = this.#indexes[collection];
    if (index === undefined) throw new UnsupportedError(`Algolia index mapping for ${collection}`);
    return index;
  }
  private requireWrite(): void { if (this.#access !== "write") throw new UnsupportedError("Algolia writes require access: write and a trusted write-capable API key"); }
  private rejectUnsupported(message: string, arguments_: readonly unknown[]): Promise<never> {
    if (arguments_.length === 0) throw new TypeError("write arguments are required");
    return Promise.reject(new UnsupportedError(message));
  }
  private validateTask(value: unknown, context: string, expectedId?: string): void {
    const body = responseObject(value, context);
    if (typeof body.taskID !== "number" || !Number.isSafeInteger(body.taskID)) throw new TypeError(`malformed Algolia ${context} task response`);
    if (expectedId !== undefined && body.objectID !== undefined && body.objectID !== expectedId) throw new TypeError(`Algolia ${context} response does not match the requested objectID`);
  }
  private async request(target: "search" | "write", method: string, path: string, body?: unknown, acceptedStatuses: readonly number[] = []): Promise<AlgoliaResponse> {
    let serialized: string | undefined;
    if (body !== undefined) {
      plainJson(body, "Algolia request body");
      serialized = JSON.stringify(body);
      if (new TextEncoder().encode(serialized).byteLength > this.#maxRequestBytes) throw new RangeError("Algolia request body exceeds maxRequestBytes");
    }
    const controller = new AbortController();
    const timeoutError = new AlgoliaRequestError("Algolia request timed out");
    let rejectDeadline: ((reason?: unknown) => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timeout = setTimeout(() => { controller.abort(); rejectDeadline?.(timeoutError); }, this.#timeoutMs);
    const stage = async <T>(operation: () => T | Promise<T>): Promise<T> => {
      try { return await Promise.race([Promise.resolve().then(operation), deadline]); }
      catch (error) {
        if (error === timeoutError || error instanceof RangeError || error instanceof AlgoliaHttpError) throw error;
        throw new AlgoliaRequestError();
      }
    };
    try {
      const configured = await stage(() => typeof this.#headers === "function" ? this.#headers() : (this.#headers ?? {}));
      validateHeaders(configured);
      const host = target === "search" ? this.#searchHost : this.#writeHost;
      const response = await stage(() => this.#fetch(`${host}${path}`, {
        method, redirect: "error", signal: controller.signal,
        headers: { ...configured, "x-algolia-application-id": this.#applicationId, "x-algolia-api-key": this.#apiKey, accept: "application/json", ...(serialized === undefined ? {} : { "content-type": "application/json" }) },
        ...(serialized === undefined ? {} : { body: serialized }),
      }));
      const text = await stage(() => responseText(response, this.#maxResponseBytes));
      if (!response.ok && !acceptedStatuses.includes(response.status)) throw new AlgoliaHttpError(response.status);
      try { return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) }; }
      catch { throw new AlgoliaRequestError(); }
    } finally { clearTimeout(timeout); }
  }
}
