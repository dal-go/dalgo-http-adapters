import {
  AlreadyExistsError,
  DOCUMENT_ID,
  Key,
  UnsupportedError,
  identityCodec,
  type Codec,
  type Database,
  type ExistingRecord,
  type QueryCursor,
  type QueryFilter,
  type QueryPage,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
} from "@dal-go/dalgo";

export type CosmosFetch = typeof globalThis.fetch;
export type CosmosPartitionValue = string | number | boolean | null;

export interface CosmosAuthorizationRequest {
  readonly method: string;
  /** Cosmos resource link, without a leading slash. */
  readonly resourcePath: string;
  readonly resourceType: "docs";
  /** RFC 1123 UTC date sent as x-ms-date. */
  readonly date: string;
}

/**
 * Supplies a complete Cosmos `authorization` header value.
 *
 * In a browser this must normally return a time-bound, narrowly scoped Cosmos
 * resource token from a trusted token broker. It must never expose an account
 * master key. The adapter intentionally does not implement master-key signing.
 */
export type CosmosAuthorizationProvider = (
  request: CosmosAuthorizationRequest,
) => string | Promise<string>;

export interface CosmosNoSqlOptions {
  /** e.g. https://example.documents.azure.com */
  readonly endpoint: string;
  readonly databaseId: string;
  readonly containerId: string;
  /** Provider for the per-request Cosmos authorization header. */
  readonly authorization: CosmosAuthorizationProvider;
  /** Maps every DALgo collection path to exactly one Cosmos partition value. */
  readonly partitionKey?: (collectionPath: string) => CosmosPartitionValue;
  /** Physical Cosmos partition-key property. Defaults to __dalgo_partition. */
  readonly partitionKeyField?: string;
  /** REST service version. Defaults to 2018-12-31, the current REST reference version. */
  readonly serviceVersion?: string;
  /** Request timeout. Defaults to 15 seconds; bounded to 1..120000 ms. */
  readonly timeoutMs?: number;
  /** Maximum UTF-8 request JSON size. Defaults to 1 MiB. */
  readonly maxRequestBytes?: number;
  /** Maximum response body size. Defaults to 1 MiB. */
  readonly maxResponseBytes?: number;
  /** Maximum point reads accepted by getMany. Defaults to 100. */
  readonly maxGetManyKeys?: number;
  /** Maximum concurrent point reads used by getMany. Defaults to 8. */
  readonly maxParallelReads?: number;
  /** Maximum and default Cosmos x-ms-max-item-count. Defaults to 100. */
  readonly maxQueryLimit?: number;
  /** Injected for deterministic tests. */
  readonly fetch?: CosmosFetch;
}

interface ResolvedOptions {
  readonly endpoint: string;
  readonly databaseId: string;
  readonly containerId: string;
  readonly authorization: CosmosAuthorizationProvider;
  readonly partitionKey: (collectionPath: string) => CosmosPartitionValue;
  readonly partitionKeyField: string;
  readonly serviceVersion: string;
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxGetManyKeys: number;
  readonly maxParallelReads: number;
  readonly maxQueryLimit: number;
  readonly fetch: CosmosFetch;
}

interface CosmosDocument {
  readonly id: string;
  readonly __dalgo_collection: string;
  readonly __dalgo_id: string | number;
  readonly data: unknown;
  readonly _etag?: string;
  readonly _ts?: number;
}

interface CosmosQueryResult {
  readonly Documents: readonly CosmosDocument[];
}

interface CosmosCursor {
  readonly adapter: "@dal-go/dalgo2cosmosdb";
  readonly version: 1;
  readonly databaseId: string;
  readonly containerId: string;
  readonly collectionPath: string;
  readonly partition: CosmosPartitionValue;
  readonly continuation: string;
}

export class CosmosHttpError extends Error {
  public readonly status: number;
  public readonly retryAfterMs?: number;

  public constructor(status: number, retryAfterMs?: number) {
    super(`Cosmos DB request failed with HTTP ${String(status)}`);
    this.name = "CosmosHttpError";
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

function requireName(value: string, field: string): string {
  if (value.trim().length === 0) throw new TypeError(`${field} must not be empty`);
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, field: string, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`${field} must be a safe integer from 1 to ${String(maximum)}`);
  return result;
}

function resourceId(value: string, field: string): string {
  const result = requireName(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(result)) throw new TypeError(`${field} must use only ASCII letters, digits, dot, underscore, and hyphen`);
  return result;
}

function resolve(options: CosmosNoSqlOptions): ResolvedOptions {
  const url = new URL(options.endpoint.trim());
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("endpoint must use HTTPS, except for loopback development");
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0 || url.pathname !== "/") {
    throw new TypeError("endpoint must be an origin with no credentials, path, query, or fragment");
  }
  const partitionKeyField = requireName(options.partitionKeyField ?? "__dalgo_partition", "partitionKeyField");
  if (!/^[_A-Za-z][_0-9A-Za-z]*$/u.test(partitionKeyField)) {
    throw new TypeError("partitionKeyField must be a simple JSON property name");
  }
  if (new Set(["id", "__dalgo_collection", "__dalgo_id", "data"]).has(partitionKeyField)) throw new TypeError("partitionKeyField must not collide with a reserved DALgo layout field");
  const serviceVersion = requireName(options.serviceVersion ?? "2018-12-31", "serviceVersion");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(serviceVersion)) throw new TypeError("serviceVersion must use YYYY-MM-DD format");
  const maxGetManyKeys = boundedInteger(options.maxGetManyKeys, 100, "maxGetManyKeys", 1000);
  const maxParallelReads = boundedInteger(options.maxParallelReads, Math.min(8, maxGetManyKeys), "maxParallelReads", maxGetManyKeys);
  return {
    endpoint: url.origin,
    databaseId: resourceId(options.databaseId, "databaseId"),
    containerId: resourceId(options.containerId, "containerId"),
    authorization: options.authorization,
    partitionKey: options.partitionKey ?? ((collectionPath) => collectionPath),
    partitionKeyField,
    serviceVersion,
    timeoutMs: boundedInteger(options.timeoutMs, 15_000, "timeoutMs", 120_000),
    maxRequestBytes: boundedInteger(options.maxRequestBytes, 1_048_576, "maxRequestBytes", 16_777_216),
    maxResponseBytes: boundedInteger(options.maxResponseBytes, 1_048_576, "maxResponseBytes", 16_777_216),
    maxGetManyKeys,
    maxParallelReads,
    maxQueryLimit: boundedInteger(options.maxQueryLimit, 100, "maxQueryLimit", 1000),
    fetch: options.fetch ?? globalThis.fetch,
  };
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDocument(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError("Cosmos DALgo records must encode to a non-null plain object");
  assertJsonValue(value);
}

function assertJsonValue(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("Cosmos JSON numbers must be finite and must not be -0");
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Cosmos JSON must not contain cycles");
    seen.add(value);
    for (const entry of value) assertJsonValue(entry, seen);
    seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) throw new TypeError("Cosmos JSON values must be null, primitives, arrays, or plain records");
  if (seen.has(value)) throw new TypeError("Cosmos JSON must not contain cycles");
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
    throw new TypeError("Cosmos JSON records must have only enumerable string properties");
  }
  seen.add(value);
  for (const entry of Object.values(value)) assertJsonValue(entry, seen);
  seen.delete(value);
}

function serializeJson(value: unknown): string {
  assertJsonValue(value);
  // Validation above makes this result total and prevents JSON's lossy coercions.
  return JSON.stringify(value);
}

function isKeyId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0));
}

function storageId(id: string | number): string {
  if (!isKeyId(id)) throw new TypeError("Cosmos DALgo key IDs must be strings or safe integers, excluding -0");
  const bytes = new TextEncoder().encode(JSON.stringify(id));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=/gu, "");
}

function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }

async function responseText(response: Response, maximum: number, signal: AbortSignal): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
      await response.body?.cancel();
      throw new RangeError("Cosmos response exceeds maxResponseBytes");
    }
  }
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject as (reason: Error) => void; });
  const cancelOnAbort = () => { rejectAbort?.(new Error("Cosmos response timed out")); void reader.cancel(); };
  if (signal.aborted) cancelOnAbort();
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    let next = await Promise.race([reader.read(), aborted]);
    while (!next.done) {
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new RangeError("Cosmos response exceeds maxResponseBytes");
      }
      chunks.push(next.value);
      next = await Promise.race([reader.read(), aborted]);
    }
  } finally { signal.removeEventListener("abort", cancelOnAbort); reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function fieldPath(field: string): string {
  if (field.length === 0) throw new TypeError("Cosmos query filter fields must not be empty");
  return `c.data[${JSON.stringify(field)}]`;
}

function queryResult(value: unknown): CosmosQueryResult {
  if (!isObject(value) || !Array.isArray(value.Documents)) throw new TypeError("malformed Cosmos query response");
  return { Documents: value.Documents.map((document) => cosmosDocument(document, "query")) };
}

function cosmosDocument(value: unknown, operation: string): CosmosDocument {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.__dalgo_collection !== "string" || !isKeyId(value.__dalgo_id) || !("data" in value)) {
    throw new TypeError(`malformed Cosmos ${operation} document`);
  }
  if (value._etag !== undefined && typeof value._etag !== "string") throw new TypeError(`malformed Cosmos ${operation} etag`);
  if (value._ts !== undefined && (typeof value._ts !== "number" || !Number.isSafeInteger(value._ts))) throw new TypeError(`malformed Cosmos ${operation} timestamp`);
  return {
    id: value.id,
    __dalgo_collection: value.__dalgo_collection,
    __dalgo_id: value.__dalgo_id,
    data: value.data,
    ...(value._etag === undefined ? {} : { _etag: value._etag }),
    ...(value._ts === undefined ? {} : { _ts: value._ts }),
  };
}

/** A bounded DALgo adapter for one existing Cosmos DB for NoSQL container. */
export class CosmosNoSqlDatabase implements Database {
  readonly #options: ResolvedOptions;

  public constructor(options: CosmosNoSqlOptions) { this.#options = resolve(options); }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const partition = this.partition(key.collectionPath);
    const response = await this.request("GET", this.documentPath(key), partition, undefined, [404]);
    if (response.status === 404) return { key, exists: false };
    return this.record(key, cosmosDocument(response.body, "get"), codec);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#options.maxGetManyKeys) throw new UnsupportedError(`Cosmos getMany supports at most ${String(this.#options.maxGetManyKeys)} keys`);
    const results: RecordSnapshot<T>[] = [];
    for (let start = 0; start < keys.length; start += this.#options.maxParallelReads) {
      const batch = keys.slice(start, start + this.#options.maxParallelReads);
      results.push(...await Promise.all(batch.map(async (key) => this.get(key, codec))));
    }
    return results;
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const partition = this.partition(key.collectionPath);
    const response = await this.request("POST", this.documentsPath(), partition, this.documentFor(key, partition, codecOrIdentity(codec).encode(data)), [409]);
    if (response.status === 409) throw new AlreadyExistsError(key, { cause: new CosmosHttpError(409, response.retryAfterMs) });
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const partition = this.partition(key.collectionPath);
    await this.request("POST", this.documentsPath(), partition, this.documentFor(key, partition, codecOrIdentity(codec).encode(data)), [], { "x-ms-documentdb-is-upsert": "True" });
  }

  public update(key: Key, data: UpdateData): Promise<void> {
    return Promise.reject(new UnsupportedError(`Cosmos DB partial updates for ${key.collectionPath} (${String(Object.keys(data).length)} fields): use Cosmos Patch explicitly`));
  }

  public async delete(key: Key): Promise<void> {
    const partition = this.partition(key.collectionPath);
    await this.request("DELETE", this.documentPath(key), partition, undefined, [404]);
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    if (query.source.kind !== "collection") throw new UnsupportedError("Cosmos collection-group queries");
    if ((query.offset ?? 0) !== 0) throw new UnsupportedError("Cosmos query offsets");
    if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
      throw new UnsupportedError("Cosmos inclusive and end query cursors");
    }
    if (query.orders.length !== 0) throw new UnsupportedError("Cosmos ordering; an unordered Cosmos continuation is the only preserved DALgo pagination mode");
    const collectionPath = query.source.parent === undefined ? query.source.name : `${query.source.parent.path}/${query.source.name}`;
    const partition = this.partition(collectionPath);
    const cursor = this.cursor(query.startAfter, collectionPath, partition);
    const compiled = this.compileFilters(query.filters);
    const parameters: { name: string; value: unknown }[] = [
      { name: "@collection", value: collectionPath },
      ...compiled.parameters,
    ];
    const clauses = ["c.__dalgo_collection = @collection", ...compiled.clauses];
    const body = { query: `SELECT * FROM c WHERE ${clauses.join(" AND ")}`, parameters };
    const limit = query.limit ?? this.#options.maxQueryLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#options.maxQueryLimit) throw new UnsupportedError(`Cosmos query limit must be from 1 to ${String(this.#options.maxQueryLimit)}`);
    const response = await this.request("POST", this.documentsPath(), partition, body, [], {
      "content-type": "application/query+json",
      "x-ms-documentdb-isquery": "True",
      "x-ms-max-item-count": String(limit),
      ...(cursor === undefined ? {} : { "x-ms-continuation": cursor.continuation }),
    });
    const result = queryResult(response.body);
    const parent = query.source.parent;
    const records = result.Documents.map((document) => {
      if (document.__dalgo_collection !== collectionPath) throw new TypeError("Cosmos query returned a document outside the requested collection");
      return this.record(new Key(query.source.name, document.__dalgo_id, parent), document, query.source.codec);
    });
    const continuation = response.headers.get("x-ms-continuation");
    const nextCursor = continuation === null || continuation.length === 0 ? undefined : this.cursorFor(collectionPath, partition, continuation);
    return { records, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    if (typeof callback !== "function") return Promise.reject(new TypeError("transaction callback is required"));
    return Promise.reject(new UnsupportedError("Cosmos DB DALgo callback transactions; Cosmos transactional batches are partition-scoped and cannot preserve callback retry semantics"));
  }

  private documentsPath(): string { return `dbs/${encodeURIComponent(this.#options.databaseId)}/colls/${encodeURIComponent(this.#options.containerId)}/docs`; }
  private documentPath(key: Key): string { return `${this.documentsPath()}/${storageId(key.id)}`; }
  private partition(collectionPath: string): CosmosPartitionValue {
    const value: unknown = this.#options.partitionKey(collectionPath);
    if (!(typeof value === "string" || typeof value === "boolean" || value === null || (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)))) {
      throw new TypeError("partitionKey must return a JSON scalar with a finite non--0 number, or null");
    }
    return value;
  }
  private documentFor(key: Key, partition: CosmosPartitionValue, data: unknown): Record<string, unknown> {
    assertDocument(data);
    return { id: storageId(key.id), __dalgo_collection: key.collectionPath, __dalgo_id: key.id, [this.#options.partitionKeyField]: partition, data };
  }
  private record<T>(key: Key, document: CosmosDocument, codec?: Codec<T>): ExistingRecord<T> {
    if (document.id !== storageId(key.id) || document.__dalgo_collection !== key.collectionPath || document.__dalgo_id !== key.id) throw new TypeError("Cosmos response document does not match the requested DALgo key");
    assertDocument(document.data);
    return { key, exists: true, data: codecOrIdentity(codec).decode(document.data), metadata: { ...(document._etag === undefined ? {} : { etag: document._etag }), ...(document._ts === undefined ? {} : { timestamp: document._ts }) } };
  }
  private compileFilters<T>(filters: readonly QueryFilter<T>[]): { clauses: string[]; parameters: { name: string; value: unknown }[] } {
    const clauses: string[] = [];
    const parameters: { name: string; value: unknown }[] = [];
    for (const [index, filter] of filters.entries()) {
      assertJsonValue(filter.value);
      if (filter.field === DOCUMENT_ID) {
        if (filter.operator === "in") {
          if (!Array.isArray(filter.value) || !filter.value.every(isKeyId)) throw new TypeError("Cosmos document-ID in filters require valid key IDs");
        } else if (!isKeyId(filter.value)) throw new TypeError("Cosmos document-ID filters require a valid key ID");
      }
      const parameter = `@p${String(index)}`;
      const path = filter.field === DOCUMENT_ID ? "c.__dalgo_id" : typeof filter.field === "string" ? fieldPath(filter.field) : undefined;
      if (path === undefined) throw new UnsupportedError("Cosmos non-string query filter fields");
      switch (filter.operator) {
        case "==": case "!=": case "<": case "<=": case ">": case ">=":
          parameters.push({ name: parameter, value: filter.value }); clauses.push(`${path} ${filter.operator === "==" ? "=" : filter.operator} ${parameter}`); break;
        case "in":
          if (!Array.isArray(filter.value) || filter.value.length === 0) throw new TypeError("Cosmos in filters require a non-empty array");
          parameters.push({ name: parameter, value: filter.value }); clauses.push(`ARRAY_CONTAINS(${parameter}, ${path})`); break;
        case "array-contains":
          parameters.push({ name: parameter, value: filter.value }); clauses.push(`ARRAY_CONTAINS(${path}, ${parameter})`); break;
        default: throw new UnsupportedError(`Cosmos query operator ${filter.operator}`);
      }
    }
    return { clauses, parameters };
  }
  private cursorFor(collectionPath: string, partition: CosmosPartitionValue, continuation: string): QueryCursor {
    return { values: [{ adapter: "@dal-go/dalgo2cosmosdb", version: 1, databaseId: this.#options.databaseId, containerId: this.#options.containerId, collectionPath, partition, continuation } satisfies CosmosCursor] };
  }
  private cursor(cursor: QueryCursor | undefined, collectionPath: string, partition: CosmosPartitionValue): CosmosCursor | undefined {
    if (cursor === undefined) return undefined;
    if (cursor.values.length !== 1 || !isObject(cursor.values[0])) throw new TypeError("Cosmos startAfter must be a cursor returned by this adapter");
    const value = cursor.values[0];
    if (value.adapter !== "@dal-go/dalgo2cosmosdb" || value.version !== 1 || value.databaseId !== this.#options.databaseId || value.containerId !== this.#options.containerId || value.collectionPath !== collectionPath || value.partition !== partition || typeof value.continuation !== "string" || value.continuation.length === 0) throw new TypeError("Cosmos startAfter does not belong to this container, collection, and partition");
    return {
      adapter: "@dal-go/dalgo2cosmosdb",
      version: 1,
      databaseId: value.databaseId,
      containerId: value.containerId,
      collectionPath: value.collectionPath,
      partition: value.partition as CosmosPartitionValue,
      continuation: value.continuation,
    };
  }
  private async request(method: string, resourcePath: string, partition: CosmosPartitionValue, body?: unknown, accepted: readonly number[] = [], extra: Readonly<Record<string, string>> = {}): Promise<{ status: number; body: unknown; headers: Headers; retryAfterMs?: number }> {
    const date = new Date().toUTCString();
    const authorization = await this.#options.authorization({ method, resourcePath, resourceType: "docs", date });
    if (authorization.trim().length === 0 || /[\r\n]/u.test(authorization)) throw new TypeError("authorization provider returned an unsafe header");
    const serialized = body === undefined ? undefined : serializeJson(body);
    if (serialized !== undefined && byteLength(serialized) > this.#options.maxRequestBytes) throw new RangeError("Cosmos request exceeds maxRequestBytes");
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); }, this.#options.timeoutMs);
    try {
      const response = await this.#options.fetch(`${this.#options.endpoint}/${resourcePath}`, { method, redirect: "error", signal: controller.signal, headers: { accept: "application/json", "x-ms-date": date, "x-ms-version": this.#options.serviceVersion, authorization, "x-ms-documentdb-partitionkey": JSON.stringify([partition]), ...(serialized === undefined ? {} : { "content-type": "application/json" }), ...extra }, ...(serialized === undefined ? {} : { body: serialized }) });
      const text = await responseText(response, this.#options.maxResponseBytes, controller.signal);
      let parsed: unknown;
      try { parsed = text.length === 0 ? undefined : JSON.parse(text); } catch { parsed = text; }
      const retryAfterHeader = response.headers.get("x-ms-retry-after-ms");
      const retryAfterMs = retryAfterHeader === null ? undefined : Number(retryAfterHeader);
      const safeRetryAfterMs = retryAfterMs !== undefined && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : undefined;
      if (!response.ok && !accepted.includes(response.status)) throw new CosmosHttpError(response.status, safeRetryAfterMs);
      return { status: response.status, body: parsed, headers: response.headers, ...(safeRetryAfterMs === undefined ? {} : { retryAfterMs: safeRetryAfterMs }) };
    } catch (error: unknown) {
      if (controller.signal.aborted) throw new Error(`Cosmos request timed out after ${String(this.#options.timeoutMs)}ms`, { cause: error });
      throw error;
    } finally { clearTimeout(timeout); }
  }
}
