import {
  AlreadyExistsError,
  Key,
  NotFoundError,
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
import {
  compileQdrantQuery,
  validateQdrantCollectionName,
  validateQdrantPointId,
  type QdrantPointId,
} from "./query.js";

const DEFAULT_MAX_QUERY_LIMIT = 1_000;
const DEFAULT_MAX_QUERY_OFFSET = 10_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 30_000;

export type QdrantFetch = typeof globalThis.fetch;
export type QdrantHeaders = Readonly<Record<string, string>>;
export type QdrantVector = readonly number[];

/** Maps one DALgo collection to one intentionally configured Qdrant collection. */
export interface QdrantCollectionMapping {
  readonly collection: string;
  /** Produces the point vector from the JSON payload which will be written. */
  readonly vectorForWrite: (payload: Readonly<Record<string, unknown>>, key: Key) => QdrantVector;
  /** Name of the Qdrant vector for named-vector collections. */
  readonly vectorName?: string;
}

export interface QdrantDatabaseOptions {
  readonly baseUrl: string;
  /** Every usable DALgo collection must be mapped explicitly. */
  readonly collections: Readonly<Record<string, QdrantCollectionMapping>>;
  /** Resolved on each request, allowing a server-side token broker to rotate credentials. */
  readonly headers?: QdrantHeaders | (() => QdrantHeaders | Promise<QdrantHeaders>);
  readonly fetch?: QdrantFetch;
  readonly maxQueryLimit?: number;
  readonly maxQueryOffset?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
}

interface QdrantPoint {
  readonly id: QdrantPointId;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly vector?: unknown;
  readonly score?: number;
  readonly version?: number;
}

interface QdrantResponse {
  readonly status: number;
  readonly body: unknown;
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number | undefined, name: string, fallback: number, zeroAllowed = false): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < (zeroAllowed ? 0 : 1)) {
    throw new TypeError(`${name} must be a ${zeroAllowed ? "non-negative" : "positive"} safe integer`);
  }
  return resolved;
}

function validateHeaders(headers: QdrantHeaders): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string" || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) {
      throw new TypeError("Qdrant configured headers must be CR/LF-safe strings");
    }
  }
}

function assertJsonSafe(value: unknown, location: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${location} must not contain a non-finite number`);
  }
  if (typeof value !== "object") throw new TypeError(`${location} must be JSON-safe`);
  if (ancestors.has(value)) throw new TypeError(`${location} must not contain a cycle`);
  if (Array.isArray(value)) {
    ancestors.add(value);
    value.forEach((item, index) => {
      assertJsonSafe(item, `${location}[${String(index)}]`, ancestors);
    });
    ancestors.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${location} must contain only JSON objects and arrays`);
  ancestors.add(value);
  Object.entries(value).forEach(([key, item]) => {
    assertJsonSafe(item, `${location}.${key}`, ancestors);
  });
  ancestors.delete(value);
}

function payloadFrom(value: unknown): Readonly<Record<string, unknown>> {
  if (!isObject(value)) throw new TypeError("Qdrant DALgo document data must encode to a JSON object payload");
  assertJsonSafe(value, "Qdrant payload");
  return value;
}

function vectorFrom(value: QdrantVector): QdrantVector {
  if (value.length === 0 || !value.every((component) => typeof component === "number" && Number.isFinite(component))) {
    throw new TypeError("Qdrant vectors must be non-empty arrays of finite numbers");
  }
  return value;
}

function vectorRequest(vector: QdrantVector, mapping: QdrantCollectionMapping): unknown {
  const validated = vectorFrom(vector);
  return mapping.vectorName === undefined ? validated : { [mapping.vectorName]: validated };
}

function pointFrom(value: unknown, context: string): QdrantPoint {
  if (!isObject(value)) throw new TypeError(`malformed Qdrant ${context} point`);
  validateQdrantPointId(value.id);
  if (value.payload !== undefined && !isObject(value.payload)) throw new TypeError(`malformed Qdrant ${context} payload`);
  if (value.score !== undefined && (typeof value.score !== "number" || !Number.isFinite(value.score))) {
    throw new TypeError(`malformed Qdrant ${context} score`);
  }
  if (value.version !== undefined && (typeof value.version !== "number" || !Number.isSafeInteger(value.version))) {
    throw new TypeError(`malformed Qdrant ${context} version`);
  }
  return value as unknown as QdrantPoint;
}

function resultFrom(value: unknown, context: string): unknown {
  if (!isObject(value) || !Object.hasOwn(value, "result")) throw new TypeError(`malformed Qdrant ${context} response`);
  return value.result;
}

function pointsFromQuery(value: unknown, context: string): readonly QdrantPoint[] {
  const result = resultFrom(value, context);
  if (!isObject(result) || !Array.isArray(result.points)) throw new TypeError(`malformed Qdrant ${context} result`);
  return result.points.map((point) => pointFrom(point, context));
}

function pointsFromRetrieve(value: unknown): readonly QdrantPoint[] {
  const result = resultFrom(value, "retrieve");
  if (!Array.isArray(result)) throw new TypeError("malformed Qdrant retrieve result");
  return result.map((point) => pointFrom(point, "retrieve"));
}

function identity(id: QdrantPointId): string {
  return `${typeof id}:${String(id)}`;
}

function metadata(point: QdrantPoint, includeScore = false): Readonly<Record<string, unknown>> | undefined {
  const metadata = {
    ...(point.version === undefined ? {} : { version: point.version }),
    ...(includeScore && point.score !== undefined ? { score: point.score } : {}),
  };
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

async function responseText(response: Response, maxBytes: number): Promise<string> {
  const advertisedLength = response.headers.get("content-length");
  if (advertisedLength !== null && /^\d+$/u.test(advertisedLength) && Number(advertisedLength) > maxBytes) {
    await response.body?.cancel();
    throw new RangeError(`Qdrant response exceeds maxResponseBytes (${String(maxBytes)})`);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new RangeError(`Qdrant response exceeds maxResponseBytes (${String(maxBytes)})`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export class QdrantHttpError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super(`Qdrant request failed with HTTP ${String(status)}`);
    this.name = "QdrantHttpError";
    this.status = status;
  }
}

export class QdrantDatabase implements Database, WriteSession {
  readonly #baseUrl: string;
  readonly #collections: Readonly<Record<string, QdrantCollectionMapping>>;
  readonly #headers: QdrantDatabaseOptions["headers"];
  readonly #fetch: QdrantFetch;
  readonly #maxQueryLimit: number;
  readonly #maxQueryOffset: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #timeoutMs: number;

  public constructor(options: QdrantDatabaseOptions) {
    const url = new URL(options.baseUrl.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new TypeError("baseUrl must use HTTPS, except for loopback development");
    }
    if (url.username.length > 0 || url.password.length > 0) throw new TypeError("baseUrl must not contain credentials");
    if (url.search.length > 0 || url.hash.length > 0) throw new TypeError("baseUrl must not contain a query or fragment");
    if (!isObject(options.collections)) throw new TypeError("collections must be an explicit collection mapping");
    for (const [dalgoCollection, mapping] of Object.entries(options.collections)) {
      validateQdrantCollectionName(dalgoCollection);
      if (!isObject(mapping) || typeof mapping.collection !== "string" || typeof mapping.vectorForWrite !== "function") {
        throw new TypeError("each Qdrant collection mapping requires collection and vectorForWrite");
      }
      validateQdrantCollectionName(mapping.collection);
      if (mapping.vectorName !== undefined && (mapping.vectorName.length === 0 || /[\r\n]/u.test(mapping.vectorName))) {
        throw new TypeError("Qdrant vectorName must be a non-empty CR/LF-safe string");
      }
    }
    this.#baseUrl = url.toString().replace(/\/+$/u, "");
    this.#collections = Object.fromEntries(Object.entries(options.collections).map(([name, mapping]) => [name, { ...mapping }]));
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxQueryLimit = positiveInteger(options.maxQueryLimit, "maxQueryLimit", DEFAULT_MAX_QUERY_LIMIT);
    this.#maxQueryOffset = positiveInteger(options.maxQueryOffset, "maxQueryOffset", DEFAULT_MAX_QUERY_OFFSET, true);
    this.#maxRequestBytes = positiveInteger(options.maxRequestBytes, "maxRequestBytes", DEFAULT_MAX_REQUEST_BYTES);
    this.#maxResponseBytes = positiveInteger(options.maxResponseBytes, "maxResponseBytes", DEFAULT_MAX_RESPONSE_BYTES);
    this.#timeoutMs = positiveInteger(options.timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS);
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const mapping = this.mappingForKey(key);
    const response = await this.request("GET", `${this.pointsPath(mapping)}/${encodeURIComponent(String(key.id))}`, undefined, [404]);
    if (response.status === 404) return { key, exists: false };
    const point = pointFrom(resultFrom(response.body, "get"), "get");
    this.assertPointMatchesKey(point, key, "get");
    return this.recordFromPoint(key, point, codec);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length === 0) return [];
    const mappings = keys.map((key) => this.mappingForKey(key));
    const first = mappings[0];
    if (first === undefined || mappings.some((mapping) => mapping.collection !== first.collection)) {
      throw new UnsupportedError("Qdrant getMany across differently mapped collections");
    }
    const response = await this.request("POST", this.pointsPath(first), { ids: keys.map((key) => key.id), with_payload: true, with_vector: false });
    const points = new Map(pointsFromRetrieve(response.body).map((point) => [identity(point.id), point]));
    return keys.map((key) => {
      const point = points.get(identity(key.id));
      if (point === undefined) return { key, exists: false };
      this.assertPointMatchesKey(point, key, "retrieve");
      return this.recordFromPoint(key, point, codec);
    });
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    const mapping = this.mappingForSource(query);
    const compiled = compileQdrantQuery(query, this.#maxQueryLimit, this.#maxQueryOffset);
    const points = pointsFromQuery(await this.request("POST", `${this.pointsPath(mapping)}/query`, { ...compiled, with_payload: true, with_vector: false }).then((response) => response.body), "query");
    return { records: points.map((point) => this.recordFromPoint(new Key(query.source.name, point.id), point, query.source.codec)) };
  }

  /** Vector similarity is deliberately separate because DALgo StructuredQuery has no vector input. */
  public async vectorSearch<T>(query: StructuredQuery<T>, vector: QdrantVector): Promise<QueryPage<T>> {
    const mapping = this.mappingForSource(query);
    const compiled = compileQdrantQuery(query, this.#maxQueryLimit, this.#maxQueryOffset);
    const body = { ...compiled, query: vectorRequest(vector, mapping), ...(mapping.vectorName === undefined ? {} : { using: mapping.vectorName }), with_payload: true, with_vector: false };
    const response = await this.request("POST", `${this.pointsPath(mapping)}/query`, body);
    const points = pointsFromQuery(response.body, "vector query");
    return { records: points.map((point) => this.recordFromPoint(new Key(query.source.name, point.id), point, query.source.codec, true)) };
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const existing = await this.get(key);
    if (existing.exists) throw new AlreadyExistsError(key);
    await this.set(key, data, codec);
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const mapping = this.mappingForKey(key);
    const payload = payloadFrom(codecOrIdentity(codec).encode(data));
    const vector = vectorRequest(mapping.vectorForWrite(payload, key), mapping);
    await this.request("PUT", `${this.pointsPath(mapping)}?wait=true`, { points: [{ id: key.id, payload, vector }] });
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    const mapping = this.mappingForKey(key);
    const existing = await this.get(key);
    if (!existing.exists) throw new NotFoundError(key);
    const payload = payloadFrom(data);
    await this.request("POST", `${this.pointsPath(mapping)}/payload?wait=true`, { points: [key.id], payload });
  }

  public async delete(key: Key): Promise<void> {
    const mapping = this.mappingForKey(key);
    await this.request("POST", `${this.pointsPath(mapping)}/delete?wait=true`, { points: [key.id] });
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    if (typeof callback !== "function") throw new TypeError("transaction callback is required");
    return Promise.reject(new UnsupportedError("Qdrant multi-document transactions"));
  }

  private mappingForKey(key: Key): QdrantCollectionMapping {
    if (key.parent !== undefined) throw new UnsupportedError("Qdrant nested collection keys");
    validateQdrantPointId(key.id);
    return this.mappingForCollection(key.collection);
  }

  private mappingForSource<T>(query: StructuredQuery<T>): QdrantCollectionMapping {
    if (query.source.kind !== "collection") throw new UnsupportedError("Qdrant collection-group queries");
    if (query.source.parent !== undefined) throw new UnsupportedError("Qdrant nested collection queries");
    return this.mappingForCollection(query.source.name);
  }

  private mappingForCollection(dalgoCollection: string): QdrantCollectionMapping {
    const mapping = this.#collections[dalgoCollection];
    if (mapping === undefined) throw new UnsupportedError(`Qdrant collection mapping for ${dalgoCollection}`);
    return mapping;
  }

  private pointsPath(mapping: QdrantCollectionMapping): string {
    return `/collections/${encodeURIComponent(mapping.collection)}/points`;
  }

  private assertPointMatchesKey(point: QdrantPoint, key: Key, context: string): void {
    if (point.id !== key.id || typeof point.id !== typeof key.id) throw new TypeError(`Qdrant ${context} response does not match requested key`);
  }

  private recordFromPoint<T>(key: Key, point: QdrantPoint, codec?: Codec<T>, includeScore = false): ExistingRecord<T> {
    if (point.payload === undefined) throw new UnsupportedError("Qdrant point without payload");
    const recordMetadata = metadata(point, includeScore);
    return { key, exists: true, data: codecOrIdentity(codec).decode(point.payload), ...(recordMetadata === undefined ? {} : { metadata: recordMetadata }) };
  }

  private async request(method: string, path: string, body?: unknown, acceptedStatuses: readonly number[] = []): Promise<QdrantResponse> {
    let serialized: string | undefined;
    if (body !== undefined) {
      assertJsonSafe(body, "Qdrant request body");
      serialized = JSON.stringify(body);
      if (new TextEncoder().encode(serialized).byteLength > this.#maxRequestBytes) {
        throw new RangeError(`Qdrant request body exceeds maxRequestBytes (${String(this.#maxRequestBytes)})`);
      }
    }
    const configured = typeof this.#headers === "function" ? await this.#headers() : (this.#headers ?? {});
    validateHeaders(configured);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error("Qdrant request timed out"));
    }, this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: { ...configured, accept: "application/json", ...(serialized === undefined ? {} : { "content-type": "application/json" }) },
        ...(serialized === undefined ? {} : { body: serialized }),
      });
      const text = await responseText(response, this.#maxResponseBytes);
      if (!response.ok && !acceptedStatuses.includes(response.status)) throw new QdrantHttpError(response.status);
      let parsed: unknown;
      try { parsed = text.length === 0 ? undefined : JSON.parse(text); } catch { parsed = text; }
      return { status: response.status, body: parsed };
    } finally {
      clearTimeout(timeout);
    }
  }
}
