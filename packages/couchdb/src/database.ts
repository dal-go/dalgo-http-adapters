import { QueryCancelledError } from "@dalgo/adapter-runtime";
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
} from "@dalgo/core";

import {
  CouchDbHttpError,
  CouchDbTransport,
  assertJson,
  isObject,
  isPlainObject,
  positive,
  type CouchDbFetch,
  type CouchDbHeaderProvider,
} from "./transport.js";

export { CouchDbHttpError, CouchDbRequestError } from "./transport.js";
export type { CouchDbFetch, CouchDbHeaders, CouchDbHeaderProvider } from "./transport.js";

const DEFAULT_MAX_GET_MANY = 100;
const DEFAULT_MAX_PARALLEL_READS = 8;
const DEFAULT_MAX_QUERY_LIMIT = 100;

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

/** A 409 returned while applying an explicit document revision. */
export class CouchDbConflictError extends Error {
  public readonly key: Key;
  public constructor(key: Key) {
    super(`CouchDB MVCC conflict for record: ${key.path}`);
    this.name = "CouchDbConflictError";
    this.key = key;
  }
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }

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
  readonly #transport: CouchDbTransport;
  readonly #databaseUrl: string;
  readonly #maxGetManyKeys: number;
  readonly #maxParallelReads: number;
  readonly #maxQueryLimit: number;

  public constructor(options: CouchDbDatabaseOptions) {
    this.#transport = new CouchDbTransport(options);
    this.#databaseUrl = this.#transport.databaseUrl;
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
    const response = await this.#transport.request("PUT", `/${encodeURIComponent(storageId(key))}`, body, [409]);
    if (response.status === 409) throw new AlreadyExistsError(key, { cause: new CouchDbHttpError(409) });
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const existing = await this.rawGet(key);
    const body = { ...this.document(key, codecOrIdentity(codec).encode(data)), ...(existing === undefined ? {} : { _rev: existing._rev }) };
    const response = await this.#transport.request("PUT", `/${encodeURIComponent(storageId(key))}`, body, [409]);
    if (response.status === 409) throw new CouchDbConflictError(key);
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    void key; void data;
    throw new UnsupportedError("CouchDB DALgo partial update");
  }

  public async delete(key: Key): Promise<void> {
    const existing = await this.rawGet(key);
    if (existing === undefined) return;
    const response = await this.#transport.request("DELETE", `/${encodeURIComponent(storageId(key))}`, undefined, [409], { "if-match": existing._rev });
    if (response.status === 409) throw new CouchDbConflictError(key);
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    const plan = this.prepareQuery(query);
    const response = await this.#transport.request("POST", "/_find", plan.body);
    return this.queryPage(query, plan.limit, response);
  }

  /**
   * Cancellable query entry point. The caller signal covers header acquisition,
   * fetch and response-body reading, and shares one deadline with `query`.
   */
  public async queryWithSignal<T>(query: StructuredQuery<T>, signal: AbortSignal): Promise<QueryPage<T>> {
    if (signal.aborted) throw new QueryCancelledError("caller");
    const plan = this.prepareQuery(query);
    const response = await this.#transport.request("POST", "/_find", plan.body, [], {}, signal);
    if (signal.aborted) throw new QueryCancelledError("caller");
    return this.queryPage(query, plan.limit, response);
  }

  private prepareQuery<T>(query: StructuredQuery<T>): { readonly body: Record<string, unknown>; readonly limit: number } {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("CouchDB collection-group or nested collection queries");
    if (query.orders.length > 0 || query.offset !== undefined || query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("CouchDB ordered, offset, or inclusive/end cursor queries");
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) throw new UnsupportedError(`CouchDB query limit must be a safe integer from 1 to ${String(this.#maxQueryLimit)}`);
    const limit = query.limit ?? this.#maxQueryLimit;
    if (limit > this.#maxQueryLimit) throw new UnsupportedError(`CouchDB query limit above maxQueryLimit (${String(this.#maxQueryLimit)})`);
    let bookmark: string | undefined;
    if (query.startAfter !== undefined) {
      const cursor = query.startAfter.values[0];
      if (!isObject(cursor) || cursor.adapter !== "@dal-go/dalgo2couchdb" || cursor.version !== 1 || cursor.databaseUrl !== this.#databaseUrl || typeof cursor.bookmark !== "string" || query.startAfter.values.length !== 1) throw new TypeError("CouchDB query cursor must be returned by this adapter");
      bookmark = cursor.bookmark;
    }
    const body = { selector: { $and: [{ __dalgo_collection: { $eq: query.source.name } }, ...query.filters.map((filter) => selectorFilter(filter))] }, limit, ...(bookmark === undefined ? {} : { bookmark }) };
    return { body, limit };
  }

  private queryPage<T>(query: StructuredQuery<T>, limit: number, response: { readonly status: number; readonly body: unknown }): QueryPage<T> {
    if (!isObject(response.body) || !Array.isArray(response.body.docs) || (response.body.bookmark !== undefined && typeof response.body.bookmark !== "string")) throw new TypeError("malformed CouchDB Mango response");
    const mango = response.body as unknown as MangoResponse;
    if (mango.docs.length > limit) throw new RangeError("CouchDB response returned more rows than the requested query limit");
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
    const response = await this.#transport.request("GET", `/${encodeURIComponent(storageId(key))}`, undefined, [404]);
    return response.status === 404 ? undefined : couchDocument(response.body, key);
  }
}
