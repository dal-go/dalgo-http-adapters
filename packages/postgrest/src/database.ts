import {
  QueryCancelledError,
  cancelQuietly,
  createAbortScope,
  raceAbort,
} from "@dalgo/adapter-runtime";
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
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
  type WriteSession,
} from "@dalgo/core";
import {
  PostgrestCursorError,
  decodePostgrestCursor,
  encodePostgrestCursor,
  postgrestKeysetFilter,
  type PostgrestCursorBinding,
  type PostgrestCursorOrder,
} from "./cursor.js";
import {
  parsePostgrestOpenApi,
  type PostgrestConnectionStatus,
  type PostgrestDiscovery,
  type PostgrestDiscoveryBounds,
  type PostgrestDiscoveryReason,
} from "./discovery.js";
import { postgrestFieldKey } from "./fields.js";
import { isUnsafeNativeNumber, parseLosslessJson } from "./json.js";

const DEFAULT_MAX_GET_MANY = 100;
const DEFAULT_MAX_PARALLEL_READS = 8;
const DEFAULT_MAX_QUERY_LIMIT = 100;
const DEFAULT_MAX_QUERY_OFFSET = 100_000;
const DEFAULT_MAX_QUERY_PAGES = 10_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_DISCOVERY_RELATIONS = 100;
const DEFAULT_MAX_DISCOVERY_FIELDS = 200;
const DEFAULT_MAX_DISCOVERY_BYTES = 524_288;
const DEFAULT_MAX_CURSOR_BYTES = 8_192;
const DEFAULT_MAX_SCHEMA_DEPTH = 4;
const DEFAULT_TIMEOUT_MS = 15_000;

export type PostgrestFetch = typeof globalThis.fetch;
export type PostgrestHeaders = Readonly<Record<string, string>>;
export type PostgrestHeaderProvider = PostgrestHeaders | (() => PostgrestHeaders | Promise<PostgrestHeaders>);

export interface PostgrestDatabaseOptions {
  /** PostgREST API root, normally the configured server origin or a proxy subpath. */
  readonly baseUrl: string;
  /**
   * Allows plain HTTP only for `localhost`, `127.0.0.1` or `[::1]`. HTTPS is
   * the default and remains the only option for every hosted origin.
   */
  readonly allowInsecureLoopbackHttp?: boolean;
  /** PostgREST schema/profile selected with `Accept-Profile`/`Content-Profile`. */
  readonly schema?: string;
  /** Alias for `schema`; supplying both must resolve to the same profile. */
  readonly profile?: string;
  /** Name of the primary-key column shared by exposed adapter relations. Defaults to `id`. */
  readonly idColumn?: string;
  /** Maps a top-level DALgo collection name to an exposed PostgREST relation. */
  readonly relationName?: (collection: string) => string;
  /** Re-evaluated for every request; use it for refreshed Bearer or cookie headers. */
  readonly headers?: PostgrestHeaderProvider;
  /**
   * Optional stable, non-secret tenant/user/workspace identity. It is bound
   * into opaque cursors so a cursor cannot be replayed under another role
   * scope. Never put a token or password here.
   */
  readonly identityScope?: string;
  readonly fetch?: PostgrestFetch;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxGetManyKeys?: number;
  readonly maxParallelReads?: number;
  readonly maxQueryLimit?: number;
  readonly maxQueryOffset?: number;
  readonly maxQueryPages?: number;
  readonly maxDiscoveryRelations?: number;
  readonly maxDiscoveryFieldsPerRelation?: number;
  readonly maxDiscoveryBytes?: number;
  readonly maxCursorBytes?: number;
  readonly maxSchemaDepth?: number;
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

/** A redacted failure while obtaining headers, following a request, or consuming a response. */
export class PostgrestRequestError extends Error {
  public constructor() {
    super("PostgREST request could not be completed");
    this.name = "PostgrestRequestError";
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
    if (!Number.isFinite(value) || Object.is(value, -0) || isUnsafeNativeNumber(value)) {
      throw new TypeError("PostgREST JSON numbers must be finite, lossless and not -0");
    }
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

function profileName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return identifier(value, "schema/profile");
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

function scalar(value: unknown): string {
  if (typeof value === "string") {
    // A top-level single-value filter is not a PostgREST list context: the
    // protocol compares the operand bytes as written, so double quotes would
    // become part of the compared value (`eq."Alpha"` does not match `Alpha`).
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0) || isUnsafeNativeNumber(value)) {
      throw new TypeError("PostgREST filter numbers must be finite, lossless and not -0");
    }
    return String(value);
  }
  if (typeof value === "boolean") return String(value);
  throw new UnsupportedError("PostgREST filter value types");
}

function quotedScalar(value: unknown): string {
  if (typeof value !== "string") return scalar(value);
  return `"${value.replaceAll(/(["\\])/gu, "\\$1")}"`;
}

function filterValue(value: unknown): string {
  // An array literal is a list context, so its members are quoted.
  if (Array.isArray(value)) return `{${value.map(quotedScalar).join(",")}}`;
  return scalar(value);
}

function filterParameter<T>(filter: QueryFilter<T>, idColumn: string): readonly [string, string] {
  const field = filter.field === DOCUMENT_ID ? idColumn : identifier(String(filter.field), "query field");
  if (filter.value === undefined) throw new UnsupportedError("PostgREST undefined query filters");
  if (filter.value === null) {
    if (filter.operator === "==") return [postgrestFieldKey(field), "is.null"];
    if (filter.operator === "!=") return [postgrestFieldKey(field), "not.is.null"];
    throw new UnsupportedError(`PostgREST ${filter.operator} null query filters`);
  }
  switch (filter.operator) {
    case "==": return [postgrestFieldKey(field), `eq.${filterValue(filter.value)}`];
    case "!=": return [postgrestFieldKey(field), `neq.${filterValue(filter.value)}`];
    case "<": return [postgrestFieldKey(field), `lt.${scalar(filter.value)}`];
    case "<=": return [postgrestFieldKey(field), `lte.${scalar(filter.value)}`];
    case ">": return [postgrestFieldKey(field), `gt.${scalar(filter.value)}`];
    case ">=": return [postgrestFieldKey(field), `gte.${scalar(filter.value)}`];
    case "in":
      if (!Array.isArray(filter.value) || filter.value.length === 0) throw new TypeError("PostgREST in filters require a non-empty array");
      return [postgrestFieldKey(field), `in.(${filter.value.map(quotedScalar).join(",")})`];
    case "not-in":
      if (!Array.isArray(filter.value) || filter.value.length === 0) throw new TypeError("PostgREST not-in filters require a non-empty array");
      return [postgrestFieldKey(field), `not.in.(${filter.value.map(quotedScalar).join(",")})`];
    case "array-contains":
      if (!Array.isArray(filter.value)) throw new TypeError("PostgREST array-contains filters require an array");
      return [postgrestFieldKey(field), `cs.${filterValue(filter.value)}`];
    case "array-contains-any":
      if (!Array.isArray(filter.value) || filter.value.length === 0) throw new TypeError("PostgREST array-contains-any filters require a non-empty array");
      return [postgrestFieldKey(field), `ov.${filterValue(filter.value)}`];
    default: throw new UnsupportedError(`PostgREST ${String(filter.operator)} query filters`);
  }
}

async function readJson(response: Response, maximum: number, signal: AbortSignal, cancelled: () => Error): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximum)) {
    cancelQuietly(response.body);
    throw new RangeError("PostgREST response exceeds maxResponseBytes");
  }
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await raceAbort(reader.read(), signal, cancelled);
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) {
        cancelQuietly(reader);
        throw new RangeError("PostgREST response exceeds maxResponseBytes");
      }
      chunks.push(item.value);
    }
  } finally {
    if (signal.aborted) cancelQuietly(reader);
    try {
      reader.releaseLock();
    } catch {
      // An implementation may retain an in-flight read after cancellation.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength === 0) return undefined;
  return parseLosslessJson(new TextDecoder().decode(bytes));
}

interface QueryContinuation {
  readonly binding: PostgrestCursorBinding;
  readonly page: number;
  readonly orders: readonly PostgrestCursorOrder[];
}

export class PostgrestDatabase implements Database, WriteSession {
  readonly #baseUrl: string;
  readonly #schema: string | undefined;
  readonly #identityScope: string | undefined;
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
  readonly #maxQueryOffset: number;
  readonly #maxQueryPages: number;
  readonly #maxDiscoveryRelations: number;
  readonly #maxDiscoveryFields: number;
  readonly #maxDiscoveryBytes: number;
  readonly #maxCursorBytes: number;
  readonly #maxSchemaDepth: number;

  public constructor(options: PostgrestDatabaseOptions) {
    if (options.schema !== undefined && options.profile !== undefined && options.schema !== options.profile) {
      throw new TypeError("schema and profile must name the same PostgREST profile");
    }
    const url = new URL(options.baseUrl.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol === "http:") {
      if (!loopback || options.allowInsecureLoopbackHttp !== true) {
        throw new TypeError("baseUrl must use HTTPS; loopback HTTP requires allowInsecureLoopbackHttp: true");
      }
    } else if (url.protocol !== "https:") {
      throw new TypeError("baseUrl must use HTTPS");
    }
    if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
      throw new TypeError("baseUrl must not contain credentials, a query, or a fragment");
    }
    this.#baseUrl = `${url.toString().replace(/\/+$/u, "")}/`;
    this.#schema = profileName(options.profile ?? options.schema);
    this.#identityScope = identityScopeName(options.identityScope);
    this.#idColumn = identifier(options.idColumn ?? "id", "id column");
    this.#relationName = options.relationName ?? ((collection) => collection);
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 120_000);
    this.#maxRequestBytes = positive(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, "maxRequestBytes");
    this.#maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
    this.#maxGetManyKeys = positive(options.maxGetManyKeys, DEFAULT_MAX_GET_MANY, "maxGetManyKeys", 1_000);
    this.#maxParallelReads = positive(options.maxParallelReads, Math.min(DEFAULT_MAX_PARALLEL_READS, this.#maxGetManyKeys), "maxParallelReads", this.#maxGetManyKeys);
    this.#maxQueryLimit = positive(options.maxQueryLimit, DEFAULT_MAX_QUERY_LIMIT, "maxQueryLimit", 1_000);
    this.#maxQueryOffset = positive(options.maxQueryOffset, DEFAULT_MAX_QUERY_OFFSET, "maxQueryOffset", 10_000_000);
    this.#maxQueryPages = positive(options.maxQueryPages, DEFAULT_MAX_QUERY_PAGES, "maxQueryPages", 1_000_000);
    this.#maxDiscoveryRelations = positive(options.maxDiscoveryRelations, DEFAULT_MAX_DISCOVERY_RELATIONS, "maxDiscoveryRelations", 10_000);
    this.#maxDiscoveryFields = positive(options.maxDiscoveryFieldsPerRelation, DEFAULT_MAX_DISCOVERY_FIELDS, "maxDiscoveryFieldsPerRelation", 10_000);
    this.#maxDiscoveryBytes = positive(options.maxDiscoveryBytes, DEFAULT_MAX_DISCOVERY_BYTES, "maxDiscoveryBytes", 16_777_216);
    this.#maxCursorBytes = positive(options.maxCursorBytes, DEFAULT_MAX_CURSOR_BYTES, "maxCursorBytes", 65_536);
    this.#maxSchemaDepth = positive(options.maxSchemaDepth, DEFAULT_MAX_SCHEMA_DEPTH, "maxSchemaDepth", 16);
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const url = this.keyUrl(key);
    url.searchParams.set("select", "*");
    url.searchParams.set("limit", "1");
    const rows = await this.request(url, "GET", { accept: "application/json" }, undefined, (response, signal, cancelled) => this.rows(response, signal, cancelled));
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
      await this.request(this.relationUrl(key), "POST", this.writeHeaders("return=minimal"), payload, this.discard);
    } catch (error) {
      if (error instanceof PostgrestHttpError && error.status === 409) throw new AlreadyExistsError(key, { cause: error });
      throw error;
    }
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const payload = this.payload(key, data, codec);
    const rows = await this.request(this.keyUrl(key), "PUT", this.writeHeaders("return=representation"), payload, (response, signal, cancelled) => this.rows(response, signal, cancelled));
    this.assertExactlyOne(rows);
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    const payload = encodedRecord(data, identityCodec as Codec<UpdateData>, this.#idColumn);
    const rows = await this.request(this.keyUrl(key), "PATCH", this.writeHeaders("handling=strict, max-affected=1, return=representation"), payload, (response, signal, cancelled) => this.rows(response, signal, cancelled));
    if (rows.length === 0) throw new NotFoundError(key);
    this.assertExactlyOne(rows);
  }

  public async delete(key: Key): Promise<void> {
    const rows = await this.request(this.keyUrl(key), "DELETE", this.writeHeaders("handling=strict, max-affected=1, return=representation"), undefined, (response, signal, cancelled) => this.rows(response, signal, cancelled));
    if (rows.length === 0) return;
    this.assertExactlyOne(rows);
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    const { url, limit } = this.prepareQuery(query, false);
    const rows = await this.request(url, "GET", { accept: "application/json" }, undefined, (response, signal, cancelled) => this.rows(response, signal, cancelled));
    return this.queryPage(rows, limit, query);
  }

  /**
   * Cancellable query entry point with an optional adapter-owned keyset cursor.
   * The caller signal covers header acquisition, fetch and response-body
   * reading, and shares one deadline with `query`.
   */
  public async queryWithSignal<T>(query: StructuredQuery<T>, signal: AbortSignal): Promise<QueryPage<T>> {
    if (signal.aborted) throw new QueryCancelledError("caller");
    const { url, limit, continuation } = this.prepareQuery(query, true);
    const rows = await this.request(url, "GET", { accept: "application/json" }, undefined, (response, readSignal, cancelled) => this.rows(response, readSignal, cancelled), signal);
    if (signal.aborted) throw new QueryCancelledError("caller");
    return this.queryPage(rows, limit, query, continuation);
  }

  private queryPage<T>(
    rows: readonly Record<string, unknown>[],
    limit: number,
    query: StructuredQuery<T>,
    continuation?: QueryContinuation,
  ): QueryPage<T> {
    if (rows.length > limit) throw new RangeError("PostgREST response returned more rows than the requested query limit");
    const records = rows.map((row) => this.record(row, undefined, query.source.codec, query.source.name));
    // A short page is not proof of end-of-data: `db-max-rows` (or a proxy)
    // can cap every response below the requested limit. Continue after every
    // non-empty page and let the next request prove the end with an empty
    // page. Only cursor mode continues; legacy query/offset keeps its exact
    // single-request contract.
    if (continuation === undefined || rows.length === 0) return { records };
    const last = rows[rows.length - 1];
    if (last === undefined) return { records };
    const values = continuation.orders.map((order) => {
      if (!Object.hasOwn(last, order.field)) {
        throw new TypeError(`PostgREST response row is missing the ${order.field} order column`);
      }
      return last[order.field];
    });
    const cursor = encodePostgrestCursor(continuation.binding, continuation.page, values, this.#maxCursorBytes);
    return { records, nextCursor: { values: [cursor] } };
  }

  private prepareQuery<T>(
    query: StructuredQuery<T>,
    cursorMode: boolean,
  ): { readonly url: URL; readonly limit: number; readonly continuation?: QueryContinuation } {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) {
      throw new UnsupportedError("PostgREST collection-group or nested-collection queries");
    }
    for (const key of ["projection", "select", "columns", "fields"]) {
      if (Object.hasOwn(query, key)) throw new UnsupportedError("PostgREST query projection");
    }
    if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
      throw new UnsupportedError("PostgREST DALgo query cursors");
    }
    if (!cursorMode && query.startAfter !== undefined) {
      throw new UnsupportedError("PostgREST DALgo query cursors");
    }
    if (query.startAfter !== undefined && query.offset !== undefined) {
      throw new UnsupportedError("PostgREST query cursors combined with offset");
    }
    const url = this.relationUrlForCollection(query.source.name);
    url.searchParams.set("select", "*");
    for (const filter of query.filters) {
      const [field, value] = filterParameter(filter, this.#idColumn);
      url.searchParams.append(field, value);
    }
    const orders = cursorMode ? this.cursorOrders(query.orders) : this.legacyOrders(query.orders);
    if (orders.length > 0) {
      url.searchParams.set("order", orders.map((order) => `${postgrestFieldKey(order.field)}.${order.direction}`).join(","));
    }
    const limit = query.limit ?? this.#maxQueryLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#maxQueryLimit) {
      throw new UnsupportedError(`PostgREST query limit above ${String(this.#maxQueryLimit)}`);
    }
    url.searchParams.set("limit", String(limit));
    if (query.offset !== undefined) {
      if (!Number.isSafeInteger(query.offset) || query.offset < 0) {
        throw new TypeError("PostgREST query offset must be a non-negative safe integer");
      }
      if (query.offset > this.#maxQueryOffset) {
        throw new UnsupportedError(`PostgREST query offset above ${String(this.#maxQueryOffset)}`);
      }
      url.searchParams.set("offset", String(query.offset));
    }
    if (!cursorMode) return { url, limit };

    const continuationBinding = this.cursorBinding(query, orders, limit);
    let page = 1;
    if (query.startAfter !== undefined) {
      if (query.startAfter.values.length !== 1 || typeof query.startAfter.values[0] !== "string") {
        throw new PostgrestCursorError("malformed");
      }
      const decoded = decodePostgrestCursor(query.startAfter.values[0], continuationBinding, this.#maxCursorBytes);
      page = decoded.page;
      if (page > this.#maxQueryPages) {
        throw new UnsupportedError(`PostgREST query cursor page above ${String(this.#maxQueryPages)}`);
      }
      url.searchParams.set("or", postgrestKeysetFilter(orders, decoded.values));
    }
    return { url, limit, continuation: { binding: continuationBinding, page: page + 1, orders } };
  }

  private cursorOrders(orders: readonly { readonly field: string; readonly direction: "asc" | "desc" }[]): readonly PostgrestCursorOrder[] {
    const mapped: PostgrestCursorOrder[] = [];
    const seen = new Set<string>();
    for (const order of orders) {
      if (order.direction !== "asc" && order.direction !== "desc") throw new UnsupportedError("PostgREST query order directions");
      const field = order.field === DOCUMENT_ID ? this.#idColumn : identifier(String(order.field), "order field");
      if (seen.has(field)) throw new UnsupportedError("PostgREST duplicate query order fields");
      seen.add(field);
      mapped.push({ field, direction: order.direction });
    }
    if (!seen.has(this.#idColumn)) mapped.push({ field: this.#idColumn, direction: "asc" });
    return mapped;
  }

  private legacyOrders(orders: readonly { readonly field: string; readonly direction: "asc" | "desc" }[]): readonly PostgrestCursorOrder[] {
    return orders.map((order) => {
      if (order.direction !== "asc" && order.direction !== "desc") throw new UnsupportedError("PostgREST query order directions");
      return {
        field: order.field === DOCUMENT_ID ? this.#idColumn : identifier(String(order.field), "order field"),
        direction: order.direction,
      };
    });
  }

  private cursorBinding<T>(
    query: StructuredQuery<T>,
    orders: readonly PostgrestCursorOrder[],
    limit: number,
  ): PostgrestCursorBinding {
    return {
      endpoint: this.#baseUrl,
      collection: query.source.name,
      relation: this.relationForCollection(query.source.name),
      ...(this.#schema === undefined ? {} : { schema: this.#schema }),
      idColumn: this.#idColumn,
      select: "*",
      filters: query.filters.map((filter) => filterParameter(filter, this.#idColumn)),
      orders,
      limit,
      ...(this.#identityScope === undefined ? {} : { identityScope: this.#identityScope }),
    };
  }

  /** Read-only provider metadata. It never calls an administration endpoint. */
  public async discover(signal?: AbortSignal): Promise<PostgrestDiscovery> {
    if (signal?.aborted === true) throw new QueryCancelledError("caller");
    try {
      const body = await this.request(
        new URL(this.#baseUrl),
        "GET",
        { accept: "application/openapi+json, application/json;q=0.9" },
        undefined,
        (response, readSignal, cancelled) => this.metadataBody(response, readSignal, cancelled),
        signal,
      );
      const parsed = parsePostgrestOpenApi(body, {
        idColumn: this.#idColumn,
        maxRelations: this.#maxDiscoveryRelations,
        maxFieldsPerRelation: this.#maxDiscoveryFields,
        maxSchemaDepth: this.#maxSchemaDepth,
      });
      if (parsed.status === "unavailable") {
        return this.discoveryUnavailable(parsed.reason, parsed.detail, 200);
      }
      return {
        adapter: "@dalgo/dalgo2postgrest",
        protocol: "postgrest-openapi",
        endpoint: this.#baseUrl,
        ...(this.#schema === undefined ? {} : { schema: this.#schema }),
        status: "available",
        detail: "read-only OpenAPI metadata is available for the request role",
        relations: parsed.relations,
        relationCount: parsed.relationCount,
        truncated: parsed.truncated,
        omittedRelations: parsed.omittedRelations,
        bounds: this.discoveryBounds,
      };
    } catch (error) {
      if (error instanceof QueryCancelledError) throw error;
      if (error instanceof PostgrestHttpError) {
        if (error.status === 401) {
          return this.discoveryUnavailable("unauthorized", "PostgREST metadata requires a valid user identity", error.status);
        }
        if (error.status === 403) {
          return this.discoveryUnavailable("forbidden", "PostgREST metadata is not permitted for this identity", error.status);
        }
        if (error.status === 404 || error.status === 405) {
          return this.discoveryUnavailable("metadata-disabled", "PostgREST OpenAPI metadata is disabled or not available at this endpoint", error.status);
        }
        return this.discoveryUnavailable("request-failed", "PostgREST metadata request failed", error.status);
      }
      return this.discoveryUnavailable("request-failed", "PostgREST metadata request could not be completed");
    }
  }

  /** A safe UI-factory preflight: proves transport, headers and metadata access. */
  public async testConnection(signal?: AbortSignal): Promise<PostgrestConnectionStatus> {
    const discovery = await this.discover(signal);
    if (discovery.status === "available") {
      return {
        ok: true,
        status: "connected",
        relationCount: discovery.relationCount,
        ...(this.#schema === undefined ? {} : { schema: this.#schema }),
        detail: "PostgREST connection, identity and metadata access succeeded",
      };
    }
    if (discovery.reason === "no-relations") {
      return {
        ok: true,
        status: "connected",
        relationCount: 0,
        ...(this.#schema === undefined ? {} : { schema: this.#schema }),
        detail: discovery.detail,
      };
    }
    const status = discovery.reason === "unauthorized"
      ? "unauthorized"
      : discovery.reason === "forbidden"
        ? "forbidden"
        : discovery.reason === "metadata-disabled"
          ? "metadata-disabled"
          : discovery.reason === "malformed-metadata"
            ? "metadata-malformed"
            : "unreachable";
    return {
      ok: false,
      status,
      ...(discovery.httpStatus === undefined ? {} : { httpStatus: discovery.httpStatus }),
      ...(this.#schema === undefined ? {} : { schema: this.#schema }),
      detail: discovery.detail,
    };
  }

  private get discoveryBounds(): PostgrestDiscoveryBounds {
    return {
      maxRelations: this.#maxDiscoveryRelations,
      maxFieldsPerRelation: this.#maxDiscoveryFields,
      maxMetadataBytes: this.#maxDiscoveryBytes,
      maxSchemaDepth: this.#maxSchemaDepth,
    };
  }

  private discoveryUnavailable(
    reason: PostgrestDiscoveryReason,
    detail: string,
    httpStatus?: number,
  ): PostgrestDiscovery {
    return {
      adapter: "@dalgo/dalgo2postgrest",
      protocol: "postgrest-openapi",
      endpoint: this.#baseUrl,
      ...(this.#schema === undefined ? {} : { schema: this.#schema }),
      status: "unavailable",
      reason,
      detail,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      relations: [],
      relationCount: 0,
      truncated: false,
      omittedRelations: 0,
      bounds: this.discoveryBounds,
    };
  }

  private readonly metadataBody = async (
    response: Response,
    signal: AbortSignal,
    cancelled: () => Error,
  ): Promise<unknown> => {
    const body = await readJson(response, this.#maxDiscoveryBytes, signal, cancelled);
    if (body === undefined) throw new TypeError("PostgREST metadata response was empty");
    return body;
  };

  public async runReadwriteTransaction<Result>(
    callback: (transaction: ReadwriteTransaction) => Promise<Result>,
  ): Promise<Result> {
    void callback;
    throw new UnsupportedError("PostgREST callback transactions");
  }

  private relationUrl(key: Key): URL {
    if (key.parent !== undefined) throw new UnsupportedError("PostgREST nested DALgo keys");
    return this.relationUrlForCollection(key.collection);
  }

  private relationForCollection(collection: string): string {
    return identifier(this.#relationName(collection), "relation");
  }

  private relationUrlForCollection(collection: string): URL {
    return new URL(encodeURIComponent(this.relationForCollection(collection)), this.#baseUrl);
  }

  private keyUrl(key: Key): URL {
    const url = this.relationUrl(key);
    url.searchParams.set(postgrestFieldKey(this.#idColumn), `eq.${scalar(key.id)}`);
    return url;
  }

  private payload<T>(key: Key, data: T, codec?: Codec<T>): Record<string, unknown> {
    if (typeof key.id === "number" && (!Number.isFinite(key.id) || Object.is(key.id, -0) || isUnsafeNativeNumber(key.id))) {
      throw new TypeError("PostgREST write keys must have a finite, lossless number or string ID");
    }
    return { [this.#idColumn]: key.id, ...encodedRecord(data, codecOrIdentity(codec), this.#idColumn) };
  }

  private writeHeaders(prefer: string): Record<string, string> {
    return { accept: "application/json", "content-type": "application/json", prefer };
  }

  private profileHeaders(method: string): Record<string, string> {
    if (this.#schema === undefined) return {};
    return method === "GET" || method === "HEAD"
      ? { "accept-profile": this.#schema }
      : { "content-profile": this.#schema };
  }

  private readonly discard = async (response: Response): Promise<void> => {
    cancelQuietly(response.body);
  };

  private async request<T>(
    url: URL,
    method: string,
    requiredHeaders: Record<string, string>,
    body: unknown | undefined,
    consume: (response: Response, signal: AbortSignal, cancelled: () => Error) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined && new TextEncoder().encode(text).byteLength > this.#maxRequestBytes) throw new RangeError("PostgREST request exceeds maxRequestBytes");
    const scope = createAbortScope(callerSignal, this.#timeoutMs);
    const cancelled = (): Error => callerSignal === undefined
      ? new PostgrestRequestError()
      : new QueryCancelledError(scope.deadlineExceeded ? "deadline" : "caller");
    let response: Response | undefined;
    try {
      let provided: PostgrestHeaders | undefined;
      try {
        provided = await raceAbort(
          Promise.resolve().then(() => typeof this.#headers === "function" ? this.#headers() : this.#headers),
          scope.signal,
          cancelled,
        );
      } catch {
        if (scope.signal.aborted) throw cancelled();
        throw new PostgrestRequestError();
      }
      if (provided !== undefined) validateHeaders(provided);
      const headers = new Headers(provided);
      for (const [name, value] of Object.entries(this.profileHeaders(method))) headers.set(name, value);
      for (const [name, value] of Object.entries(requiredHeaders)) headers.set(name, value);
      if (scope.signal.aborted) throw cancelled();
      const pending = Promise.resolve().then(() => this.#fetch(url, {
        method,
        headers,
        redirect: "error",
        ...(text === undefined ? {} : { body: text }),
        signal: scope.signal,
      }));
      void pending.then((late) => { if (scope.signal.aborted) cancelQuietly(late.body); }, () => undefined);
      const responseValue = await raceAbort(pending, scope.signal, cancelled);
      response = responseValue;
      if (scope.signal.aborted) throw cancelled();
      if (!responseValue.ok) {
        cancelQuietly(responseValue.body);
        throw new PostgrestHttpError(responseValue.status);
      }
      const value = await consume(responseValue, scope.signal, cancelled);
      if (scope.signal.aborted) throw cancelled();
      return value;
    } catch (error) {
      if (scope.signal.aborted) {
        cancelQuietly(response?.body);
        throw cancelled();
      }
      if (error instanceof PostgrestHttpError || error instanceof PostgrestRequestError || error instanceof QueryCancelledError) throw error;
      throw new PostgrestRequestError();
    } finally {
      scope.dispose();
    }
  }

  private async rows(response: Response, signal: AbortSignal, cancelled: () => Error): Promise<readonly Record<string, unknown>[]> {
    const body = await readJson(response, this.#maxResponseBytes, signal, cancelled);
    if (!Array.isArray(body) || !body.every(isPlainObject)) throw new TypeError("PostgREST response must be a JSON array of row objects");
    return body;
  }

  private assertExactlyOne(rows: readonly Record<string, unknown>[]): void {
    if (rows.length !== 1) throw new PostgrestRequestError();
  }

  private record<T>(
    row: Record<string, unknown>,
    requestedKey: Key | undefined,
    codec?: Codec<T>,
    collection?: string,
  ): ExistingRecord<T> {
    const id = row[this.#idColumn];
    if ((typeof id !== "string" && typeof id !== "number")
      || (typeof id === "number" && (!Number.isFinite(id) || Object.is(id, -0) || isUnsafeNativeNumber(id)))) {
      throw new TypeError(`PostgREST response row is missing a lossless ${this.#idColumn} column`);
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
