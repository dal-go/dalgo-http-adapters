import {
  Key,
  UnsupportedError,
  identityCodec,
  type Codec,
  type Database,
  type ExistingRecord,
  type QueryPage,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
  type WriteSession,
} from "@dal-go/dalgo";
import { compilePineconeVectorQuery, validatePineconeId } from "./query.js";

const DEFAULT_MAX_GET_MANY = 100;
const DEFAULT_MAX_QUERY_LIMIT = 1_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 30_000;
const PINECONE_API_VERSION = "2026-07";

export type PineconeFetch = typeof globalThis.fetch;
export type PineconeHeaders = Readonly<Record<string, string>>;
export type PineconeVector = readonly number[];

/** Maps each DALgo collection to an isolated namespace and dense-vector producer. */
export interface PineconeCollectionMapping {
  readonly namespace: string;
  readonly vectorForWrite: (metadata: Readonly<Record<string, unknown>>, key: Key) => PineconeVector;
}

export interface PineconeDatabaseOptions {
  /** The unique host for an index, for example https://index-abc.svc.us-east-1-aws.pinecone.io. */
  readonly baseUrl: string;
  /** Every usable DALgo collection must map to an isolated Pinecone namespace. */
  readonly collections: Readonly<Record<string, PineconeCollectionMapping>>;
  /** Re-evaluated per request; inject Api-Key only in a trusted environment. */
  readonly headers?: PineconeHeaders | (() => PineconeHeaders | Promise<PineconeHeaders>);
  readonly fetch?: PineconeFetch;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxGetManyKeys?: number;
  readonly maxQueryLimit?: number;
}

interface PineconeVectorRecord { readonly id: string; readonly metadata?: Readonly<Record<string, unknown>>; }
interface PineconeResponse { readonly status: number; readonly body: unknown; }

export class PineconeHttpError extends Error {
  public readonly status: number;
  public constructor(status: number) { super(`Pinecone request failed with HTTP ${String(status)}`); this.name = "PineconeHttpError"; this.status = status; }
}

/** Deliberately redacts header, transport, parse, and response-body details. */
export class PineconeRequestError extends Error {
  public constructor(message = "Pinecone request could not be completed") { super(message); this.name = "PineconeRequestError"; }
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function positive(value: number | undefined, fallback: number, label: string, zero = false): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (zero ? 0 : 1)) throw new TypeError(`${label} must be a ${zero ? "non-negative" : "positive"} safe integer`);
  return result;
}

function validateHeaders(headers: PineconeHeaders): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string" || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) throw new TypeError("Pinecone configured headers must be CR/LF-safe strings");
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function assertJson(value: unknown, label: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`${label} must not contain non-finite or -0 numbers`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${label} must be JSON-safe`);
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain a cycle`);
  if (Array.isArray(value)) {
    ancestors.add(value);
    value.forEach((item, index) => { assertJson(item, `${label}[${String(index)}]`, ancestors); });
    ancestors.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must contain only plain JSON objects and arrays`);
  ancestors.add(value);
  Object.entries(value).forEach(([key, item]) => { assertJson(item, `${label}.${key}`, ancestors); });
  ancestors.delete(value);
}

function encodedMetadata<T>(data: T, codec: Codec<T>): Readonly<Record<string, unknown>> {
  const encoded = codec.encode(data);
  if (!isObject(encoded)) throw new TypeError("Pinecone DALgo documents must encode to a non-null JSON object metadata payload");
  assertJson(encoded, "Pinecone metadata");
  return encoded;
}

function vectorForRequest(vector: PineconeVector): readonly number[] {
  if (vector.length === 0 || !vector.every((item) => typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0))) {
    throw new TypeError("Pinecone query vectors must be non-empty arrays of finite numbers");
  }
  return vector;
}

function namespace(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (new TextEncoder().encode(value).byteLength > 512 || hasControlCharacter(value)) throw new TypeError("Pinecone namespace must be at most 512 bytes with no control characters");
  return value;
}

function pineconeRecord(value: unknown, context: string): PineconeVectorRecord {
  if (!isObject(value) || typeof value.id !== "string") throw new TypeError(`malformed Pinecone ${context} vector`);
  validatePineconeId(value.id);
  if (!isObject(value.metadata)) throw new UnsupportedError(`Pinecone ${context} vector without JSON-object metadata`);
  assertJson(value.metadata, `Pinecone ${context} metadata`);
  return value as unknown as PineconeVectorRecord;
}

function cancel(body: ReadableStream<Uint8Array> | null): void { void body?.cancel().catch(() => undefined); }

export class PineconeDatabase implements Database, WriteSession {
  readonly #baseUrl: string;
  readonly #collections: Readonly<Record<string, PineconeCollectionMapping>>;
  readonly #headers: PineconeDatabaseOptions["headers"];
  readonly #fetch: PineconeFetch;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxGetManyKeys: number;
  readonly #maxQueryLimit: number;

  public constructor(options: PineconeDatabaseOptions) {
    const url = new URL(options.baseUrl.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new TypeError("baseUrl must use HTTPS, except for loopback development");
    if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) throw new TypeError("baseUrl must not contain credentials, a query, or a fragment");
    if (!isObject(options.collections)) throw new TypeError("collections must be an explicit Pinecone collection mapping");
    const namespaces = new Set<string>();
    for (const [collection, mapping] of Object.entries(options.collections)) {
      if (collection.length === 0 || hasControlCharacter(collection) || !isObject(mapping) || typeof mapping.namespace !== "string" || typeof mapping.vectorForWrite !== "function") {
        throw new TypeError("each Pinecone collection mapping requires a control-character-free namespace and vectorForWrite");
      }
      const mappedNamespace = namespace(mapping.namespace);
      if (mappedNamespace === undefined || namespaces.has(mappedNamespace)) throw new TypeError("each Pinecone collection must use a distinct namespace");
      namespaces.add(mappedNamespace);
    }
    this.#baseUrl = url.toString().replace(/\/+$/u, "");
    this.#collections = Object.fromEntries(Object.entries(options.collections).map(([collection, mapping]) => [collection, { ...mapping }]));
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.#maxRequestBytes = positive(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, "maxRequestBytes");
    this.#maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
    this.#maxGetManyKeys = positive(options.maxGetManyKeys, DEFAULT_MAX_GET_MANY, "maxGetManyKeys");
    this.#maxQueryLimit = positive(options.maxQueryLimit, DEFAULT_MAX_QUERY_LIMIT, "maxQueryLimit");
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const id = this.keyId(key);
    const result = await this.fetchVectors([id], this.mappingForKey(key));
    const record = result.get(id);
    return record === undefined ? { key, exists: false } : this.snapshot(key, record, codec);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length === 0) return [];
    if (keys.length > this.#maxGetManyKeys) throw new RangeError(`Pinecone getMany accepts at most ${String(this.#maxGetManyKeys)} keys`);
    const first = keys[0];
    if (first === undefined) throw new TypeError("Pinecone key is required");
    const mapping = this.mappingForKey(first);
    const keyIds = keys.map((key) => {
      if (this.mappingForKey(key).namespace !== mapping.namespace) throw new UnsupportedError("Pinecone getMany across collection namespaces");
      return this.keyId(key);
    });
    const distinct = [...new Set(keyIds)];
    const records = await this.fetchVectors(distinct, mapping);
    return keys.map((key, index) => {
      const id = keyIds[index];
      if (id === undefined) throw new TypeError("Pinecone key is required");
      const record = records.get(id);
      return record === undefined ? { key, exists: false } : this.snapshot(key, record, codec);
    });
  }

  /** DALgo StructuredQuery has no query vector; use vectorSearch to make similarity semantics explicit. */
  public query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    if (query.source.kind === "collection-group") return Promise.reject(new UnsupportedError("Pinecone collection-group queries"));
    return Promise.reject(new UnsupportedError("Pinecone generic DALgo queries require a vector; use vectorSearch"));
  }

  public async vectorSearch<T>(query: StructuredQuery<T>, vector: PineconeVector): Promise<QueryPage<T>> {
    const compiled = compilePineconeVectorQuery(query, this.#maxQueryLimit);
    const mapping = this.mappingForCollection(query.source.name);
    const body = { vector: vectorForRequest(vector), topK: compiled.topK, includeValues: false, includeMetadata: true, namespace: mapping.namespace, ...(compiled.filter === undefined ? {} : { filter: compiled.filter }) };
    const response = await this.request("POST", "/query", body);
    if (!isObject(response.body) || !Array.isArray(response.body.matches)) throw new TypeError("malformed Pinecone query response");
    if (response.body.matches.length > compiled.topK) throw new TypeError("Pinecone query response contains more matches than requested");
    return { records: response.body.matches.map((match) => {
      const record = pineconeRecord(match, "query");
      return this.snapshot(new Key(query.source.name, record.id), record, query.source.codec, match);
    }) };
  }

  public insert<T>(...arguments_: [key: Key, data: T, codec?: Codec<T>]): Promise<void> { return this.unsupported("Pinecone atomic insert", arguments_); }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const id = this.keyId(key);
    const metadata = encodedMetadata(data, codecOrIdentity(codec));
    const mapping = this.mappingForKey(key);
    const values = vectorForRequest(mapping.vectorForWrite(metadata, key));
    const response = await this.request("POST", "/vectors/upsert", { vectors: [{ id, values, metadata }], namespace: mapping.namespace });
    const upsertedCount = isObject(response.body) ? response.body.upsertedCount : undefined;
    if (!isObject(response.body) || typeof upsertedCount !== "number" || !Number.isSafeInteger(upsertedCount) || upsertedCount !== 1) {
      throw new TypeError("malformed Pinecone upsert response");
    }
  }

  public update(...arguments_: [key: Key, data: UpdateData]): Promise<void> { return this.unsupported("Pinecone atomic update", arguments_); }

  public async delete(key: Key): Promise<void> {
    await this.request("POST", "/vectors/delete", { ids: [this.keyId(key)], namespace: this.mappingForKey(key).namespace });
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    if (typeof callback !== "function") throw new TypeError("transaction callback is required");
    return Promise.reject(new UnsupportedError("Pinecone multi-document transactions"));
  }

  private keyId(key: Key): string {
    if (key.parent !== undefined) throw new UnsupportedError("Pinecone nested collection keys");
    validatePineconeId(key.id);
    return key.id;
  }

  private mappingForKey(key: Key): PineconeCollectionMapping {
    if (key.parent !== undefined) throw new UnsupportedError("Pinecone nested collection keys");
    return this.mappingForCollection(key.collection);
  }

  private mappingForCollection(collection: string): PineconeCollectionMapping {
    const mapping = this.#collections[collection];
    if (mapping === undefined) throw new UnsupportedError(`Pinecone collection mapping for ${collection}`);
    return mapping;
  }

  private snapshot<T>(key: Key, record: PineconeVectorRecord, codec?: Codec<T>, original?: unknown): ExistingRecord<T> {
    const score = isObject(original) ? original.score : undefined;
    if (score !== undefined && (typeof score !== "number" || !Number.isFinite(score))) throw new TypeError("malformed Pinecone query score");
    return { key, exists: true, data: codecOrIdentity(codec).decode(record.metadata ?? {}), ...(score === undefined ? {} : { metadata: { score } }) };
  }

  private async fetchVectors(ids: readonly string[], mapping: PineconeCollectionMapping): Promise<ReadonlyMap<string, PineconeVectorRecord>> {
    const query = new URLSearchParams();
    ids.forEach((id) => { query.append("ids", id); });
    query.set("namespace", mapping.namespace);
    const response = await this.request("GET", `/vectors/fetch?${query.toString()}`);
    if (!isObject(response.body) || !isObject(response.body.vectors)) throw new TypeError("malformed Pinecone fetch response");
    const records = new Map<string, PineconeVectorRecord>();
    for (const [id, item] of Object.entries(response.body.vectors)) {
      const record = pineconeRecord(item, "fetch");
      if (record.id !== id || !ids.includes(id)) throw new TypeError("Pinecone fetch response contains an unexpected vector");
      records.set(id, record);
    }
    return records;
  }

  private unsupported(message: string, arguments_: readonly unknown[]): Promise<never> {
    if (arguments_.length === 0) throw new TypeError("Pinecone write arguments are required");
    return Promise.reject(new UnsupportedError(message));
  }

  private async request(method: string, path: string, body?: unknown): Promise<PineconeResponse> {
    let serialized: string | undefined;
    if (body !== undefined) {
      assertJson(body, "Pinecone request body"); serialized = JSON.stringify(body);
      if (new TextEncoder().encode(serialized).byteLength > this.#maxRequestBytes) throw new RangeError(`Pinecone request body exceeds maxRequestBytes (${String(this.#maxRequestBytes)})`);
    }
    const controller = new AbortController();
    const timeout = new PineconeRequestError("Pinecone request timed out");
    let rejectDeadline: ((reason?: unknown) => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => { controller.abort(timeout); rejectDeadline?.(timeout); }, this.#timeoutMs);
    const stage = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      try { return await Promise.race([Promise.resolve().then(operation), deadline]); }
      catch (error) { if (error === timeout || error instanceof RangeError) throw error; throw new PineconeRequestError(); }
    };
    try {
      const configured = await stage(() => typeof this.#headers === "function" ? this.#headers() : (this.#headers ?? {}));
      validateHeaders(configured);
      const response = await stage(() => this.#fetch(`${this.#baseUrl}${path}`, { method, redirect: "error", signal: controller.signal, headers: { ...configured, "X-Pinecone-Api-Version": PINECONE_API_VERSION, accept: "application/json", ...(serialized === undefined ? {} : { "content-type": "application/json" }) }, ...(serialized === undefined ? {} : { body: serialized }) }));
      const bodyValue = await stage(() => this.readResponse(response, controller.signal));
      if (!response.ok) throw new PineconeHttpError(response.status);
      return { status: response.status, body: bodyValue };
    } finally { clearTimeout(timer); }
  }

  private async readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > this.#maxResponseBytes)) { cancel(response.body); throw new RangeError("Pinecone response exceeds maxResponseBytes"); }
    if (response.body === null) return undefined;
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        total += item.value.byteLength;
        if (total > this.#maxResponseBytes) { void reader.cancel().catch(() => undefined); throw new RangeError("Pinecone response exceeds maxResponseBytes"); }
        chunks.push(item.value);
      }
    } finally { if (signal.aborted) void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* cancelled streams can retain their lock */ } }
    if (total === 0) return undefined;
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { throw new PineconeRequestError(); }
  }
}
