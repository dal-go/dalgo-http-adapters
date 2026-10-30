import {
  QueryCancelledError,
  type CancellableQueryExecutor,
} from "@dalgo/adapter-runtime";
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
} from "@dalgo/core";

import {
  TYPESENSE_READ_CAPABILITIES,
  type TypesenseCapabilityDescriptor,
  type TypesenseQueryBounds,
} from "./capabilities.js";
import {
  TypesenseContinuationBoundError,
  TypesenseCursorError,
  TypesenseSemanticError,
  type TypesenseMetadataFailure,
} from "./errors.js";
import {
  metadataFailure,
  parseCollectionList,
  parseCollectionSchema,
  schemaFieldTypes,
  type TypesenseCollectionDiscovery,
  type TypesenseCollectionSchema,
  type TypesenseSchemaDiscovery,
} from "./metadata.js";
import {
  buildNativeResult,
  decodeSearchResponse,
  type TypesenseNativeSearchRequest,
  type TypesenseNativeSearchResult,
} from "./search.js";
import {
  canonicalPredicate,
  collectPredicate,
  createVerifier,
  orderFields,
  predicateRoot,
  projectionFields,
  renderPredicate,
} from "./structured.js";
import {
  TypesenseTransport,
  byteLength,
  nonNegative,
  positive,
  type TypesenseFetch,
  type TypesenseHeaderProvider,
  type TypesenseHeaders,
  type TypesenseOperation,
} from "./transport.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_GET_MANY = 100;
const DEFAULT_MAX_GET_MANY_BYTES = 1_048_576;
const DEFAULT_MAX_QUERY_LIMIT = 100;
const DEFAULT_MAX_ROWS_PER_PAGE = 100;
const DEFAULT_MAX_QUERY_PAGES = 20;
const DEFAULT_MAX_QUERY_OFFSET = 10_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_TOTAL_BYTES = 16_777_216;
const DEFAULT_MAX_ROW_BYTES = 1_048_576;
const DEFAULT_MAX_FILTER_BYTES = 8_192;
const DEFAULT_MAX_COLUMNS = 100;
const DEFAULT_MAX_SORT_FIELDS = 3;
const DEFAULT_MAX_FACET_FIELDS = 5;
const DEFAULT_MAX_FACET_VALUES = 100;
const DEFAULT_MAX_CURSOR_BYTES = 8_192;
const DEFAULT_MAX_ISSUED_CURSORS = 1_000;
const MAX_CONSERVED_CURSORS = 1_000;

const ABSOLUTE_MAX_GET_MANY = 250;
const ABSOLUTE_MAX_QUERY_LIMIT = 10_000;
const ABSOLUTE_MAX_ROWS_PER_PAGE = 250;
const ABSOLUTE_MAX_QUERY_PAGES = 100;
const ABSOLUTE_MAX_QUERY_OFFSET = 1_000_000;
const ABSOLUTE_MAX_REQUEST_BYTES = 16_777_216;
const ABSOLUTE_MAX_RESPONSE_BYTES = 16_777_216;
const ABSOLUTE_MAX_TOTAL_BYTES = 67_108_864;
const ABSOLUTE_MAX_ROW_BYTES = 67_108_864;
const ABSOLUTE_MAX_FILTER_BYTES = 65_536;
const ABSOLUTE_MAX_COLUMNS = 250;
const ABSOLUTE_MAX_SORT_FIELDS = 3;
const ABSOLUTE_MAX_FACET_FIELDS = 10;
const ABSOLUTE_MAX_FACET_VALUES = 250;
const ABSOLUTE_MAX_CURSOR_BYTES = 65_536;
const ABSOLUTE_MAX_ISSUED_CURSORS = 10_000;
const ABSOLUTE_MAX_TIMEOUT_MS = 120_000;

const COLLECTION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const NATIVE_FIELD = /^[A-Za-z][A-Za-z0-9._]{0,127}$/u;
const SIMPLE_NATIVE_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;
const CURSOR_TOKEN = /^ts1_[A-Za-z0-9_-]{43}$/u;
const CURSOR_TOKEN_BYTES = 47;
const MAX_KEY_CHARS = 1_024;
const MAX_QUERY_TEXT = 4_096;

export interface TypesenseDatabaseOptions {
  /** Typesense origin, for example `https://typesense.example.com:8108`. */
  readonly baseUrl: string;
  /** Allows plain HTTP only for `localhost`, `127.0.0.1` or `[::1]`. */
  readonly allowInsecureLoopbackHttp?: boolean;
  /** The one existing collection this database exposes. */
  readonly collection: string;
  /** Re-evaluated for every physical request; must include X-TYPESENSE-API-KEY. */
  readonly headers?: TypesenseHeaderProvider;
  /** Stable non-secret identity label bound into cursors instead of header digests. */
  readonly identityScope?: string;
  readonly fetch?: TypesenseFetch;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxRowBytes?: number;
  readonly maxGetManyKeys?: number;
  readonly maxGetManyBytes?: number;
  readonly maxQueryLimit?: number;
  readonly maxRowsPerPage?: number;
  readonly maxQueryPages?: number;
  readonly maxQueryOffset?: number;
  readonly maxFilterBytes?: number;
  readonly maxColumns?: number;
  readonly maxSortFields?: number;
  readonly maxFacetFields?: number;
  readonly maxFacetValues?: number;
  readonly maxCursorBytes?: number;
  readonly maxIssuedCursors?: number;
}

export interface TypesenseConnectionTest {
  readonly ok: boolean;
  readonly collection: string;
  readonly status: "connected" | "unauthorized" | "forbidden" | "not-found" | "unreachable" | "metadata-malformed";
  readonly httpStatus?: number;
}

export interface TypesenseDescribe {
  readonly adapter: "@dalgo/dalgo2typesense";
  readonly storage: "native-rows";
  readonly readOnly: true;
  readonly endpoint: string;
  readonly collection: string;
  readonly schema: TypesenseSchemaDiscovery;
  readonly limits: TypesenseQueryBounds;
  readonly capabilities: TypesenseCapabilityDescriptor;
}

interface CursorBinding {
  readonly fingerprint: string;
  readonly scope: string;
  readonly limit: number;
  readonly nextOffset: number;
  readonly filtered: boolean;
}

interface Planner {
  readonly collection: string;
  readonly limit: number;
  readonly offset: number;
  readonly projection: readonly string[] | undefined;
  readonly includeFields: readonly string[] | undefined;
  readonly orders: readonly { readonly field: string; readonly direction: "asc" | "desc" }[];
  readonly filter: string | undefined;
  readonly verifier: ((data: Readonly<Record<string, unknown>>, check: () => void) => Promise<boolean>) | undefined;
  readonly filtered: boolean;
  readonly pageSize: number;
  readonly window: number;
  readonly fingerprint: string;
  readonly cursor?: CursorPreparation;
}

interface CursorPreparation {
  readonly token: string;
  readonly binding: CursorBinding;
}

function assertCollection(value: string): string {
  if (typeof value !== "string" || !COLLECTION.test(value)) {
    throw new TypeError("collection must be a Typesense collection name");
  }
  return value;
}

function identityScopeName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError("identityScope must be a non-empty string of at most 256 printable characters");
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new TypeError("identityScope must be a non-empty string of at most 256 printable characters");
    }
  }
  return value;
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function assertNativeID(id: string): string {
  if (id.length === 0 || id.length > MAX_KEY_CHARS || !id.isWellFormed()) {
    throw new TypeError("Typesense document ids must be non-empty bounded strings");
  }
  for (let index = 0; index < id.length; index += 1) {
    const code = id.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) throw new TypeError("Typesense document ids must be control-free");
  }
  return id;
}

function filterID(id: string): string {
  assertNativeID(id);
  if (id.includes("`")) throw new UnsupportedError("Typesense document ids containing a backtick cannot be used in an exact filter");
  return `\`${id}\``;
}

function nativeField(value: string, nested: boolean): string {
  const pattern = nested ? NATIVE_FIELD : SIMPLE_NATIVE_FIELD;
  if (!pattern.test(value) || value.startsWith("_")) throw new UnsupportedError("Typesense field name is not supported");
  return value;
}

function validateNativeFilter(filter: string, maximum: number): void {
  if (filter.length === 0) throw new UnsupportedError("Typesense native filter must not be empty");
  if (byteLength(filter) > maximum) throw new RangeError("Typesense native filter exceeds maxFilterBytes");
  if (!filter.isWellFormed()) throw new UnsupportedError("Typesense native filter is not valid UTF-8");
  let depth = 0;
  let inBacktick = false;
  for (const character of filter) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0 || code === 0x0d || code === 0x0a || code === 0x7f) {
      throw new UnsupportedError("Typesense native filter contains a control character");
    }
    if (inBacktick) {
      if (character === "`") inBacktick = false;
      continue;
    }
    if (character === "`") {
      inBacktick = true;
      continue;
    }
    if (character === "(") {
      depth += 1;
      if (depth > 8) throw new UnsupportedError("Typesense native filter nesting is too deep");
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) throw new UnsupportedError("Typesense native filter has unbalanced parentheses");
    } else if (character === "{" || character === "}" || character === "$") {
      throw new UnsupportedError("Typesense native filter uses unsupported join or object-filter syntax");
    }
  }
  if (inBacktick) throw new UnsupportedError("Typesense native filter has an unbalanced literal");
  if (depth !== 0) throw new UnsupportedError("Typesense native filter has unbalanced parentheses");
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
  if (crypto === undefined || typeof crypto.getRandomValues !== "function") {
    throw new Error("Typesense cursors require crypto.getRandomValues");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function failureStatus(reason: TypesenseMetadataFailure): TypesenseConnectionTest["status"] {
  switch (reason) {
    case "unauthorized": return "unauthorized";
    case "forbidden": return "forbidden";
    case "not-found": return "not-found";
    case "malformed": return "metadata-malformed";
    default: return "unreachable";
  }
}

function documentBytes(document: Readonly<Record<string, unknown>>): number {
  return byteLength(JSON.stringify(document));
}

/**
 * Read-only bounded adapter over one existing Typesense collection.
 *
 * Documents are read natively: the string Typesense `id` is the DALgo key and
 * no DALgo envelope is required or written. Structured queries use a positive
 * native candidate filter plus an exact verifier over the complete bounded
 * candidate prefix. Every read disables curations and filters curated hits.
 */
export class TypesenseDatabase implements Database, CancellableQueryExecutor {
  public readonly readOnly = true as const;

  readonly #transport: TypesenseTransport;
  readonly #collection: string;
  readonly #identityScope: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxTotalBytes: number;
  readonly #maxRowBytes: number;
  readonly #maxGetManyKeys: number;
  readonly #maxGetManyBytes: number;
  readonly #maxQueryLimit: number;
  readonly #maxRowsPerPage: number;
  readonly #maxQueryPages: number;
  readonly #maxQueryOffset: number;
  readonly #maxFilterBytes: number;
  readonly #maxColumns: number;
  readonly #maxSortFields: number;
  readonly #maxFacetFields: number;
  readonly #maxFacetValues: number;
  readonly #maxCursorBytes: number;
  readonly #maxIssuedCursors: number;
  readonly #root = new AbortController();
  readonly #operations = new Set<TypesenseOperation>();
  readonly #issuedCursors = new Map<string, CursorBinding>();
  readonly #activeCursors = new Set<string>();
  readonly #consumedCursors = new Map<string, true>();
  readonly #cursorSecret = randomId();
  #closed = false;

  public constructor(options: TypesenseDatabaseOptions) {
    this.#collection = assertCollection(options.collection);
    this.#identityScope = identityScopeName(options.identityScope);
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", ABSOLUTE_MAX_TIMEOUT_MS);
    this.#maxRequestBytes = positive(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, "maxRequestBytes", ABSOLUTE_MAX_REQUEST_BYTES);
    this.#maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes", ABSOLUTE_MAX_RESPONSE_BYTES);
    this.#maxTotalBytes = positive(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, "maxTotalBytes", ABSOLUTE_MAX_TOTAL_BYTES);
    this.#maxRowBytes = positive(options.maxRowBytes, DEFAULT_MAX_ROW_BYTES, "maxRowBytes", ABSOLUTE_MAX_ROW_BYTES);
    this.#maxGetManyKeys = positive(options.maxGetManyKeys, DEFAULT_MAX_GET_MANY, "maxGetManyKeys", ABSOLUTE_MAX_GET_MANY);
    this.#maxGetManyBytes = positive(options.maxGetManyBytes, DEFAULT_MAX_GET_MANY_BYTES, "maxGetManyBytes", ABSOLUTE_MAX_TOTAL_BYTES);
    this.#maxQueryLimit = positive(options.maxQueryLimit, DEFAULT_MAX_QUERY_LIMIT, "maxQueryLimit", ABSOLUTE_MAX_QUERY_LIMIT);
    this.#maxRowsPerPage = positive(options.maxRowsPerPage, DEFAULT_MAX_ROWS_PER_PAGE, "maxRowsPerPage", ABSOLUTE_MAX_ROWS_PER_PAGE);
    this.#maxQueryPages = positive(options.maxQueryPages, DEFAULT_MAX_QUERY_PAGES, "maxQueryPages", ABSOLUTE_MAX_QUERY_PAGES);
    this.#maxQueryOffset = nonNegative(options.maxQueryOffset, DEFAULT_MAX_QUERY_OFFSET, "maxQueryOffset", ABSOLUTE_MAX_QUERY_OFFSET);
    this.#maxFilterBytes = positive(options.maxFilterBytes, DEFAULT_MAX_FILTER_BYTES, "maxFilterBytes", ABSOLUTE_MAX_FILTER_BYTES);
    this.#maxColumns = positive(options.maxColumns, DEFAULT_MAX_COLUMNS, "maxColumns", ABSOLUTE_MAX_COLUMNS);
    this.#maxSortFields = positive(options.maxSortFields, DEFAULT_MAX_SORT_FIELDS, "maxSortFields", ABSOLUTE_MAX_SORT_FIELDS);
    this.#maxFacetFields = positive(options.maxFacetFields, DEFAULT_MAX_FACET_FIELDS, "maxFacetFields", ABSOLUTE_MAX_FACET_FIELDS);
    this.#maxFacetValues = positive(options.maxFacetValues, DEFAULT_MAX_FACET_VALUES, "maxFacetValues", ABSOLUTE_MAX_FACET_VALUES);
    this.#maxCursorBytes = positive(options.maxCursorBytes, DEFAULT_MAX_CURSOR_BYTES, "maxCursorBytes", ABSOLUTE_MAX_CURSOR_BYTES);
    this.#maxIssuedCursors = positive(options.maxIssuedCursors, DEFAULT_MAX_ISSUED_CURSORS, "maxIssuedCursors", ABSOLUTE_MAX_ISSUED_CURSORS);
    if (this.#maxCursorBytes < CURSOR_TOKEN_BYTES) throw new TypeError("maxCursorBytes is smaller than an adapter cursor handle");
    this.#transport = new TypesenseTransport({
      baseUrl: options.baseUrl,
      allowInsecureLoopbackHttp: options.allowInsecureLoopbackHttp === true,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      timeoutMs: this.#timeoutMs,
      maxRequestBytes: this.#maxRequestBytes,
      maxResponseBytes: this.#maxResponseBytes,
      maxTotalBytes: this.#maxTotalBytes,
      root: this.#root.signal,
      onDispose: (operation) => { this.#operations.delete(operation); },
    });
  }

  public get collection(): string { return this.#collection; }
  public get endpoint(): string { return this.#transport.origin; }
  public get limits(): TypesenseQueryBounds { return this.#bounds; }
  public get capabilities(): TypesenseCapabilityDescriptor {
    return {
      ...TYPESENSE_READ_CAPABILITIES,
      read: {
        ...TYPESENSE_READ_CAPABILITIES.read,
        maxGetManyKeys: { default: this.#maxGetManyKeys, maximum: ABSOLUTE_MAX_GET_MANY },
      },
      bounds: this.#bounds,
    };
  }

  get #bounds(): TypesenseQueryBounds {
    return {
      maxQueryLimit: { default: this.#maxQueryLimit, maximum: ABSOLUTE_MAX_QUERY_LIMIT },
      maxRequestBytes: { default: this.#maxRequestBytes, maximum: ABSOLUTE_MAX_REQUEST_BYTES },
      maxResponseBytes: { default: this.#maxResponseBytes, maximum: ABSOLUTE_MAX_RESPONSE_BYTES },
      maxGetManyKeys: { default: this.#maxGetManyKeys, maximum: ABSOLUTE_MAX_GET_MANY },
      maxGetManyBytes: { default: this.#maxGetManyBytes, maximum: ABSOLUTE_MAX_TOTAL_BYTES },
      maxRowsPerPage: { default: this.#maxRowsPerPage, maximum: ABSOLUTE_MAX_ROWS_PER_PAGE },
      maxQueryPages: { default: this.#maxQueryPages, maximum: ABSOLUTE_MAX_QUERY_PAGES },
      maxQueryOffset: { default: this.#maxQueryOffset, maximum: ABSOLUTE_MAX_QUERY_OFFSET },
      maxTotalBytes: { default: this.#maxTotalBytes, maximum: ABSOLUTE_MAX_TOTAL_BYTES },
      maxRowBytes: { default: this.#maxRowBytes, maximum: ABSOLUTE_MAX_ROW_BYTES },
      maxFilterBytes: { default: this.#maxFilterBytes, maximum: ABSOLUTE_MAX_FILTER_BYTES },
      maxColumns: { default: this.#maxColumns, maximum: ABSOLUTE_MAX_COLUMNS },
      maxSortFields: { default: this.#maxSortFields, maximum: ABSOLUTE_MAX_SORT_FIELDS },
      maxFacetFields: { default: this.#maxFacetFields, maximum: ABSOLUTE_MAX_FACET_FIELDS },
      maxFacetValues: { default: this.#maxFacetValues, maximum: ABSOLUTE_MAX_FACET_VALUES },
      maxCursorBytes: { default: this.#maxCursorBytes, maximum: ABSOLUTE_MAX_CURSOR_BYTES },
      maxIssuedCursors: { default: this.#maxIssuedCursors, maximum: ABSOLUTE_MAX_ISSUED_CURSORS },
      filterOperators: TYPESENSE_READ_CAPABILITIES.bounds.filterOperators,
      orderDirections: TYPESENSE_READ_CAPABILITIES.bounds.orderDirections,
    };
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    assertKey(key, this.#collection);
    const results = await this.#getMany([key], undefined, codec);
    const result = results[0];
    if (result === undefined) throw new Error("Typesense point read returned no snapshot");
    return result;
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    return this.#getMany(keys, undefined, codec);
  }

  public async getManyWithSignal<T>(keys: readonly Key[], signal: AbortSignal, codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (signal.aborted) throw new QueryCancelledError("caller");
    return this.#getMany(keys, signal, codec);
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    return this.#query(query, undefined);
  }

  public async queryWithSignal<T>(query: StructuredQuery<T>, signal: AbortSignal): Promise<QueryPage<T>> {
    if (signal.aborted) throw new QueryCancelledError("caller");
    return this.#query(query, signal);
  }

  public async search(request: TypesenseNativeSearchRequest): Promise<TypesenseNativeSearchResult> {
    return this.#search(request, undefined);
  }

  public async searchWithSignal(request: TypesenseNativeSearchRequest, signal: AbortSignal): Promise<TypesenseNativeSearchResult> {
    if (signal.aborted) throw new QueryCancelledError("caller");
    return this.#search(request, signal);
  }

  public async listCollections(signal?: AbortSignal): Promise<TypesenseCollectionDiscovery> {
    if (signal?.aborted === true) throw new QueryCancelledError("caller");
    const operation = this.#begin(signal);
    try {
      const response = await this.#transport.request(
        "/collections",
        new URLSearchParams(),
        operation,
        [401, 403, 404],
      );
      if (response.status !== 200) {
        return { status: "unavailable", ...failureForStatus(response.status) };
      }
      const parsed = parseCollectionList(response.body, this.#maxColumns);
      return { status: "available", ...parsed };
    } catch (error) {
      if (error instanceof QueryCancelledError || error instanceof RangeError) throw error;
      return { status: "unavailable", ...metadataFailure(error) };
    } finally {
      operation.dispose();
    }
  }

  public async schema(signal?: AbortSignal): Promise<TypesenseSchemaDiscovery> {
    if (signal?.aborted === true) throw new QueryCancelledError("caller");
    const operation = this.#begin(signal);
    try {
      return await this.#schema(operation);
    } catch (error) {
      if (error instanceof QueryCancelledError || error instanceof RangeError) throw error;
      return { status: "unavailable", ...metadataFailure(error) };
    } finally {
      operation.dispose();
    }
  }

  public async testConnection(signal?: AbortSignal): Promise<TypesenseConnectionTest> {
    const discovery = await this.schema(signal);
    if (discovery.status === "available") {
      return { ok: true, collection: this.#collection, status: "connected" };
    }
    return {
      ok: false,
      collection: this.#collection,
      status: failureStatus(discovery.reason),
      ...(discovery.httpStatus === undefined ? {} : { httpStatus: discovery.httpStatus }),
    };
  }

  public async describe(signal?: AbortSignal): Promise<TypesenseDescribe> {
    const schema = await this.schema(signal);
    return {
      adapter: "@dalgo/dalgo2typesense",
      storage: "native-rows",
      readOnly: true,
      endpoint: this.#transport.origin,
      collection: this.#collection,
      schema,
      limits: this.#bounds,
      capabilities: this.capabilities,
    };
  }

  /** Cancels every owned operation. Idempotent. */
  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#issuedCursors.clear();
    this.#activeCursors.clear();
    this.#consumedCursors.clear();
    this.#root.abort();
  }

  /** Alias kept for callers that use a disposal vocabulary. */
  public dispose(): void { this.close(); }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    void callback;
    return Promise.reject(new UnsupportedError("Typesense adapter is read-only and has no callback transactions"));
  }

  #begin(signal?: AbortSignal): TypesenseOperation {
    if (this.#closed) throw new UnsupportedError("Typesense database is closed");
    const operation = this.#transport.begin(signal);
    this.#operations.add(operation);
    return operation;
  }

  async #getMany<T>(keys: readonly Key[], signal: AbortSignal | undefined, codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#maxGetManyKeys) {
      throw new UnsupportedError(`Typesense getMany above maxGetManyKeys (${String(this.#maxGetManyKeys)})`);
    }
    for (const key of keys) assertKey(key, this.#collection);
    const results: RecordSnapshot<T>[] = new Array(keys.length);
    if (keys.length === 0) return results;
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      const id = key.id as string;
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(id);
      }
    }
    if (unique.length > this.#maxRowsPerPage) {
      throw new UnsupportedError(`Typesense exact-id batch above maxRowsPerPage (${String(this.#maxRowsPerPage)})`);
    }
    const operation = this.#begin(signal);
    try {
      const parameters = new URLSearchParams();
      parameters.set("q", "*");
      parameters.set("filter_by", `id:=[${unique.map((id) => filterID(id)).join(",")}]`);
      parameters.set("limit", String(unique.length));
      this.#structuredPolicy(parameters);
      const response = await this.#transport.request(this.#searchPath(), parameters, operation);
      const decoded = decodeSearchResponse(response.body, {
        limit: unique.length,
        offset: 0,
        facetFields: [],
        maxFacetValues: 0,
        maxRowBytes: this.#maxRowBytes,
      });
      if (decoded.cutoff || decoded.found !== decoded.hits.length) {
        throw new UnsupportedError("Typesense exact-id search returned a partial result");
      }
      let total = 0;
      const hits = new Map<string, (typeof decoded.hits)[number]>();
      for (const hit of decoded.hits) {
        total += documentBytes(hit.document);
        if (total > this.#maxGetManyBytes) throw new RangeError("Typesense getMany responses exceed maxGetManyBytes");
        hits.set(hit.id, hit);
      }
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        if (key === undefined) continue;
        const hit = hits.get(key.id as string);
        results[index] = hit === undefined
          ? { key, exists: false }
          : this.#record(hit, key, codec);
      }
      operation.check();
      return results;
    } finally {
      operation.dispose();
    }
  }

  async #query<T>(query: StructuredQuery<T>, signal: AbortSignal | undefined): Promise<QueryPage<T>> {
    const operation = this.#begin(signal);
    let plan: Planner | undefined;
    try {
      plan = await this.#plan(query, operation);
      return await this.#execute(plan, query, operation);
    } catch (error) {
      if (plan?.cursor !== undefined) this.#activeCursors.delete(plan.cursor.token);
      throw error;
    } finally {
      operation.dispose();
    }
  }

  async #plan<T>(query: StructuredQuery<T>, operation: TypesenseOperation): Promise<Planner> {
    // Preflight the cheap, secret-free request shape before any metadata or
    // search I/O.
    if (query.source.kind !== "collection" || query.source.parent !== undefined) {
      throw new UnsupportedError("Typesense collection-group or nested-collection queries");
    }
    if (query.source.name !== this.#collection) {
      throw new UnsupportedError(`Typesense database is configured for collection ${this.#collection}`);
    }
    const extended = query as StructuredQuery<T> & { readonly projection?: readonly string[] };
    const projection = projectionFields(extended.projection, this.#maxColumns);
    const orders = orderFields(query.orders, this.#maxSortFields);
    if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
      throw new UnsupportedError("Typesense inclusive/end DALgo query cursors");
    }
    if (query.startAfter !== undefined && query.offset !== undefined) {
      throw new UnsupportedError("Typesense query cursors combined with offset");
    }
    const limit = query.limit ?? this.#maxQueryLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#maxQueryLimit) {
      throw new UnsupportedError(`Typesense query limit must be from 1 to ${String(this.#maxQueryLimit)}`);
    }
    const requestedOffset = query.offset ?? 0;
    if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > this.#maxQueryOffset) {
      throw new UnsupportedError(`Typesense query offset is outside the configured bound`);
    }
    if (requestedOffset + limit > this.#maxQueryOffset) {
      throw new UnsupportedError("Typesense query offset plus limit exceeds maxQueryOffset");
    }
    const root = predicateRoot(extended, { maxFilterBytes: this.#maxFilterBytes });
    const { fields, ranges } = root === undefined ? { fields: [], ranges: [] } : collectPredicate(root);
    let filter: string | undefined;
    if (root !== undefined) {
      const numeric = ranges.length === 0 ? new Map<string, string>() : await this.#numericSchema(operation, ranges);
      filter = renderPredicate(root, numeric, this.#maxFilterBytes);
      if (byteLength(filter) > this.#maxFilterBytes) {
        throw new RangeError("Typesense structured filter exceeds maxFilterBytes");
      }
    }
    const include = this.#includeFields(projection, fields, root !== undefined);
    const filtered = filter !== undefined;
    const fingerprint = digest(this.#cursorSecret, JSON.stringify({
      endpoint: this.#transport.origin,
      collection: this.#collection,
      // The exact admitted AST, not only the widened native candidate string:
      // `>` and `>=` (or `<` and `<=`) normalise to the same native filter and
      // must never share a continuation identity.
      predicate: canonicalPredicate(root),
      orders,
      projection: projection ?? null,
      limit,
      filtered,
    }));
    const prepared = query.startAfter === undefined
      ? undefined
      : this.#prepareCursor(query.startAfter, fingerprint, limit, filtered);
    const offset = prepared === undefined ? requestedOffset : prepared.binding.nextOffset;
    const window = filtered ? offset + limit : limit;
    const pageSize = filtered ? Math.min(this.#maxRowsPerPage, Math.max(window, 1)) : Math.min(this.#maxRowsPerPage, limit);
    if (filtered) {
      if (window > this.#maxQueryOffset) {
        throw new UnsupportedError("Typesense filtered candidate window exceeds maxQueryOffset");
      }
      const pages = Math.ceil(window / pageSize);
      if (pages > this.#maxQueryPages) {
        throw new UnsupportedError(`Typesense filtered candidate window needs more pages than maxQueryPages (${String(this.#maxQueryPages)})`);
      }
    } else {
      if (offset + limit > this.#maxQueryOffset) {
        throw new UnsupportedError("Typesense query offset plus limit exceeds maxQueryOffset");
      }
      const pages = Math.ceil(limit / this.#maxRowsPerPage);
      if (pages > this.#maxQueryPages) {
        throw new UnsupportedError(`Typesense unfiltered page needs more requests than maxQueryPages (${String(this.#maxQueryPages)})`);
      }
    }
    const planner: Planner = {
      collection: this.#collection,
      limit,
      offset,
      projection,
      includeFields: include,
      orders,
      filter,
      verifier: root === undefined ? undefined : createVerifier(root),
      filtered,
      pageSize,
      window,
      fingerprint,
      ...(prepared === undefined ? {} : { cursor: prepared }),
    };
    // Activation is the final, non-throwing step: no remaining planning error
    // can strand an active lease with an undefined plan.
    if (prepared !== undefined) {
      if (this.#activeCursors.has(prepared.token)) throw new TypesenseCursorError("used");
      this.#activeCursors.add(prepared.token);
    }
    return planner;
  }

  #includeFields(
    projection: readonly string[] | undefined,
    predicateFields: readonly string[],
    filtered: boolean,
  ): readonly string[] | undefined {
    if (projection === undefined) return undefined;
    const fields = new Set<string>(["id", ...projection]);
    if (filtered) {
      for (const field of predicateFields) fields.add(field);
    }
    if (fields.size > this.#maxColumns) {
      throw new UnsupportedError("Typesense predicate helper fields exceed maxColumns");
    }
    return Object.freeze([...fields]);
  }

  async #execute<T>(plan: Planner, query: StructuredQuery<T>, operation: TypesenseOperation): Promise<QueryPage<T>> {
    const cursor = plan.cursor;
    const scope = this.#bindCursor(cursor, operation);
    try {
      const page = plan.filtered
        ? await this.#filteredPage(plan, scope.observe, operation)
        : await this.#unfilteredPage(plan, scope.observe, operation);
      operation.check();
      const records = page.hits.slice(plan.filtered ? plan.offset : 0, plan.filtered ? plan.offset + plan.limit : plan.limit)
        .map((hit) => this.#recordHit(hit, plan, query.source.codec));
      // A codec can synchronously abort or close the database. The previous
      // attempt must not be consumed and a next handle must not be issued until
      // the complete page, including codec decoding, has succeeded.
      operation.check();
      const hasMore = plan.filtered
        ? page.scanned >= plan.window && page.found > plan.window
        : page.hits.length === plan.limit && page.found > plan.offset + page.hits.length;
      let nextCursor: QueryPage<T>["nextCursor"];
      let issued: { readonly token: string; readonly binding: CursorBinding } | undefined;
      if (hasMore) {
        if (!this.#continuationUsable(plan)) throw new TypesenseContinuationBoundError();
        // Staging performs all fallible token work without touching the cache.
        // The cursor transaction commits only after the final cancellability
        // check, so a failed attempt cannot evict the handle it is resuming.
        issued = {
          token: this.#stageCursor(),
          binding: {
            fingerprint: plan.fingerprint,
            scope: scope.value(),
            limit: plan.limit,
            nextOffset: plan.offset + plan.limit,
            filtered: plan.filtered,
          },
        };
        nextCursor = { values: [issued.token] };
      }
      operation.check();
      this.#commitCursorPage(cursor?.token, issued);
      return nextCursor === undefined ? { records } : { records, nextCursor };
    } catch (error) {
      // Failed or canceled execute releases the lease and never commits it.
      if (cursor !== undefined) this.#activeCursors.delete(cursor.token);
      throw error;
    }
  }

  /** True when the position after this page is inside every configured bound. */
  #continuationUsable(plan: Planner): boolean {
    const nextOffset = plan.offset + plan.limit;
    if (!Number.isSafeInteger(nextOffset) || nextOffset < 0 || nextOffset > this.#maxQueryOffset) return false;
    if (plan.filtered) {
      const nextWindow = nextOffset + plan.limit;
      if (nextWindow > this.#maxQueryOffset) return false;
      const pageSize = Math.min(this.#maxRowsPerPage, Math.max(nextWindow, 1));
      return Math.ceil(nextWindow / pageSize) <= this.#maxQueryPages;
    }
    if (nextOffset + plan.limit > this.#maxQueryOffset) return false;
    return Math.ceil(plan.limit / this.#maxRowsPerPage) <= this.#maxQueryPages;
  }

  #bindCursor(prepared: CursorPreparation | undefined, operation: TypesenseOperation): { observe(headers: TypesenseHeaders): void; value(): string } {
    let scope: string | undefined;
    return {
      observe: (headers) => {
        operation.check();
        const current = this.#scopeOf(headers);
        if (prepared !== undefined) {
          if (current !== prepared.binding.scope) throw new TypesenseCursorError("changed-query");
          scope = current;
        } else if (scope === undefined) {
          scope = current;
        } else if (scope !== current) {
          throw new TypesenseCursorError("changed-query");
        }
      },
      value: () => {
        if (scope === undefined) throw new TypesenseCursorError("malformed");
        return scope;
      },
    };
  }

  async #unfilteredPage(plan: Planner, observe: (headers: TypesenseHeaders) => void, operation: TypesenseOperation): Promise<{ readonly hits: ReturnType<typeof decodeSearchResponse>["hits"]; readonly found: number; readonly scanned: number }> {
    // The native Typesense physical page is at most the configured
    // maxRowsPerPage (and the absolute 250-row server cap). A larger DALgo
    // query limit is honoured with bounded paging, never by asking one physical
    // page for more rows than the adapter admits.
    const hits: ReturnType<typeof decodeSearchResponse>["hits"][number][] = [];
    const seen = new Set<string>();
    let found = 0;
    let physicalOffset = plan.offset;
    let pages = 0;
    while (hits.length < plan.limit) {
      operation.check();
      if (pages >= this.#maxQueryPages) throw new UnsupportedError("Typesense query exceeded maxQueryPages");
      const size = Math.min(this.#maxRowsPerPage, plan.limit - hits.length);
      const response = await this.#searchRequest(plan, physicalOffset, size, operation, observe);
      if (operation.signal.aborted) throw operation.cancelled();
      const decoded = decodeSearchResponse(response, {
        limit: size,
        offset: physicalOffset,
        facetFields: [],
        maxFacetValues: 0,
        maxRowBytes: this.#maxRowBytes,
      });
      pages += 1;
      found = decoded.found;
      operation.check();
      if (decoded.cutoff) throw new UnsupportedError("Typesense search returned a partial cutoff result");
      if (decoded.hits.length === 0) {
        if (decoded.found > physicalOffset) throw new UnsupportedError("Typesense search returned a partial result");
        break;
      }
      for (const hit of decoded.hits) {
        if (seen.has(hit.id)) throw new TypeError("Typesense search response repeated a document id across pages");
        seen.add(hit.id);
        hits.push(hit);
      }
      physicalOffset += decoded.hits.length;
      if (decoded.hits.length < size) {
        if (decoded.found > physicalOffset) throw new UnsupportedError("Typesense search returned a partial result");
        break;
      }
    }
    operation.check();
    return { hits, found, scanned: hits.length };
  }

  async #filteredPage(
    plan: Planner,
    observe: (headers: TypesenseHeaders) => void,
    operation: TypesenseOperation,
  ): Promise<{ readonly hits: ReturnType<typeof decodeSearchResponse>["hits"]; readonly found: number; readonly scanned: number }> {
    const verifier = plan.verifier;
    if (verifier === undefined) throw new Error("Typesense filtered plan requires a verifier");
    const verified: ReturnType<typeof decodeSearchResponse>["hits"][number][] = [];
    const seen = new Set<string>();
    let physicalOffset = 0;
    let found = 0;
    let pages = 0;
    while (physicalOffset < plan.window) {
      operation.check();
      if (pages >= this.#maxQueryPages) throw new UnsupportedError("Typesense query exceeded maxQueryPages");
      const size = Math.min(plan.pageSize, plan.window - physicalOffset);
      const response = await this.#searchRequest(plan, physicalOffset, size, operation, observe);
      const decoded = decodeSearchResponse(response, {
        limit: size,
        offset: physicalOffset,
        facetFields: [],
        maxFacetValues: 0,
        maxRowBytes: this.#maxRowBytes,
      });
      pages += 1;
      found = decoded.found;
      if (decoded.cutoff) throw new UnsupportedError("Typesense search returned a partial cutoff result");
      if (decoded.hits.length === 0) {
        if (decoded.found > physicalOffset) throw new UnsupportedError("Typesense search returned a partial result");
        break;
      }
      for (const hit of decoded.hits) {
        operation.check();
        if (seen.has(hit.id)) throw new TypeError("Typesense search response repeated a document id across pages");
        seen.add(hit.id);
        const matches = await verifier(hit.document, () => { operation.check(); });
        operation.check();
        if (!matches) throw new TypesenseSemanticError();
        verified.push(hit);
      }
      physicalOffset += decoded.hits.length;
      if (decoded.hits.length < size) {
        if (decoded.found > physicalOffset) throw new UnsupportedError("Typesense search returned a partial result");
        break;
      }
      if (verified.length >= plan.window) break;
    }
    operation.check();
    return { hits: verified, found: Math.max(found, verified.length), scanned: verified.length };
  }

  async #searchRequest(
    plan: Planner,
    offset: number,
    limit: number,
    operation: TypesenseOperation,
    observe: (headers: TypesenseHeaders) => void,
  ): Promise<unknown> {
    const parameters = new URLSearchParams();
    parameters.set("q", "*");
    if (plan.filter !== undefined) parameters.set("filter_by", plan.filter);
    if (plan.orders.length > 0) {
      parameters.set("sort_by", plan.orders.map((order) => `${order.field}:${order.direction}`).join(","));
    }
    if (plan.includeFields !== undefined) parameters.set("include_fields", plan.includeFields.join(","));
    parameters.set("limit", String(limit));
    if (offset > 0) parameters.set("offset", String(offset));
    this.#structuredPolicy(parameters);
    const response = await this.#transport.request(this.#searchPath(), parameters, operation, [], observe);
    return response.body;
  }

  #structuredPolicy(parameters: URLSearchParams): void {
    parameters.set("enable_curations", "false");
    parameters.set("filter_curated_hits", "true");
    parameters.set("num_typos", "0");
    parameters.set("prefix", "false");
    parameters.set("drop_tokens_threshold", "0");
    parameters.set("typo_tokens_threshold", "0");
  }

  async #search(request: TypesenseNativeSearchRequest, signal: AbortSignal | undefined): Promise<TypesenseNativeSearchResult> {
    const plan = this.#nativePlan(request);
    const operation = this.#begin(signal);
    try {
      const parameters = new URLSearchParams();
      parameters.set("q", plan.q);
      if (plan.queryBy.length > 0) parameters.set("query_by", plan.queryBy.join(","));
      if (plan.filterBy !== undefined) parameters.set("filter_by", plan.filterBy);
      if (plan.sortBy.length > 0) {
        parameters.set("sort_by", plan.sortBy.map((sort) => `${sort.field}:${sort.direction ?? "asc"}`).join(","));
      }
      if (plan.facetBy.length > 0) {
        parameters.set("facet_by", plan.facetBy.join(","));
        parameters.set("max_facet_values", String(plan.maxFacetValues));
      }
      parameters.set("limit", String(plan.limit));
      if (plan.offset > 0) parameters.set("offset", String(plan.offset));
      parameters.set("enable_curations", "false");
      parameters.set("filter_curated_hits", "true");
      const response = await this.#transport.request(this.#searchPath(), parameters, operation);
      const decoded = decodeSearchResponse(response.body, {
        limit: plan.limit,
        offset: plan.offset,
        facetFields: plan.facetBy,
        maxFacetValues: plan.maxFacetValues,
        maxRowBytes: this.#maxRowBytes,
      });
      operation.check();
      return buildNativeResult(this.#collection, decoded, plan.limit, plan.offset);
    } finally {
      operation.dispose();
    }
  }

  #nativePlan(request: TypesenseNativeSearchRequest): {
    readonly q: string;
    readonly queryBy: readonly string[];
    readonly filterBy: string | undefined;
    readonly sortBy: readonly { readonly field: string; readonly direction: "asc" | "desc" }[];
    readonly facetBy: readonly string[];
    readonly maxFacetValues: number;
    readonly limit: number;
    readonly offset: number;
  } {
    if (typeof request.q !== "string" || request.q.length === 0 || request.q.length > MAX_QUERY_TEXT || !request.q.isWellFormed()) {
      throw new UnsupportedError("Typesense native search requires a non-empty bounded q");
    }
    for (let index = 0; index < request.q.length; index += 1) {
      const code = request.q.charCodeAt(index);
      if (code < 0x20 && code !== 0x09 || code === 0x7f) throw new UnsupportedError("Typesense native q contains a control character");
    }
    const queryBy = request.queryBy ?? [];
    if (request.q !== "*" && queryBy.length === 0) {
      throw new UnsupportedError("Typesense native text search requires query_by");
    }
    if (queryBy.length > this.#maxColumns) throw new UnsupportedError("Typesense query_by exceeds maxColumns");
    const queryFields = new Set<string>();
    for (const field of queryBy) {
      const name = nativeField(field, true);
      if (queryFields.has(name)) throw new UnsupportedError("Typesense query_by fields must be unique");
      queryFields.add(name);
    }
    const filterBy = request.filterBy;
    if (filterBy !== undefined) validateNativeFilter(filterBy, this.#maxFilterBytes);
    const sortByInput = request.sortBy ?? [];
    if (sortByInput.length > this.#maxSortFields) throw new UnsupportedError("Typesense sort_by exceeds maxSortFields");
    const sorts: { field: string; direction: "asc" | "desc" }[] = [];
    const sortFields = new Set<string>();
    for (const sort of sortByInput) {
      const field = nativeField(sort.field, false);
      if (field === "id" || sortFields.has(field)) throw new UnsupportedError("Typesense sort field is not supported");
      sortFields.add(field);
      if (sort.direction !== undefined && sort.direction !== "asc" && sort.direction !== "desc") {
        throw new UnsupportedError("Typesense sort direction is not supported");
      }
      sorts.push({ field, direction: sort.direction ?? "asc" });
    }
    const facetByInput = request.facetBy ?? [];
    if (facetByInput.length > this.#maxFacetFields) throw new UnsupportedError("Typesense facet_by exceeds maxFacetFields");
    const facets: string[] = [];
    const facetFields = new Set<string>();
    for (const field of facetByInput) {
      const name = nativeField(field, true);
      if (facetFields.has(name)) throw new UnsupportedError("Typesense facet fields must be unique");
      facetFields.add(name);
      facets.push(name);
    }
    const limit = request.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#maxQueryLimit || limit > this.#maxRowsPerPage) {
      throw new UnsupportedError("Typesense native search requires a positive bounded limit");
    }
    const offset = request.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.#maxQueryOffset) {
      throw new UnsupportedError("Typesense native search offset is outside the configured bound");
    }
    let maxFacetValues = request.maxFacetValues ?? Math.min(10, this.#maxFacetValues);
    if (!Number.isSafeInteger(maxFacetValues) || maxFacetValues < 1 || maxFacetValues > this.#maxFacetValues) {
      throw new UnsupportedError("Typesense maxFacetValues is outside the configured bound");
    }
    if (facets.length === 0) maxFacetValues = 0;
    return { q: request.q, queryBy: Object.freeze(queryBy), filterBy, sortBy: Object.freeze(sorts), facetBy: Object.freeze(facets), maxFacetValues, limit, offset };
  }

  async #schema(operation: TypesenseOperation): Promise<TypesenseSchemaDiscovery> {
    const response = await this.#transport.request(
      `/collections/${encodeURIComponent(this.#collection)}`,
      new URLSearchParams(),
      operation,
      [401, 403, 404],
    );
    if (response.status !== 200) {
      return { status: "unavailable", ...failureForStatus(response.status) };
    }
    return { status: "available", schema: parseCollectionSchema(response.body, this.#collection, this.#maxColumns) };
  }

  async #numericSchema(operation: TypesenseOperation, ranges: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const response = await this.#transport.request(
      `/collections/${encodeURIComponent(this.#collection)}`,
      new URLSearchParams(),
      operation,
      [401, 403, 404],
    );
    if (response.status !== 200) {
      throw new UnsupportedError("Typesense structured numeric ranges require readable collection schema");
    }
    const schema: TypesenseCollectionSchema = parseCollectionSchema(response.body, this.#collection, this.#maxColumns);
    const types = schemaFieldTypes(schema);
    for (const field of ranges) {
      const type = types.get(field);
      if (type !== "int32" && type !== "int64" && type !== "float") {
        throw new UnsupportedError("Typesense structured numeric ranges require a schema-declared scalar numeric field");
      }
    }
    return types;
  }

  #searchPath(): string {
    return `/collections/${encodeURIComponent(this.#collection)}/documents/search`;
  }

  #record<T>(hit: ReturnType<typeof decodeSearchResponse>["hits"][number], key: Key, codec?: Codec<T>): ExistingRecord<T> {
    if (hit.id !== key.id) throw new TypeError("Typesense document does not match the requested key");
    const data = { ...hit.document } as Record<string, unknown>;
    const decoded = codecOrIdentity(codec).decode(data);
    return { key, exists: true, data: decoded };
  }

  #recordHit<T>(hit: ReturnType<typeof decodeSearchResponse>["hits"][number], plan: Planner, codec?: Codec<T>): ExistingRecord<T> {
    const data = Object.create(null) as Record<string, unknown>;
    if (plan.projection === undefined) {
      for (const [field, value] of Object.entries(hit.document)) data[field] = value;
    } else {
      for (const field of plan.projection) {
        if (Object.hasOwn(hit.document, field)) data[field] = hit.document[field];
      }
    }
    const decoded = codecOrIdentity(codec).decode(data);
    return { key: new Key(plan.collection, hit.id), exists: true, data: decoded };
  }

  /**
   * Validates a presented continuation without taking its lease. The caller
   * activates it only after every remaining planning bound has passed.
   */
  #prepareCursor(cursor: StructuredQuery<unknown>["startAfter"], fingerprint: string, limit: number, filtered: boolean): CursorPreparation {
    if (cursor === undefined) throw new TypesenseCursorError("malformed");
    if (cursor.values.length !== 1) throw new TypesenseCursorError("malformed");
    const token = cursor.values[0];
    if (typeof token !== "string" || !CURSOR_TOKEN.test(token) || byteLength(token) > this.#maxCursorBytes) {
      throw new TypesenseCursorError("malformed");
    }
    const binding = this.#issuedCursors.get(token);
    if (binding === undefined) {
      throw new TypesenseCursorError(this.#consumedCursors.has(token) ? "used" : "foreign");
    }
    if (this.#activeCursors.has(token)) throw new TypesenseCursorError("used");
    if (binding.fingerprint !== fingerprint || binding.limit !== limit || binding.filtered !== filtered) {
      throw new TypesenseCursorError("changed-query");
    }
    if (!Number.isSafeInteger(binding.nextOffset) || binding.nextOffset < 0 || binding.nextOffset > this.#maxQueryOffset) {
      throw new TypesenseCursorError("malformed");
    }
    return { token, binding };
  }

  /** Generates a token without mutating cursor state; this step may fail. */
  #stageCursor(): string {
    let token = `ts1_${randomId()}`;
    while (this.#issuedCursors.has(token) || this.#activeCursors.has(token) || this.#consumedCursors.has(token)) {
      token = `ts1_${randomId()}`;
    }
    if (byteLength(token) > this.#maxCursorBytes) throw new RangeError("Typesense query cursor exceeds maxCursorBytes");
    return token;
  }

  /** One synchronous, non-throwing commit for a fully successful page. */
  #commitCursorPage(previous: string | undefined, issued: { readonly token: string; readonly binding: CursorBinding } | undefined): void {
    // Retire the resumed handle before publishing its replacement: consuming a
    // handle frees the slot it occupied, so a resume at the cache bound must not
    // evict an unrelated, still-outstanding handle. All fallible work has
    // already completed, and these synchronous map updates cannot throw, so the
    // transaction stays atomic.
    if (previous !== undefined) this.#commitCursor(previous);
    if (issued !== undefined) {
      while (this.#issuedCursors.size >= this.#maxIssuedCursors) {
        const oldest = this.#issuedCursors.keys().next().value;
        if (typeof oldest !== "string") break;
        this.#issuedCursors.delete(oldest);
      }
      this.#issuedCursors.set(issued.token, issued.binding);
    }
  }

  #commitCursor(token: string): void {
    this.#activeCursors.delete(token);
    this.#issuedCursors.delete(token);
    this.#consumedCursors.set(token, true);
    while (this.#consumedCursors.size > MAX_CONSERVED_CURSORS) {
      const oldest = this.#consumedCursors.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#consumedCursors.delete(oldest);
    }
  }

  #scopeOf(headers: TypesenseHeaders): string {
    if (this.#identityScope !== undefined) return digest(this.#cursorSecret, `explicit:${this.#identityScope}`);
    const entries = Object.entries(headers).map(([name, value]) => `${name.toLowerCase()}:${value}`).sort();
    return digest(this.#cursorSecret, `headers:${entries.join("\n")}`);
  }
}

function failureForStatus(status: number): { readonly reason: TypesenseMetadataFailure; readonly httpStatus: number } {
  const reason = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not-found" : "unavailable";
  return { reason, httpStatus: status };
}

function assertKey(key: Key, collection: string): asserts key is Key<string> {
  if (key.parent !== undefined) throw new UnsupportedError("Typesense nested collection keys");
  if (key.collection !== collection) throw new UnsupportedError(`Typesense database is configured for collection ${collection}`);
  if (typeof key.id !== "string") throw new TypeError("Typesense keys require a string Typesense id");
  assertNativeID(key.id);
}
