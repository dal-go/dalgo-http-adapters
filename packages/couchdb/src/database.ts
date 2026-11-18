import { readBatch } from "./batch.js";
import type { CouchDbOperation } from "./operation.js";
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
  type QueryCursor,
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
  byteLength,
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
  /** Aggregate decoded response bytes for the entire ordered getMany call. */
  readonly maxGetManyBytes?: number;
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
interface ManagedCursor { readonly query: string; readonly bookmark: string; }

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
  if (byteLength(key.collectionPath) > 4096 || (typeof key.id === "string" && byteLength(key.id) > 4096)) throw new RangeError("CouchDB managed key exceeds the supported byte bound");
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
  readonly #cursors = new Map<object, ManagedCursor>();
  readonly #maxGetManyBytes: number;
  readonly #maxGetManyKeys: number;
  readonly #maxParallelReads: number;
  readonly #maxQueryLimit: number;

  public constructor(options: CouchDbDatabaseOptions) {
    this.#transport = new CouchDbTransport(options);
    this.#maxGetManyBytes = positive(options.maxGetManyBytes, 1_048_576, "maxGetManyBytes");
    this.#maxGetManyKeys = positive(options.maxGetManyKeys, DEFAULT_MAX_GET_MANY, "maxGetManyKeys", 1_000);
    this.#maxParallelReads = positive(options.maxParallelReads, Math.min(DEFAULT_MAX_PARALLEL_READS, this.#maxGetManyKeys), "maxParallelReads", this.#maxGetManyKeys);
    this.#maxQueryLimit = positive(options.maxQueryLimit, DEFAULT_MAX_QUERY_LIMIT, "maxQueryLimit", 1_000);
  }

  public get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> { return this.getWithSignal(key, undefined, codec); }

  public getWithSignal<T>(key: Key, signal: AbortSignal | undefined, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    return this.#transport.within(signal, (op) => this.readOne(op, key, codec));
  }

  private async readOne<T>(op: CouchDbOperation, key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const raw = await this.rawGet(key, op);
    op.check();
    return raw === undefined ? { key, exists: false } : { key, exists: true, data: op.call(() => codecOrIdentity(codec).decode(raw.data)), metadata: metadata(raw) };
  }

  public getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> { return this.getManyWithSignal(keys, undefined, codec); }

  public getManyWithSignal<T>(keys: readonly Key[], signal: AbortSignal | undefined, codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    return this.#transport.within(signal, (op) => {
      if (keys.length > this.#maxGetManyKeys) throw new UnsupportedError(`CouchDB getMany above maxGetManyKeys (${String(this.#maxGetManyKeys)})`);
      const admitted = keys.slice();
      for (const key of admitted) { op.check(); storageId(key); }
      return readBatch(admitted, this.#maxParallelReads, op, (key) => this.readOne(op, key, codec));
    }, this.#maxGetManyBytes, () => new RangeError("CouchDB getMany exceeds maxGetManyBytes"));
  }

  public insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    return this.#transport.within(undefined, async (op) => {
      const body = this.document(key, op.call(() => codecOrIdentity(codec).encode(data)));
      const response = await this.#transport.request("PUT", `/${encodeURIComponent(storageId(key))}`, body, [409], {}, op.signal, undefined, undefined, op);
      if (response.status === 409) throw new AlreadyExistsError(key, { cause: new CouchDbHttpError(409) });
    });
  }

  public set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    return this.#transport.within(undefined, async (op) => {
      const existing = await this.rawGet(key, op);
      const body = { ...this.document(key, op.call(() => codecOrIdentity(codec).encode(data))), ...(existing === undefined ? {} : { _rev: existing._rev }) };
      const response = await this.#transport.request("PUT", `/${encodeURIComponent(storageId(key))}`, body, [409], {}, op.signal, undefined, undefined, op);
      if (response.status === 409) throw new CouchDbConflictError(key);
    });
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    void key; void data;
    throw new UnsupportedError("CouchDB DALgo partial update");
  }

  public delete(key: Key): Promise<void> {
    return this.#transport.within(undefined, async (op) => {
      const existing = await this.rawGet(key, op);
      if (existing === undefined) return;
      const response = await this.#transport.request("DELETE", `/${encodeURIComponent(storageId(key))}`, undefined, [409], { "if-match": existing._rev }, op.signal, undefined, undefined, op);
      if (response.status === 409) throw new CouchDbConflictError(key);
    });
  }

  public query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> { return this.queryWithSignal(query, undefined); }

  public queryWithSignal<T>(query: StructuredQuery<T>, signal: AbortSignal | undefined): Promise<QueryPage<T>> {
    return this.#transport.within(signal, async (op) => {
      const plan = this.prepareQuery(query);
      const response = await this.#transport.request("POST", "/_find", plan.body, [], {}, op.signal, undefined, undefined, op);
      return this.queryPage(query, plan.limit, plan.binding, response, op, plan.bookmark);
    });
  }

  private prepareQuery<T>(query: StructuredQuery<T>): { readonly body: Record<string, unknown>; readonly limit: number; readonly binding: string; readonly bookmark: string | undefined } {
    if (query.filters.length > 64) throw new UnsupportedError("CouchDB managed queries support at most64 filters");
    if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("CouchDB collection-group or nested collection queries");
    if (query.orders.length > 0 || query.offset !== undefined || query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("CouchDB ordered, offset, or inclusive/end cursor queries");
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) throw new UnsupportedError(`CouchDB query limit must be a safe integer from 1 to ${String(this.#maxQueryLimit)}`);
    const limit = query.limit ?? this.#maxQueryLimit;
    if (limit > this.#maxQueryLimit) throw new UnsupportedError(`CouchDB query limit above maxQueryLimit (${String(this.#maxQueryLimit)})`);
    const base = { selector: { $and: [{ __dalgo_collection: { $eq: query.source.name } }, ...query.filters.map((filter) => selectorFilter(filter))] }, limit };
    assertJson(base);
    const binding = JSON.stringify(base);
    let bookmark: string | undefined;
    if (query.startAfter !== undefined) {
      const cursor = query.startAfter.values[0];
      if (!isObject(cursor) || query.startAfter.values.length !== 1) throw new TypeError("CouchDB query cursor must be returned by this adapter");
      const state = this.#cursors.get(cursor);
      if (state === undefined || state.query !== binding) throw new TypeError("CouchDB query cursor must be returned by this adapter for this query and page size");
      bookmark = state.bookmark;
    }
    return { body: { ...base, ...(bookmark === undefined ? {} : { bookmark }) }, limit, binding, bookmark };
  }

  private queryPage<T>(query: StructuredQuery<T>, limit: number, binding: string, response: { readonly status: number; readonly body: unknown }, op: CouchDbOperation, incomingBookmark: string | undefined): QueryPage<T> {
    if (query.source.kind !== "collection") throw new UnsupportedError("CouchDB collection-group queries");
    const source = query.source;
    if (!isObject(response.body) || !Array.isArray(response.body.docs) || (response.body.bookmark !== undefined && typeof response.body.bookmark !== "string")) throw new TypeError("malformed CouchDB Mango response");
    const mango = response.body as unknown as MangoResponse;
    if (mango.docs.length > limit) throw new RangeError("CouchDB response returned more rows than the requested query limit");
    const seen = new Set<string>();
    const valid = mango.docs.map((document) => {
      op.check();
      if (!isObject(document)) throw new TypeError("malformed CouchDB DALgo document");
      keyId(document.__dalgo_id);
      const key = new Key(source.name, document.__dalgo_id);
      const raw = couchDocument(document, key);
      if (seen.has(raw._id)) throw new TypeError("CouchDB response returned duplicate managed document identities");
      seen.add(raw._id); validateData(raw.data);
      return { key, raw };
    });
    const bookmark = mango.bookmark;
    if (bookmark !== undefined && (bookmark.length === 0 || bookmark.length > 16_384)) throw new RangeError("CouchDB Mango bookmark exceeds the supported bound");
    if (valid.length === limit && incomingBookmark !== undefined && bookmark === incomingBookmark) throw new TypeError("CouchDB Mango bookmark did not advance");
    if (valid.length === limit && bookmark !== undefined && byteLength(binding) > 16_384) throw new RangeError("CouchDB managed cursor query binding exceeds the supported bound");
    const records = valid.map(({ key, raw }): ExistingRecord<T> => ({ key, exists: true, data: op.call(() => codecOrIdentity(source.codec).decode(raw.data)), metadata: metadata(raw) }));
    let nextCursor: QueryCursor | undefined;
    if (records.length === limit && bookmark !== undefined) {
      const handle = Object.freeze({ adapter: "@dalgo/dalgo2couchdb", version: 2 });
      op.beforeDelivery(() => {
        while (this.#cursors.size >= 1000) { const first = this.#cursors.keys().next().value; if (first === undefined) break; this.#cursors.delete(first); }
        this.#cursors.set(handle, { query: binding, bookmark });
      });
      nextCursor = { values: [handle] };
    }
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

  private async rawGet(key: Key, op: CouchDbOperation): Promise<CouchDocument | undefined> {
    op.check();
    const response = await this.#transport.request("GET", `/${encodeURIComponent(storageId(key))}`, undefined, [404], {}, op.signal, undefined, undefined, op);
    if (response.status === 404) return undefined;
    const document = couchDocument(response.body, key); validateData(document.data);
    return document;
  }
}
