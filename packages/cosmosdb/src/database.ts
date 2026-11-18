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
} from "@dalgo/core";
import { CosmosOperation } from "./operation.js";
import { boundedHeaders, discardBody, ownedFetch, responseText } from "./transport.js";

export type CosmosFetch = typeof globalThis.fetch;
export type CosmosPartitionValue = string | number | boolean | null;

export interface CosmosAuthorizationRequest {
  readonly method: string;
  /** Whole-operation signal, including authorization acquisition. */
  readonly signal: AbortSignal;
  /** Canonical Cosmos signing resource link (parent container for feeds). */
  readonly resourceLink: string;
  /** Actual REST request path, without a leading slash; feed paths include /docs. */
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

interface CursorState { readonly scope: string; readonly continuation: string; }

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
  if (result.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(result)) throw new TypeError(`${field} must use only ASCII letters, digits, dot, underscore, and hyphen`);
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
  const maxParallelReads = boundedInteger(options.maxParallelReads, Math.min(8, maxGetManyKeys), "maxParallelReads", Math.min(32, maxGetManyKeys));
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

function assertJsonValue(value: unknown): void {
  const seen = new Set<object>();
  let nodes = 0;
  let stringBytes = 0;
  const chargeString = (value: string): void => {
    if (value.length > 16_777_216) throw new RangeError("Cosmos JSON string byte bound exceeded");
    stringBytes += byteLength(value);
    if (stringBytes > 16_777_216) throw new RangeError("Cosmos JSON string byte bound exceeded");
  };
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 65_536 || depth > 32) throw new RangeError("Cosmos JSON structural bound exceeded");
    if (typeof entry === "string") { chargeString(entry); return; }
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry) || Object.is(entry, -0)) throw new TypeError("Cosmos JSON numbers must be finite and must not be -0");
      return;
    }
    if (typeof entry !== "object" || (!Array.isArray(entry) && !isPlainObject(entry))) throw new TypeError("Cosmos JSON values must be null, primitives, arrays, or plain records");
    if (Array.isArray(entry) && Object.getPrototypeOf(entry) !== Array.prototype) throw new TypeError("Cosmos JSON arrays must have the standard prototype");
    if (seen.has(entry)) throw new TypeError("Cosmos JSON must not contain cycles");
    seen.add(entry);
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    const names = Reflect.ownKeys(descriptors);
    if (names.length > 65_537) throw new RangeError("Cosmos JSON structural bound exceeded");
    if (Array.isArray(entry) && (entry.length > 65_536 || names.length !== entry.length + 1)) throw new TypeError("Cosmos JSON arrays must be dense with no extra properties");
    for (const name of names) {
      if (typeof name !== "string") throw new TypeError("Cosmos JSON records must have only enumerable string properties");
      if (Array.isArray(entry) && name === "length") continue;
      const descriptor = descriptors[name];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("Cosmos JSON accessors and hidden properties are not supported");
      if (Array.isArray(entry) && (!/^(0|[1-9][0-9]*)$/u.test(name) || Number(name) >= entry.length)) throw new TypeError("Cosmos JSON arrays must have only indexed values");
      chargeString(name);
      visit(descriptor.value, depth + 1);
    }
    seen.delete(entry);
  };
  visit(value, 0);
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
  if (typeof id === "string" && byteLength(id) > 4096) throw new RangeError("Cosmos key exceeds the supported byte bound");
  const bytes = new TextEncoder().encode(JSON.stringify(id));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=/gu, "");
}

function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }


function fieldPath(field: string): string {
  if (field.length === 0 || byteLength(field) > 4096) throw new TypeError("Cosmos query filter fields must be nonempty bounded strings");
  return `c.data[${JSON.stringify(field)}]`;
}

function queryResult(value: unknown, limit: number, partitionKeyField: string, partition: CosmosPartitionValue): CosmosQueryResult {
  if (!isObject(value) || !Array.isArray(value.Documents)) throw new TypeError("malformed Cosmos query response");
  if (value.Documents.length > limit) throw new RangeError("Cosmos query response exceeds the requested limit");
  if ("_count" in value && value._count !== value.Documents.length) throw new TypeError("Cosmos query response count does not match its documents");
  return { Documents: value.Documents.map((document) => cosmosDocument(document, "query", partitionKeyField, partition)) };
}

function cosmosDocument(value: unknown, operation: string, partitionKeyField: string, partition: CosmosPartitionValue): CosmosDocument {
  assertJsonValue(value);
  if (!isObject(value) || typeof value.id !== "string" || typeof value.__dalgo_collection !== "string" || !isKeyId(value.__dalgo_id) || !("data" in value)) {
    throw new TypeError(`malformed Cosmos ${operation} document`);
  }
  if (partitionKeyField in value && value[partitionKeyField] !== partition) throw new TypeError("Cosmos document has an unexpected physical partition value");
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
  readonly #cursors = new WeakMap<object, CursorState>();

  public constructor(options: CosmosNoSqlOptions) { this.#options = resolve(options); }

  public get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> { return this.getWithSignal(key, undefined, codec); }

  public getWithSignal<T>(key: Key, signal: AbortSignal | undefined, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    return this.operation(signal, (op) => this.read(op, key, codec));
  }

  private async read<T>(op: CosmosOperation, key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    op.check();
    const partition = this.partition(op, key.collectionPath);
    const response = await this.request(op, "GET", this.documentPath(key), partition, undefined, [404]);
    op.check();
    if (response.status === 404) return { key, exists: false };
    return this.record(op, key, cosmosDocument(response.body, "get", this.#options.partitionKeyField, partition), codec);
  }

  public getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> { return this.getManyWithSignal(keys, undefined, codec); }

  public getManyWithSignal<T>(keys: readonly Key[], signal: AbortSignal | undefined, codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    return this.operation(signal, async (op) => {
      if (keys.length > this.#options.maxGetManyKeys) throw new UnsupportedError(`Cosmos getMany supports at most ${String(this.#options.maxGetManyKeys)} keys`);
      const admitted = keys.slice();
      // Validate the whole list before the first credential/network effect.
      for (const key of admitted) { op.check(); this.documentPath(key); this.collectionPath(key.collectionPath); }
      const results: RecordSnapshot<T>[] = [];
      for (let start = 0; start < admitted.length; start += this.#options.maxParallelReads) {
        op.check();
        const batch = admitted.slice(start, start + this.#options.maxParallelReads);
        try { results.push(...await Promise.all(batch.map(async (key) => this.read(op, key, codec)))); }
        catch (error: unknown) { op.check(); op.fail(); throw error; }
      }
      return results;
    });
  }

  public insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    return this.operation(undefined, async (op) => {
      const partition = this.partition(op, key.collectionPath);
      const encoded = op.call(() => codecOrIdentity(codec).encode(data));
      const response = await this.request(op, "POST", this.documentsPath(), partition, this.documentFor(key, partition, encoded), [409], {}, false);
      if (response.status === 409) throw new AlreadyExistsError(key, { cause: new CosmosHttpError(409, response.retryAfterMs) });
    });
  }

  public set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    return this.operation(undefined, async (op) => {
      const partition = this.partition(op, key.collectionPath);
      const encoded = op.call(() => codecOrIdentity(codec).encode(data));
      await this.request(op, "POST", this.documentsPath(), partition, this.documentFor(key, partition, encoded), [], { "x-ms-documentdb-is-upsert": "True" }, false);
    });
  }

  public update(key: Key, data: UpdateData): Promise<void> {
    return Promise.reject(new UnsupportedError(`Cosmos DB partial updates for ${key.collectionPath} (${String(Object.keys(data).length)} fields): use Cosmos Patch explicitly`));
  }

  public delete(key: Key): Promise<void> {
    return this.operation(undefined, async (op) => {
      const partition = this.partition(op, key.collectionPath);
      await this.request(op, "DELETE", this.documentPath(key), partition, undefined, [404], {}, false);
    });
  }

  public query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> { return this.queryWithSignal(query, undefined); }

  public queryWithSignal<T>(query: StructuredQuery<T>, signal: AbortSignal | undefined): Promise<QueryPage<T>> {
    return this.operation(signal, async (op) => {
      const source = query.source;
      if (source.kind !== "collection") throw new UnsupportedError("Cosmos collection-group queries");
      if ((query.offset ?? 0) !== 0) throw new UnsupportedError("Cosmos query offsets");
      if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("Cosmos inclusive and end query cursors");
      if (query.orders.length !== 0) throw new UnsupportedError("Cosmos ordering; an unordered Cosmos continuation is the only preserved DALgo pagination mode");
      if (query.filters.length > 64) throw new UnsupportedError("Cosmos queries support at most 64 filters");
      const collectionPath = this.collectionPath(source.parent === undefined ? source.name : `${source.parent.path}/${source.name}`);
      const partition = this.partition(op, collectionPath);
      const compiled = this.compileFilters(query.filters);
      const parameters = [{ name: "@collection", value: collectionPath }, ...compiled.parameters];
      const clauses = ["c.__dalgo_collection = @collection", ...compiled.clauses];
      const body = { query: `SELECT * FROM c WHERE ${clauses.join(" AND ")}`, parameters };
      const limit = query.limit ?? this.#options.maxQueryLimit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#options.maxQueryLimit) throw new UnsupportedError(`Cosmos query limit must be from 1 to ${String(this.#options.maxQueryLimit)}`);
      const scope = serializeJson([this.#options.databaseId, this.#options.containerId, collectionPath, partition, body, limit]);
      if (byteLength(scope) > this.#options.maxRequestBytes) throw new RangeError("Cosmos request exceeds maxRequestBytes");
      const cursor = this.cursor(query.startAfter, scope);
      const response = await this.request(op, "POST", this.documentsPath(), partition, body, [], {
        "content-type": "application/query+json", "x-ms-documentdb-isquery": "True", "x-ms-max-item-count": String(limit),
        ...(cursor === undefined ? {} : { "x-ms-continuation": cursor.continuation }),
      });
      const result = queryResult(response.body, limit, this.#options.partitionKeyField, partition);
      const identities = new Set<string>();
      // Validate the complete managed page before any caller codec is invoked.
      for (const document of result.Documents) {
        op.check();
        if (document.__dalgo_collection !== collectionPath) throw new TypeError("Cosmos query returned a document outside the requested collection");
        if (document.id !== storageId(document.__dalgo_id) || identities.has(document.id)) throw new TypeError("Cosmos query returned mismatched or duplicate managed identities");
        identities.add(document.id);
        assertDocument(document.data);
      }
      const continuation = response.headers.get("x-ms-continuation");
      if (continuation !== null && continuation !== "" && (byteLength(continuation) > 16_384 || /[^ -~]/u.test(continuation))) throw new RangeError("Cosmos continuation exceeds the supported header bound");
      const records = result.Documents.map((document) => this.record(op, new Key(source.name, document.__dalgo_id, source.parent), document, source.codec));
      const nextCursor = continuation === null || continuation.length === 0 ? undefined : this.cursorFor(scope, continuation);
      return { records, ...(nextCursor === undefined ? {} : { nextCursor }) };
    });
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    if (typeof callback !== "function") return Promise.reject(new TypeError("transaction callback is required"));
    return Promise.reject(new UnsupportedError("Cosmos DB DALgo callback transactions; Cosmos transactional batches are partition-scoped and cannot preserve callback retry semantics"));
  }

  private documentsPath(): string { return `dbs/${encodeURIComponent(this.#options.databaseId)}/colls/${encodeURIComponent(this.#options.containerId)}/docs`; }
  private documentPath(key: Key): string { this.collectionPath(key.collectionPath); return `${this.documentsPath()}/${storageId(key.id)}`; }
  private collectionPath(value: string): string { if (byteLength(value) > 4096) throw new RangeError("Cosmos collection path exceeds the supported byte bound"); return value; }
  private partition(op: CosmosOperation, collectionPath: string): CosmosPartitionValue {
    this.collectionPath(collectionPath);
    const value: unknown = op.call(() => this.#options.partitionKey(collectionPath));
    if (typeof value === "string" && byteLength(value) > 4096) throw new RangeError("Cosmos partition exceeds the supported byte bound");
    if (!(typeof value === "string" || typeof value === "boolean" || value === null || (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)))) {
      throw new TypeError("partitionKey must return a JSON scalar with a finite non--0 number, or null");
    }
    return value;
  }
  private documentFor(key: Key, partition: CosmosPartitionValue, data: unknown): Record<string, unknown> {
    assertDocument(data);
    return { id: storageId(key.id), __dalgo_collection: key.collectionPath, __dalgo_id: key.id, [this.#options.partitionKeyField]: partition, data };
  }
  private record<T>(op: CosmosOperation, key: Key, document: CosmosDocument, codec?: Codec<T>): ExistingRecord<T> {
    op.check();
    if (document.id !== storageId(key.id) || document.__dalgo_collection !== key.collectionPath || document.__dalgo_id !== key.id) throw new TypeError("Cosmos response document does not match the requested DALgo key");
    assertDocument(document.data);
    return { key, exists: true, data: op.call(() => codecOrIdentity(codec).decode(document.data)), metadata: { ...(document._etag === undefined ? {} : { etag: document._etag }), ...(document._ts === undefined ? {} : { timestamp: document._ts }) } };
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
  private cursorFor(scope: string, continuation: string): QueryCursor {
    const handle = Object.freeze({ adapter: "@dal-go/dalgo2cosmosdb", version: 2 });
    this.#cursors.set(handle, { scope, continuation });
    return { values: [handle] };
  }
  private cursor(cursor: QueryCursor | undefined, scope: string): CursorState | undefined {
    if (cursor === undefined) return undefined;
    if (cursor.values.length !== 1 || !isObject(cursor.values[0])) throw new TypeError("Cosmos startAfter must be a cursor returned by this adapter");
    const state = this.#cursors.get(cursor.values[0]);
    if (state?.scope !== scope) throw new TypeError("Cosmos startAfter must be a cursor returned by this adapter for this query and partition");
    return state;
  }
  private async operation<T>(signal: AbortSignal | undefined, work: (op: CosmosOperation) => T | Promise<T>): Promise<T> {
    const op = new CosmosOperation(signal, this.#options.timeoutMs, this.#options.maxRequestBytes, this.#options.maxResponseBytes);
    let result: T;
    try { op.check(); result = await work(op); op.check(); }
    catch (error: unknown) { op.fail(); op.checkCancellation(); throw error; }
    finally { op.dispose(); }
    // Original caller signal and monotonic elapsed time survive listener cleanup.
    op.check();
    return result;
  }
  private async request(op: CosmosOperation, method: string, resourcePath: string, partition: CosmosPartitionValue, body?: unknown, accepted: readonly number[] = [], extra: Readonly<Record<string, string>> = {}, readBody = true): Promise<{ status: number; body: unknown; headers: Headers; retryAfterMs?: number }> {
    op.check();
    const serialized = body === undefined ? undefined : serializeJson(body);
    if (serialized !== undefined) op.requestBytes(byteLength(serialized));
    const date = new Date().toUTCString();
    const resourceLink = resourcePath.endsWith("/docs") ? resourcePath.slice(0, -5) : resourcePath;
    const authorization = await op.io(() => this.#options.authorization({ method, resourcePath, resourceLink, resourceType: "docs", date, signal: op.signal }));
    if (typeof authorization !== "string" || authorization.trim().length === 0 || byteLength(authorization) > 8192 || /[^\x20-\x7e]/u.test(authorization)) throw new TypeError("authorization provider returned an unsafe header");
    const response = await ownedFetch(op, () => this.#options.fetch(`${this.#options.endpoint}/${resourcePath}`, { method, redirect: "error", signal: op.signal, headers: { accept: "application/json", "x-ms-date": date, "x-ms-version": this.#options.serviceVersion, authorization, "x-ms-documentdb-partitionkey": JSON.stringify([partition]), ...(serialized === undefined ? {} : { "content-type": "application/json" }), ...extra }, ...(serialized === undefined ? {} : { body: serialized }) }));
    let readerOwnsBody = false;
    try {
      boundedHeaders(response.headers);
      const retry = response.headers.get("x-ms-retry-after-ms");
      const retryAfterMs = retry !== null && /^\d+$/u.test(retry) && Number.isSafeInteger(Number(retry)) ? Number(retry) : undefined;
      if (!response.ok && !accepted.includes(response.status)) throw new CosmosHttpError(response.status, retryAfterMs);
      let parsed: unknown;
      // Error/accepted-empty/write responses need no payload or JSON parsing.
      if (readBody && response.ok) {
        readerOwnsBody = true;
        const text = await responseText(response, op);
        try { parsed = text.length === 0 ? undefined : JSON.parse(text); }
        catch { throw new TypeError("malformed Cosmos JSON response"); }
        if (parsed !== undefined) assertJsonValue(parsed);
      }
      op.check();
      return { status: response.status, body: parsed, headers: response.headers, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
    } finally { if (!readerOwnsBody) discardBody(response); }
  }
}
