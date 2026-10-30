import { QueryCancelledError, createAbortScope } from "@dalgo/adapter-runtime";
import {
  DOCUMENT_ID,
  Key,
  UnsupportedError,
  identityCodec,
  type Codec,
  type Database,
  type ExistingRecord,
  type OrderDirection,
  type QueryFilter,
  type QueryPage,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
} from "@dalgo/core";

import {
  CouchDbHttpError,
  CouchDbRequestError,
  CouchDbResponseSizeError,
  CouchDbTransport,
  assertJson,
  isObject,
  isPlainObject,
  positive,
  type CouchDbFetch,
  type CouchDbHeaderProvider,
  type CouchDbHeaders,
} from "./transport.js";
import { NATIVE_COUCHDB_READ_CAPABILITIES } from "./capabilities.js";

const DEFAULT_MAX_GET_MANY = 100;
const DEFAULT_MAX_PARALLEL_READS = 8;
const DEFAULT_MAX_GET_MANY_BYTES = 1_048_576;
const DEFAULT_MAX_QUERY_LIMIT = 100;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_METADATA_BYTES = 262_144;
const DEFAULT_MAX_SAMPLE_DOCUMENTS = 20;
const DEFAULT_MAX_INDEXES = 100;
const MAX_BOOKMARK_CHARS = 16_384;
const MAX_ISSUED_CURSORS = 1_000;
const MAX_CONSERVED_CURSORS = 1_000;
const MAX_KEY_CHARS = 1_024;
const CURSOR_TOKEN = /^nc1_[A-Za-z0-9_-]{43}$/u;

const ID_FIELD = "_id";
const REV_FIELD = "_rev";
const SIMPLE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SIMPLE_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;
const DESIGN_DOCUMENT = /^_design\/[A-Za-z0-9._-]+$/u;

export type NativeCouchDbFetch = CouchDbFetch;
export type NativeCouchDbHeaders = CouchDbHeaders;
export type NativeCouchDbHeaderProvider = CouchDbHeaderProvider;

export interface NativeCouchDbIndexField {
  /** A simple top-level document field or the `_id` tie-break field. */
  readonly field: string;
  readonly direction: OrderDirection;
}

/**
 * One CouchDB Mango JSON index the adapter may use for an ordered query.
 *
 * `fields` must exactly match the query order, including the final `_id`
 * tie-break field. The adapter never guesses an index or silently falls back to
 * a primary-index scan for an ordered query.
 */
export interface NativeCouchDbIndex {
  /** Design document id, for example `_design/status-id`. */
  readonly ddoc: string;
  /** Index name inside that design document. */
  readonly name: string;
  readonly fields: readonly NativeCouchDbIndexField[];
}

export interface NativeCouchDbDatabaseOptions {
  /**
   * An HTTPS URL naming one existing CouchDB database, or a deliberate loopback
   * HTTP URL for local development. Credentials, queries and fragments are
   * refused.
   */
  readonly databaseUrl: string;
  /**
   * The one logical DALgo collection this database is configured to expose.
   * The adapter does not infer or enumerate other collections.
   */
  readonly collection: string;
  /** Re-evaluated for every request, for safely refreshed bearer/cookie headers. */
  readonly headers?: NativeCouchDbHeaderProvider;
  readonly fetch?: NativeCouchDbFetch;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxGetManyKeys?: number;
  readonly maxParallelReads?: number;
  /**
   * Cumulative decoded response bytes one `getMany` batch may retain. A batch
   * that would exceed it fails without returning a partial result.
   */
  readonly maxGetManyBytes?: number;
  readonly maxQueryLimit?: number;
  readonly maxMetadataBytes?: number;
  readonly maxSampleDocuments?: number;
  readonly maxIndexes?: number;
  /** Explicit Mango indexes ordered queries may use. */
  readonly permittedIndexes?: readonly NativeCouchDbIndex[];
  /**
   * Explicit top-level fields to report instead of bounded `_all_docs`
   * sampling. This is a label, not a schema claim.
   */
  readonly configuredFields?: readonly string[];
  /**
   * Stable, non-secret identifier for the credential/session scope of a
   * paginated query. When omitted, the adapter binds cursors to a digest of the
   * headers actually used for the query.
   */
  readonly cursorScope?: string;
}

/**
 * A core `StructuredQuery` plus an optional native Mango projection.
 *
 * A projection must explicitly include `_id`; CouchDB omits it otherwise and
 * the adapter would not be able to preserve a native string `_id` as `Key.id`.
 */
export interface NativeCouchDbQuery<T> extends StructuredQuery<T> {
  readonly projection?: readonly string[];
}

export type NativeCouchDbMetadataFailure =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "unavailable"
  | "malformed";

export interface NativeCouchDbDatabaseInfo {
  readonly database: string;
  readonly documentCount: number;
  readonly deletedDocumentCount: number;
  readonly updateSequence: string | number;
  readonly compactRunning: boolean | null;
  readonly sizes: {
    readonly active: number;
    readonly external: number;
    readonly file: number;
  } | null;
}

export type NativeCouchDbConnectionTest =
  | {
    readonly ok: true;
    readonly collection: string;
    readonly database: NativeCouchDbDatabaseInfo;
  }
  | {
    readonly ok: false;
    readonly collection: string;
    readonly reason: NativeCouchDbMetadataFailure;
    readonly httpStatus?: number;
  };

export interface NativeCouchDbDiscoveredIndexField {
  readonly field: string;
  /** `null` for a non-JSON text/nouveau field where no Mango sort direction applies. */
  readonly direction: OrderDirection | null;
  readonly type?: string;
}

export interface NativeCouchDbDiscoveredIndex {
  readonly ddoc: string | null;
  readonly name: string;
  readonly type: string;
  readonly fields: readonly NativeCouchDbDiscoveredIndexField[];
  readonly partial: boolean;
  readonly partitioned: boolean | null;
}

export type NativeCouchDbIndexDiscovery =
  | {
    readonly status: "available";
    readonly total: number;
    readonly indexes: readonly NativeCouchDbDiscoveredIndex[];
  }
  | {
    readonly status: "unavailable";
    readonly reason: NativeCouchDbMetadataFailure;
    readonly httpStatus?: number;
  };

export type NativeCouchDbFieldDiscovery =
  | {
    readonly status: "configured";
    readonly fields: readonly string[];
  }
  | {
    readonly status: "sampled";
    readonly fields: readonly string[];
    readonly sampleSize: number;
    readonly truncated: boolean;
  }
  | {
    readonly status: "unavailable";
    readonly reason: NativeCouchDbMetadataFailure;
    readonly httpStatus?: number;
  };

export interface NativeCouchDbDescribe {
  readonly adapter: "@dalgo/dalgo2couchdb";
  readonly storage: "native-rows";
  readonly readOnly: true;
  readonly resource: {
    readonly database: string;
    readonly collection: string;
  };
  readonly database: NativeCouchDbConnectionTest;
  readonly indexes: NativeCouchDbIndexDiscovery;
  readonly fields: NativeCouchDbFieldDiscovery;
  readonly limits: {
    readonly maxGetManyKeys: number;
    readonly maxGetManyBytes: number;
    readonly maxParallelReads: number;
    readonly maxQueryLimit: number;
    readonly maxRequestBytes: number;
    readonly maxResponseBytes: number;
    readonly maxMetadataBytes: number;
    readonly maxSampleDocuments: number;
    readonly maxIndexes: number;
    readonly maxIssuedCursors: number;
    readonly maxConservedCursors: number;
  };
}

interface NativeCursorBinding {
  /** Query/filter/sort/projection/page-size fingerprint. */
  readonly query: string;
  /** Credential-scope digest; a grouping key, never an authentication claim. */
  readonly scope: string;
  readonly limit: number;
  readonly bookmark: string;
}

interface NativeQueryPlan {
  readonly selector: Readonly<Record<string, unknown>>;
  readonly sort: readonly Readonly<Record<string, OrderDirection>>[] | undefined;
  readonly useIndex: readonly [string, string] | undefined;
  readonly projection: readonly string[] | undefined;
  readonly limit: number;
  readonly fingerprint: string;
}

interface NativeFilterTerm {
  readonly field: string;
  readonly operator: QueryFilter<unknown>["operator"];
  readonly value: unknown;
}

/**
 * Adapter-owned cumulative `getMany` response bound failure. The message is a
 * fixed diagnostic and contains no keys, values or credentials.
 */
export class CouchDbBatchSizeError extends RangeError {
  public constructor() {
    super("CouchDB getMany responses exceed maxGetManyBytes");
    this.name = "CouchDbBatchSizeError";
  }
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }

function controlFree(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function assertCollection(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || !controlFree(value) || value.includes("/")) {
    throw new TypeError("Native CouchDB collection must be one non-empty logical collection name, without a path");
  }
  return value;
}

function assertKey(key: Key, collection: string): asserts key is Key<string> {
  if (key.parent !== undefined) throw new UnsupportedError("Native CouchDB nested collection keys");
  if (key.collection !== collection) throw new UnsupportedError(`Native CouchDB database is configured for collection ${collection}`);
  if (typeof key.id !== "string") throw new TypeError("Native CouchDB keys require a string CouchDB _id");
  if (key.id.length === 0 || key.id.length > MAX_KEY_CHARS || !controlFree(key.id)) throw new TypeError("Native CouchDB _id must be a non-empty, bounded, control-free string");
  if (key.id === "." || key.id === "..") throw new TypeError("Native CouchDB _id must not be a URL dot segment");
  if (key.id.startsWith("_")) throw new UnsupportedError("Native CouchDB design/local metadata documents");
}

function nativeFilterField(field: unknown): string {
  const name = field === DOCUMENT_ID ? ID_FIELD : String(field);
  if (name === ID_FIELD || name === REV_FIELD) return name;
  if (!SIMPLE_FIELD.test(name)) throw new UnsupportedError("Native CouchDB non-simple filter field paths");
  if (name.startsWith("_")) throw new UnsupportedError("Native CouchDB reserved filter fields");
  return name;
}

function nativeOrderField(field: unknown): string {
  const name = field === DOCUMENT_ID ? ID_FIELD : String(field);
  if (name === ID_FIELD) return name;
  if (!SIMPLE_FIELD.test(name)) throw new UnsupportedError("Native CouchDB non-simple or reserved sort field paths");
  if (name.startsWith("_")) throw new UnsupportedError("Native CouchDB reserved sort fields");
  if (name === REV_FIELD) throw new UnsupportedError("Native CouchDB _rev sorting");
  return name;
}

function filterTerm<T>(filter: QueryFilter<T>): NativeFilterTerm {
  const field = nativeFilterField(filter.field);
  if (filter.value === undefined) throw new UnsupportedError("Native CouchDB undefined query filters");
  switch (filter.operator) {
    case "==":
    case "!=":
    case "<":
    case "<=":
    case ">":
    case ">=":
      assertJson(filter.value);
      break;
    case "in":
    case "not-in":
      if (!Array.isArray(filter.value)) throw new TypeError(`Native CouchDB ${filter.operator} filters require an array`);
      assertJson(filter.value);
      break;
    default:
      throw new UnsupportedError(`Native CouchDB ${filter.operator} filters`);
  }
  if (filter.value === null && filter.operator !== "==" && filter.operator !== "!=") {
    throw new UnsupportedError(`Native CouchDB ${filter.operator} null query filters`);
  }
  return { field, operator: filter.operator, value: filter.value };
}

/**
 * Mango `$eq: null` matches an explicit JSON null only; missing fields do not
 * participate. Likewise `$ne`/`$nin` require the field to exist. This is the
 * faithful NULL/missing split CouchDB documents and is not rewritten here.
 */
function filterSelector(term: NativeFilterTerm): Record<string, unknown> {
  const operator = term.operator;
  if (term.value === null) {
    if (operator === "==") return { [term.field]: { $eq: null } };
    if (operator === "!=") return { [term.field]: { $ne: null } };
  }
  switch (operator) {
    case "==": return { [term.field]: { $eq: term.value } };
    case "!=": return { [term.field]: { $ne: term.value } };
    case "<": return { [term.field]: { $lt: term.value } };
    case "<=": return { [term.field]: { $lte: term.value } };
    case ">": return { [term.field]: { $gt: term.value } };
    case ">=": return { [term.field]: { $gte: term.value } };
    case "in": return { [term.field]: { $in: term.value } };
    case "not-in": return { [term.field]: { $nin: term.value } };
    default: throw new UnsupportedError(`Native CouchDB ${String(operator)} filters`);
  }
}

function projectionField(field: unknown): string {
  if (typeof field !== "string" || field.length === 0 || field.length > 512 || !controlFree(field)) throw new TypeError("Native CouchDB projection fields must be bounded strings");
  if (field === ID_FIELD || field === REV_FIELD) return field;
  if (!SIMPLE_PATH.test(field) || field.startsWith("_")) throw new UnsupportedError("Native CouchDB projection fields must be simple top-level or dotted application fields, plus _id/_rev");
  return field;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("Native CouchDB cursor values must be finite JSON numbers");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new TypeError("Native CouchDB cursor values must be plain JSON");
}

function digest(secret: string, value: string): string {
  let hash = 0xcbf29ce484222325n;
  const encoded = new TextEncoder().encode(`${secret}:${value}`);
  for (const byte of encoded) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function randomId(): string {
  const crypto = globalThis.crypto;
  if (crypto !== undefined && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let result = "";
  while (result.length < 32) result += Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, "0");
  return result.slice(0, 32);
}

/**
 * An unguessable, adapter-owned cursor handle. The complete handle is the
 * registry key, so a cursor cannot carry a mutable, unauthenticated payload.
 */
function randomCursorToken(): string {
  const crypto = globalThis.crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== "function") {
    throw new Error("Native CouchDB cursors require crypto.getRandomValues");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `nc1_${btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=/gu, "")}`;
}

function positiveJsonInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`malformed CouchDB ${field}`);
  return value;
}

function failureFor(error: unknown): { readonly reason: NativeCouchDbMetadataFailure; readonly httpStatus?: number } {
  if (error instanceof CouchDbHttpError) {
    const reason = error.status === 401 ? "unauthorized" : error.status === 403 ? "forbidden" : error.status === 404 ? "not-found" : "unavailable";
    return { reason, httpStatus: error.status };
  }
  if (error instanceof CouchDbRequestError || error instanceof CouchDbResponseSizeError) return { reason: "unavailable" };
  if (error instanceof TypeError) return { reason: "malformed" };
  return { reason: "unavailable" };
}

function failureForStatus(status: number): { readonly reason: NativeCouchDbMetadataFailure; readonly httpStatus: number } {
  const reason = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not-found" : "unavailable";
  return { reason, httpStatus: status };
}

/**
 * Read-only adapter for pre-existing CouchDB application documents.
 *
 * One configured CouchDB database maps to exactly one configured logical DALgo
 * collection. Documents keep their native `_id`/`_rev` and are never rewritten
 * into a DALgo envelope. Every mutation entry point refuses. This class
 * deliberately does not implement the `WriteSession` contract; its package
 * capabilities say `storage: "native-rows"`.
 */
export class NativeCouchDbDatabase implements Database {
  public readonly readOnly = true as const;

  readonly #transport: CouchDbTransport;
  readonly #collection: string;
  readonly #databaseName: string;
  readonly #maxGetManyKeys: number;
  readonly #maxParallelReads: number;
  readonly #maxGetManyBytes: number;
  readonly #maxQueryLimit: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxMetadataBytes: number;
  readonly #maxSampleDocuments: number;
  readonly #maxIndexes: number;
  readonly #permittedIndexes: readonly NativeCouchDbIndex[];
  readonly #configuredFields: readonly string[] | undefined;
  readonly #cursorScope: string | undefined;
  readonly #cursorSecret: string;
  readonly #issuedCursors = new Map<string, NativeCursorBinding>();
  readonly #activeCursors = new Set<string>();
  readonly #consumedCursors = new Map<string, true>();

  public constructor(options: NativeCouchDbDatabaseOptions) {
    this.#transport = new CouchDbTransport(options);
    const url = new URL(this.#transport.databaseUrl);
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length !== 1) throw new TypeError("Native CouchDB databaseUrl must name exactly one existing application database");
    const databaseName = decodeURIComponent(segments[0] ?? "");
    if (databaseName.length === 0 || databaseName.startsWith("_") || !controlFree(databaseName)) throw new TypeError("Native CouchDB databaseUrl must name one application database, not a management endpoint");
    this.#databaseName = databaseName;
    this.#collection = assertCollection(options.collection);
    this.#maxGetManyKeys = positive(options.maxGetManyKeys, DEFAULT_MAX_GET_MANY, "maxGetManyKeys", 1_000);
    this.#maxParallelReads = positive(options.maxParallelReads, Math.min(DEFAULT_MAX_PARALLEL_READS, this.#maxGetManyKeys), "maxParallelReads", this.#maxGetManyKeys);
    this.#maxGetManyBytes = positive(options.maxGetManyBytes, DEFAULT_MAX_GET_MANY_BYTES, "maxGetManyBytes");
    this.#maxQueryLimit = positive(options.maxQueryLimit, DEFAULT_MAX_QUERY_LIMIT, "maxQueryLimit", 1_000);
    this.#maxRequestBytes = positive(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, "maxRequestBytes");
    this.#maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
    this.#maxMetadataBytes = positive(options.maxMetadataBytes, DEFAULT_MAX_METADATA_BYTES, "maxMetadataBytes");
    this.#maxSampleDocuments = positive(options.maxSampleDocuments, DEFAULT_MAX_SAMPLE_DOCUMENTS, "maxSampleDocuments", 1_000);
    this.#maxIndexes = positive(options.maxIndexes, DEFAULT_MAX_INDEXES, "maxIndexes", 10_000);
    const permittedIndexes = options.permittedIndexes ?? [];
    if (permittedIndexes.length > 100) throw new TypeError("permittedIndexes must contain at most 100 indexes");
    this.#permittedIndexes = Object.freeze(permittedIndexes.map((index) => this.freezeIndex(index)));
    if (options.configuredFields !== undefined && (options.configuredFields.length === 0 || options.configuredFields.length > 1_000)) throw new TypeError("configuredFields must contain from 1 to 1000 fields");
    const configuredFields = options.configuredFields?.map((field) => projectionField(field));
    if (configuredFields !== undefined && new Set(configuredFields).size !== configuredFields.length) throw new TypeError("configuredFields must be unique");
    this.#configuredFields = configuredFields === undefined ? undefined : Object.freeze(configuredFields);
    if (options.cursorScope !== undefined) {
      if (options.cursorScope.length === 0 || options.cursorScope.length > 1_024 || !controlFree(options.cursorScope)) throw new TypeError("cursorScope must be a non-empty, bounded, control-free string");
    }
    this.#cursorScope = options.cursorScope;
    this.#cursorSecret = randomId();
  }

  public get capabilities() { return NATIVE_COUCHDB_READ_CAPABILITIES; }

  public get collection(): string { return this.#collection; }
  public get databaseName(): string { return this.#databaseName; }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    assertKey(key, this.#collection);
    const { snapshot } = await this.readOne(key, codec, new AbortController().signal);
    return snapshot;
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    return this.readMany(keys, undefined, codec);
  }

  /**
   * Cancellable native batch read. One deadline and one abort scope cover every
   * key, headers and response body. The first failure aborts in-flight siblings
   * and prevents any later key from being requested.
   */
  public async getManyWithSignal<T>(keys: readonly Key[], signal: AbortSignal, codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (signal.aborted) throw new QueryCancelledError("caller");
    return this.readMany(keys, signal, codec);
  }

  private async readOne<T>(key: Key, codec: Codec<T> | undefined, signal: AbortSignal): Promise<{ readonly snapshot: RecordSnapshot<T>; readonly bytes: number }> {
    assertKey(key, this.#collection);
    const response = await this.#transport.request("GET", `/${encodeURIComponent(key.id)}`, undefined, [404], {}, signal);
    if (response.status === 404) return { snapshot: { key, exists: false }, bytes: response.bytes };
    return { snapshot: this.recordDocument(response.body, key, codec), bytes: response.bytes };
  }

  private async readMany<T>(keys: readonly Key[], callerSignal: AbortSignal | undefined, codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#maxGetManyKeys) throw new UnsupportedError(`Native CouchDB getMany above maxGetManyKeys (${String(this.#maxGetManyKeys)})`);
    for (const key of keys) assertKey(key, this.#collection);
    const results: RecordSnapshot<T>[] = new Array(keys.length);
    if (keys.length === 0) return results;

    const deadline = createAbortScope(callerSignal, this.#transport.timeoutMs);
    const batch = new AbortController();
    const forwardAbort = (): void => { batch.abort(); };
    if (deadline.signal.aborted) batch.abort();
    else deadline.signal.addEventListener("abort", forwardAbort, { once: true });
    const signal = batch.signal;
    let failure: { readonly error: unknown } | undefined;
    let acceptedBytes = 0;
    let next = 0;
    const stop = (error: unknown): void => {
      if (failure !== undefined) return;
      failure = { error };
      batch.abort();
    };
    const worker = async (): Promise<void> => {
      for (;;) {
        if (failure !== undefined || signal.aborted) return;
        const index = next;
        next += 1;
        const key = keys[index];
        if (key === undefined) return;
        try {
          const { snapshot, bytes } = await this.readOne(key, codec, signal);
          // A late sibling result must never join a batch that already failed.
          if (failure !== undefined || signal.aborted) return;
          if (acceptedBytes + bytes > this.#maxGetManyBytes) { stop(new CouchDbBatchSizeError()); return; }
          acceptedBytes += bytes;
          results[index] = snapshot;
        } catch (error) {
          stop(error);
          return;
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(this.#maxParallelReads, keys.length) }, () => worker()));
      if (deadline.signal.aborted) {
        throw new QueryCancelledError(deadline.callerAborted ? "caller" : "deadline");
      }
      if (failure !== undefined) throw failure.error;
      return results;
    } finally {
      deadline.signal.removeEventListener("abort", forwardAbort);
      deadline.dispose();
    }
  }

  public async query<T>(query: NativeCouchDbQuery<T>): Promise<QueryPage<T>> {
    return this.runQuery(query, undefined);
  }

  /**
   * Cancellable native query. The caller signal and one deadline cover header
   * acquisition, Mango fetch, response-body reading and every continuation.
   */
  public async queryWithSignal<T>(query: NativeCouchDbQuery<T>, signal: AbortSignal): Promise<QueryPage<T>> {
    if (signal.aborted) throw new QueryCancelledError("caller");
    return this.runQuery(query, signal);
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    void callback;
    return Promise.reject(new UnsupportedError("Native CouchDB mode is read-only: callback transactions"));
  }

  public insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    void key; void data; void codec;
    return Promise.reject(new UnsupportedError("Native CouchDB mode is read-only: insert"));
  }

  public set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    void key; void data; void codec;
    return Promise.reject(new UnsupportedError("Native CouchDB mode is read-only: set"));
  }

  public update(key: Key, data: UpdateData): Promise<void> {
    void key; void data;
    return Promise.reject(new UnsupportedError("Native CouchDB mode is read-only: update"));
  }

  public delete(key: Key): Promise<void> {
    void key;
    return Promise.reject(new UnsupportedError("Native CouchDB mode is read-only: delete"));
  }

  public async testConnection(signal?: AbortSignal): Promise<NativeCouchDbConnectionTest> {
    try {
      const info = await this.databaseInfo(signal);
      return { ok: true, collection: this.#collection, database: info };
    } catch (error) {
      if (error instanceof QueryCancelledError) throw error;
      return { ok: false, collection: this.#collection, ...failureFor(error) };
    }
  }

  public async listIndexes(signal?: AbortSignal): Promise<NativeCouchDbIndexDiscovery> {
    try {
      return await this.discoverIndexes(signal);
    } catch (error) {
      if (error instanceof QueryCancelledError || error instanceof RangeError) throw error;
      return { status: "unavailable", ...failureFor(error) };
    }
  }

  public async sampleFields(signal?: AbortSignal): Promise<NativeCouchDbFieldDiscovery> {
    if (this.#configuredFields !== undefined) return { status: "configured", fields: this.#configuredFields };
    try {
      return await this.discoverFields(signal);
    } catch (error) {
      if (error instanceof QueryCancelledError || error instanceof RangeError) throw error;
      return { status: "unavailable", ...failureFor(error) };
    }
  }

  public async describe(signal?: AbortSignal): Promise<NativeCouchDbDescribe> {
    const [database, indexes, fields] = await Promise.all([
      this.testConnection(signal),
      this.listIndexes(signal),
      this.sampleFields(signal),
    ]);
    return {
      adapter: "@dalgo/dalgo2couchdb",
      storage: "native-rows",
      readOnly: true,
      resource: { database: this.#databaseName, collection: this.#collection },
      database,
      indexes,
      fields,
      limits: {
        maxGetManyKeys: this.#maxGetManyKeys,
        maxGetManyBytes: this.#maxGetManyBytes,
        maxParallelReads: this.#maxParallelReads,
        maxQueryLimit: this.#maxQueryLimit,
        maxRequestBytes: this.#maxRequestBytes,
        maxResponseBytes: this.#maxResponseBytes,
        maxMetadataBytes: this.#maxMetadataBytes,
        maxSampleDocuments: this.#maxSampleDocuments,
        maxIndexes: this.#maxIndexes,
        maxIssuedCursors: MAX_ISSUED_CURSORS,
        maxConservedCursors: MAX_CONSERVED_CURSORS,
      },
    };
  }

  private async runQuery<T>(query: NativeCouchDbQuery<T>, signal: AbortSignal | undefined): Promise<QueryPage<T>> {
    const plan = this.plan(query);
    const cursor = this.prepareCursor(query, plan);
    if (cursor !== undefined) this.#activeCursors.add(cursor.token);
    let observed: CouchDbHeaders | undefined;
    const effectiveSignal = signal ?? new AbortController().signal;
    try {
      const body = this.mangoBody(plan, cursor?.binding.bookmark);
      const response = await this.#transport.request(
        "POST",
        "/_find",
        body,
        [],
        {},
        effectiveSignal,
        this.#maxResponseBytes,
        (headers) => {
          observed = headers;
          if (cursor !== undefined && this.credentialScope(headers) !== cursor.binding.scope) {
            throw new TypeError("Native CouchDB query cursor credential scope does not match");
          }
        },
      );
      if (effectiveSignal.aborted) throw new QueryCancelledError("caller");
      const scope = this.credentialScope(observed ?? {});
      const page = this.queryPage(query, plan, response.body, scope);
      if (cursor !== undefined) this.commitCursor(cursor.token);
      return page;
    } catch (error) {
      if (cursor !== undefined) this.#activeCursors.delete(cursor.token);
      throw error;
    }
  }

  private plan<T>(query: NativeCouchDbQuery<T>): NativeQueryPlan {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) {
      throw new UnsupportedError("Native CouchDB collection-group or nested collection queries");
    }
    if (query.source.name !== this.#collection) {
      throw new UnsupportedError(`Native CouchDB database is configured for collection ${this.#collection}`);
    }
    if (query.offset !== undefined) throw new UnsupportedError("Native CouchDB query offsets");
    if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("Native CouchDB inclusive/end query cursors");
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) {
      throw new UnsupportedError(`Native CouchDB query limit must be a safe integer from 1 to ${String(this.#maxQueryLimit)}`);
    }
    const limit = query.limit ?? this.#maxQueryLimit;
    if (limit > this.#maxQueryLimit) throw new UnsupportedError(`Native CouchDB query limit above maxQueryLimit (${String(this.#maxQueryLimit)})`);
    const projection = this.projection(query.projection);
    const terms = query.filters.map((filter) => filterTerm(filter));
    const ordered = this.ordering(query.orders, terms);
    const selector = terms.length === 0 ? {} : { $and: terms.map((term) => filterSelector(term)) };
    const fingerprint = digest(this.#cursorSecret, canonicalJson({
      collection: this.#collection,
      filters: terms.map((term) => [term.field, term.operator, term.value]),
      orders: ordered.normalized,
      projection: projection ?? null,
      limit,
      useIndex: ordered.useIndex ?? null,
    }));
    return {
      selector,
      sort: ordered.sort,
      useIndex: ordered.useIndex,
      projection,
      limit,
      fingerprint,
    };
  }

  private projection(value: readonly string[] | undefined): readonly string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new UnsupportedError("Native CouchDB projection must contain from 1 to 100 fields");
    const fields = value.map((field) => projectionField(field));
    if (new Set(fields).size !== fields.length) throw new UnsupportedError("Native CouchDB projection fields must be unique");
    if (!fields.includes(ID_FIELD)) throw new UnsupportedError("Native CouchDB projections must include _id so a native string _id remains the Key ID");
    return Object.freeze(fields);
  }

  private ordering(
    orders: StructuredQuery<unknown>["orders"],
    terms: readonly NativeFilterTerm[],
  ): {
    readonly normalized: readonly NativeCouchDbIndexField[];
    readonly sort: readonly Readonly<Record<string, OrderDirection>>[] | undefined;
    readonly useIndex: readonly [string, string] | undefined;
  } {
    if (orders.length === 0) return { normalized: [], sort: undefined, useIndex: undefined };
    const normalized: NativeCouchDbIndexField[] = [];
    let direction: OrderDirection | undefined;
    for (const order of orders) {
      const field = nativeOrderField(order.field);
      if (normalized.some((entry) => entry.field === field)) throw new UnsupportedError("Native CouchDB duplicate sort fields");
      if (order.direction !== "asc" && order.direction !== "desc") throw new UnsupportedError("Native CouchDB sort directions");
      if (direction !== undefined && direction !== order.direction) throw new UnsupportedError("Native CouchDB ordered queries require one sort direction");
      direction = order.direction;
      normalized.push({ field, direction: order.direction });
    }
    if (normalized.some((entry) => entry.field === ID_FIELD) && normalized[normalized.length - 1]?.field !== ID_FIELD) {
      throw new UnsupportedError("Native CouchDB _id tie-break must be the final sort field");
    }
    const requested = [...normalized];
    if (requested[requested.length - 1]?.field !== ID_FIELD) requested.push({ field: ID_FIELD, direction: direction ?? "asc" });
    const bounded = new Set(terms.filter((term) => term.operator === "==" || term.operator === "<" || term.operator === "<=" || term.operator === ">" || term.operator === ">=" || term.operator === "in").map((term) => term.field));
    if (!requested.slice(0, -1).some((entry) => bounded.has(entry.field)) && !bounded.has(ID_FIELD)) {
      throw new UnsupportedError("Native CouchDB ordered queries require a filter on at least one sort field");
    }
    const index = this.#permittedIndexes.find((candidate) => candidate.fields.length === requested.length
      && candidate.fields.every((field, position) => field.field === requested[position]?.field && field.direction === requested[position]?.direction));
    if (index === undefined) {
      throw new UnsupportedError(`Native CouchDB ordered queries require a permitted index matching ${requested.map((entry) => `${entry.field}:${entry.direction}`).join(",")}`);
    }
    return {
      normalized: Object.freeze(requested),
      sort: Object.freeze(requested.map((entry) => Object.freeze({ [entry.field]: entry.direction }))),
      useIndex: Object.freeze([index.ddoc, index.name] as const),
    };
  }

  private freezeIndex(index: NativeCouchDbIndex): NativeCouchDbIndex {
    if (typeof index.ddoc !== "string" || !DESIGN_DOCUMENT.test(index.ddoc)) throw new TypeError("Native CouchDB permitted index ddoc must be a _design/<name> id");
    if (typeof index.name !== "string" || index.name.length === 0 || index.name.length > 256 || !controlFree(index.name)) throw new TypeError("Native CouchDB permitted index name must be a non-empty, bounded, control-free string");
    if (!Array.isArray(index.fields) || index.fields.length === 0 || index.fields.length > 10) throw new TypeError("Native CouchDB permitted indexes require from 1 to 10 fields");
    const fields: NativeCouchDbIndexField[] = index.fields.map((field) => {
      if (!isObject(field)) throw new TypeError("Native CouchDB permitted index fields are required");
      const name = nativeOrderField(field.field);
      if (field.direction !== "asc" && field.direction !== "desc") throw new TypeError("Native CouchDB permitted index directions");
      return Object.freeze({ field: name, direction: field.direction });
    });
    if (new Set(fields.map((field) => field.field)).size !== fields.length) throw new TypeError("Native CouchDB permitted index fields must be unique");
    if (fields[fields.length - 1]?.field !== ID_FIELD) throw new TypeError("Native CouchDB permitted indexes must end with the _id tie-break field");
    return Object.freeze({ ddoc: index.ddoc, name: index.name, fields: Object.freeze(fields) });
  }

  private prepareCursor<T>(query: NativeCouchDbQuery<T>, plan: NativeQueryPlan): { readonly token: string; readonly binding: NativeCursorBinding } | undefined {
    if (query.startAfter === undefined) return undefined;
    if (query.startAfter.values.length !== 1) throw new TypeError("Native CouchDB query cursor must contain exactly one adapter cursor value");
    const token = query.startAfter.values[0];
    if (typeof token !== "string" || !CURSOR_TOKEN.test(token)) {
      throw new TypeError("Native CouchDB query cursor is invalid");
    }
    const binding = this.#issuedCursors.get(token);
    if (binding === undefined) {
      if (this.#consumedCursors.has(token)) throw new TypeError("Native CouchDB query cursor has already been used");
      throw new TypeError("Native CouchDB query cursor is invalid or unknown to this adapter instance");
    }
    if (this.#activeCursors.has(token)) throw new TypeError("Native CouchDB query cursor has already been used");
    if (binding.query !== plan.fingerprint) throw new TypeError("Native CouchDB query cursor does not match the query, filter, sort, projection or page size");
    if (binding.limit !== plan.limit) throw new TypeError("Native CouchDB query cursor page size changed");
    if (binding.bookmark.length === 0 || binding.bookmark.length > MAX_BOOKMARK_CHARS) throw new TypeError("Native CouchDB query cursor bookmark is invalid");
    return { token, binding };
  }

  /**
   * Bounded issued-state: only adapter-generated handles exist, and only for
   * one continuation. Evicting the oldest pending handle retires an unused
   * cursor rather than growing memory without bound.
   */
  private issueCursor(binding: NativeCursorBinding): string {
    while (this.#issuedCursors.size >= MAX_ISSUED_CURSORS) {
      const oldest = this.#issuedCursors.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#issuedCursors.delete(oldest);
    }
    let token = randomCursorToken();
    while (this.#issuedCursors.has(token) || this.#activeCursors.has(token) || this.#consumedCursors.has(token)) token = randomCursorToken();
    this.#issuedCursors.set(token, binding);
    return token;
  }

  private mangoBody(plan: NativeQueryPlan, bookmark?: string): Record<string, unknown> {
    return {
      selector: plan.selector,
      limit: plan.limit,
      ...(plan.sort === undefined ? {} : { sort: plan.sort, use_index: plan.useIndex, allow_fallback: false }),
      ...(plan.projection === undefined ? {} : { fields: plan.projection }),
      ...(bookmark === undefined ? {} : { bookmark }),
    };
  }

  private queryPage<T>(query: NativeCouchDbQuery<T>, plan: NativeQueryPlan, body: unknown, scope: string): QueryPage<T> {
    if (!isObject(body) || !Array.isArray(body.docs)) throw new TypeError("malformed CouchDB Mango response: docs must be an explicit array");
    const docs = body.docs;
    if (!docs.every(isPlainObject)) throw new TypeError("malformed CouchDB Mango response document");
    if (docs.length > plan.limit) throw new RangeError("CouchDB response returned more rows than the requested query limit");
    const seen = new Set<string>();
    const records = docs.map((document): ExistingRecord<T> => this.queryRecord(document, query.source.codec, seen));
    const bookmark = body.bookmark;
    if (bookmark !== undefined && (typeof bookmark !== "string" || bookmark.length > MAX_BOOKMARK_CHARS)) throw new TypeError("malformed CouchDB Mango response bookmark");
    if (docs.length < plan.limit) return { records };
    if (bookmark === undefined || bookmark.length === 0) throw new TypeError("CouchDB Mango response omitted a bookmark for a full page; completion is unknown");
    const token = this.issueCursor({ query: plan.fingerprint, scope, limit: plan.limit, bookmark });
    return { records, nextCursor: { values: [token] } };
  }

  private queryRecord<T>(document: Record<string, unknown>, codec: Codec<T> | undefined, seen: Set<string>): ExistingRecord<T> {
    const id = document._id;
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_KEY_CHARS) throw new TypeError("CouchDB Mango response document is missing a valid string _id");
    if (id.startsWith("_")) throw new TypeError("CouchDB Mango response included a metadata document");
    if (seen.has(id)) throw new TypeError("CouchDB Mango response contained a duplicate document _id");
    seen.add(id);
    if (document._rev !== undefined && typeof document._rev !== "string") throw new TypeError("CouchDB Mango response document has a malformed _rev");
    const data = codecOrIdentity(codec).decode(document);
    return {
      key: new Key(this.#collection, id),
      exists: true,
      data,
      metadata: { id, ...(typeof document._rev === "string" ? { revision: document._rev } : {}) },
    };
  }

  private recordDocument<T>(body: unknown, key: Key<string>, codec?: Codec<T>): ExistingRecord<T> {
    if (!isPlainObject(body) || typeof body._id !== "string" || typeof body._rev !== "string") throw new TypeError("malformed native CouchDB document");
    if (body._id !== key.id) throw new TypeError("CouchDB document does not match requested native key");
    if (body._id.startsWith("_")) throw new TypeError("CouchDB returned a metadata document");
    return {
      key,
      exists: true,
      data: codecOrIdentity(codec).decode(body),
      metadata: { id: body._id, revision: body._rev },
    };
  }

  private credentialScope(headers: CouchDbHeaders): string {
    if (this.#cursorScope !== undefined) return digest(this.#cursorSecret, `explicit:${this.#cursorScope}`);
    const entries = Object.entries(headers).map(([name, value]) => `${name.toLowerCase()}:${value}`).sort();
    return digest(this.#cursorSecret, `headers:${entries.join("\n")}`);
  }

  private commitCursor(token: string): void {
    this.#activeCursors.delete(token);
    this.#issuedCursors.delete(token);
    this.#consumedCursors.set(token, true);
    while (this.#consumedCursors.size > MAX_CONSERVED_CURSORS) {
      const oldest = this.#consumedCursors.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#consumedCursors.delete(oldest);
    }
  }

  private async databaseInfo(signal: AbortSignal | undefined): Promise<NativeCouchDbDatabaseInfo> {
    const response = await this.#transport.request("GET", "", undefined, [401, 403, 404], {}, signal, this.#maxMetadataBytes);
    if (response.status !== 200) throw new CouchDbHttpError(response.status);
    const body = response.body;
    if (!isObject(body) || typeof body.db_name !== "string" || body.db_name !== this.#databaseName) throw new TypeError("malformed CouchDB database info");
    const sizes = body.sizes;
    return {
      database: body.db_name,
      documentCount: positiveJsonInteger(body.doc_count, "doc_count"),
      deletedDocumentCount: body.doc_del_count === undefined ? 0 : positiveJsonInteger(body.doc_del_count, "doc_del_count"),
      updateSequence: typeof body.update_seq === "string" || typeof body.update_seq === "number" ? body.update_seq : 0,
      compactRunning: typeof body.compact_running === "boolean" ? body.compact_running : null,
      sizes: isObject(sizes)
        ? {
          active: positiveJsonInteger(sizes.active, "sizes.active"),
          external: positiveJsonInteger(sizes.external, "sizes.external"),
          file: positiveJsonInteger(sizes.file, "sizes.file"),
        }
        : null,
    };
  }

  private async discoverIndexes(signal: AbortSignal | undefined): Promise<NativeCouchDbIndexDiscovery> {
    const response = await this.#transport.request("GET", "/_index", undefined, [401, 403, 404], {}, signal, this.#maxMetadataBytes);
    if (response.status !== 200) return { status: "unavailable", ...failureForStatus(response.status) };
    const body = response.body;
    if (!isObject(body) || !Array.isArray(body.indexes)) throw new TypeError("malformed CouchDB index discovery response");
    if (body.indexes.length > this.#maxIndexes) throw new RangeError(`CouchDB index discovery returned more than maxIndexes (${String(this.#maxIndexes)})`);
    const indexes = body.indexes.map((index): NativeCouchDbDiscoveredIndex => {
      if (!isObject(index) || typeof index.name !== "string" || index.name.length === 0 || typeof index.type !== "string") throw new TypeError("malformed CouchDB index definition");
      const ddoc = index.ddoc === null || typeof index.ddoc === "string" ? index.ddoc : undefined;
      if (ddoc === undefined) throw new TypeError("malformed CouchDB index ddoc");
      const definition = index.def;
      if (!isObject(definition) || !Array.isArray(definition.fields)) throw new TypeError("malformed CouchDB index fields");
      const sorted = index.type === "json" || index.type === "special";
      const fields = definition.fields.map((field): NativeCouchDbDiscoveredIndexField => {
        if (typeof field === "string") {
          if (sorted) throw new TypeError("malformed CouchDB index field");
          return { field, direction: null };
        }
        if (!isObject(field)) throw new TypeError("malformed CouchDB index field");
        if (typeof field.field === "string") {
          if (field.dir !== "asc" && field.dir !== "desc") {
            if (sorted) throw new TypeError("malformed CouchDB index direction");
            return { field: field.field, direction: null, ...(typeof field.type === "string" ? { type: field.type } : {}) };
          }
          return { field: field.field, direction: field.dir, ...(typeof field.type === "string" ? { type: field.type } : {}) };
        }
        if (typeof field.name === "string") {
          return { field: field.name, direction: null, ...(typeof field.type === "string" ? { type: field.type } : {}) };
        }
        const entries = Object.entries(field);
        const entry = entries[0];
        if (entries.length !== 1 || entry === undefined) throw new TypeError("malformed CouchDB index field");
        if (entry[1] === "asc" || entry[1] === "desc") return { field: entry[0], direction: entry[1] };
        if (typeof entry[1] === "string" && !sorted) return { field: entry[0], direction: null, type: entry[1] };
        throw new TypeError("malformed CouchDB index field");
      });
      return {
        ddoc,
        name: index.name,
        type: index.type,
        fields: Object.freeze(fields),
        partial: definition.partial_filter_selector !== undefined,
        partitioned: typeof index.partitioned === "boolean" ? index.partitioned : null,
      };
    });
    return { status: "available", total: body.indexes.length, indexes: Object.freeze(indexes) };
  }

  private async discoverFields(signal: AbortSignal | undefined): Promise<NativeCouchDbFieldDiscovery> {
    const response = await this.#transport.request("GET", `/_all_docs?include_docs=true&limit=${String(this.#maxSampleDocuments)}`, undefined, [401, 403, 404], {}, signal, this.#maxMetadataBytes);
    if (response.status !== 200) return { status: "unavailable", ...failureForStatus(response.status) };
    const body = response.body;
    if (!isObject(body) || !Array.isArray(body.rows)) throw new TypeError("malformed CouchDB field sample response");
    if (body.rows.length > this.#maxSampleDocuments) throw new RangeError("CouchDB field sample returned more rows than maxSampleDocuments");
    const fields = new Set<string>();
    let sampleSize = 0;
    for (const row of body.rows) {
      if (!isObject(row) || typeof row.id !== "string") throw new TypeError("malformed CouchDB field sample row");
      if (row.id.startsWith("_")) continue;
      const doc = row.doc;
      if (!isPlainObject(doc) || doc._id !== row.id) throw new TypeError("malformed CouchDB field sample document");
      sampleSize += 1;
      for (const field of Object.keys(doc)) fields.add(field);
    }
    return {
      status: "sampled",
      fields: Object.freeze([...fields].sort()),
      sampleSize,
      truncated: body.rows.length >= this.#maxSampleDocuments,
    };
  }
}
