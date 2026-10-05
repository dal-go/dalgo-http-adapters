import { Key, UnsupportedError, identityCodec, type Codec, type ExistingRecord, type QueryExecutor, type QueryPage, type ReadSession, type RecordSnapshot, type StructuredQuery } from "@dalgo/core";
import { compileD1Request, type D1Filter, type D1Json, type D1Order, type D1QueryRequest, type D1QueryResponse, type D1WireValue } from "./sql.js";
import { validateD1Schema, isD1Record } from "./database.js";
import type { D1Binding, D1DatabaseOptions, D1Table } from "./types.js";

const defaultRequestBytes = 1_048_576;
const defaultResponseBytes = 4_194_304;
const defaultTimeoutMs = 15_000;
const schemaHeader = "X-Dalgo-Schema-Version";
const seedHeader = "X-Dalgo-Seed-Version";
const protocolErrorCodes = new Set(["version_mismatch", "not_found", "unsupported_media_type", "request_too_large", "response_too_large", "invalid_request", "unsupported_query", "query_failed"]);

export interface D1Metadata {
  readonly version: 1;
  readonly schemaVersion?: string;
  readonly seedVersion?: string;
  readonly collections: readonly { readonly name: string; readonly columns: readonly string[]; readonly primaryKey: readonly string[] }[];
}

export type D1Headers = Readonly<Record<string, string>>;
export type D1HeaderProvider = D1Headers | (() => D1Headers | Promise<D1Headers>);
export interface D1HttpDatabaseOptions extends D1DatabaseOptions {
  readonly baseUrl: string;
  readonly headers?: D1HeaderProvider;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

export interface D1ReadHandlerOptions extends D1DatabaseOptions {
  readonly path?: string;
  readonly metadataPath?: string;
  readonly schemaVersion?: string;
  readonly seedVersion?: string;
  readonly allowedOrigins?: readonly string[];
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

export class D1HttpError extends Error {
  public readonly status: number;
  public readonly code: string;
  public constructor(status: number, code: string) {
    super(`D1 HTTP request failed (${String(status)} ${code})`);
    this.name = "D1HttpError";
    this.status = status;
    this.code = code;
  }
}

export class D1HttpRequestError extends Error {
  public constructor() { super("D1 HTTP request could not be completed"); this.name = "D1HttpRequestError"; }
}

function positive(value: number | undefined, fallback: number, name: string, max = 16_777_216): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new TypeError(`${name} must be a safe integer from 1 to ${String(max)}`);
  return result;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new D1HttpRequestError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(new D1HttpRequestError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => { signal.removeEventListener("abort", onAbort); });
  });
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void { void body?.cancel().catch(() => undefined); }

async function readBytes(body: ReadableStream<Uint8Array> | null, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await (signal === undefined ? reader.read() : abortable(reader.read(), signal));
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maxBytes) { void reader.cancel().catch(() => undefined); throw new RangeError("D1 HTTP body exceeds configured byte limit"); }
      chunks.push(item.value);
    }
  } finally {
    if (signal?.aborted) void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* Reader can stay busy while abort settles. */ }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function readJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBytes)) {
    cancelBody(response.body);
    throw new RangeError("D1 response exceeds maxResponseBytes");
  }
  const bytes = await readBytes(response.body, maxBytes, signal);
  if (bytes.byteLength === 0) return undefined;
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function checkJson(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new TypeError(`${label} has an unsafe number`);
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError(`${label} must not contain cycles`);
    seen.add(value);
    for (const item of value) checkJson(item, label, seen);
    seen.delete(value);
    return;
  }
  if (!plainObject(value)) throw new TypeError(`${label} must contain JSON values`);
  if (seen.has(value)) throw new TypeError(`${label} must not contain cycles`);
  seen.add(value);
  for (const item of Object.values(value)) checkJson(item, label, seen);
  seen.delete(value);
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromB64(value: string): Uint8Array {
  let binary: string;
  try { binary = atob(value); } catch { throw new TypeError("malformed D1 blob encoding"); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (b64(bytes) !== value) throw new TypeError("malformed D1 blob encoding");
  return bytes;
}

function wireValue(value: unknown): D1WireValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    checkJson(value, "D1 result");
    return value;
  }
  if (value instanceof ArrayBuffer) return { $type: "blob", base64: b64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) return { $type: "blob", base64: b64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  if (Array.isArray(value)) return value.map(wireValue);
  if (plainObject(value)) {
    if (Object.keys(value).length === 2 && value.$type === "blob" && typeof value.base64 === "string") throw new TypeError("D1 row uses a reserved blob tag object");
    const output: Record<string, D1WireValue> = {};
    for (const [key, item] of Object.entries(value)) output[key] = wireValue(item);
    return output;
  }
  throw new TypeError("D1 returned an unsupported result value");
}

function fromWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromWire);
  if (!plainObject(value)) return value;
  if (Object.hasOwn(value, "$type")) {
    if (Object.keys(value).length === 2 && value.$type === "blob" && typeof value.base64 === "string") return fromB64(value.base64);
    throw new TypeError("malformed D1 reserved wire tag");
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = fromWire(item);
  return result;
}

function httpStatus(error: unknown): number {
  if (error instanceof UnsupportedError) return 422;
  if (error instanceof RangeError || error instanceof TypeError || error instanceof SyntaxError) return 400;
  return 500;
}

function errorResponse(status: number, code: string, cors: HeadersInit = {}): Response {
  const safeCode = protocolErrorCodes.has(code) ? code : "query_failed";
  return Response.json({ version: 1, error: { code: safeCode, message: safeCode === "version_mismatch" ? "deployment version mismatch" : "request could not be processed" } }, { status, headers: cors });
}

function validateVersion(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 128 || /[\r\n]/u.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function metadata(tables: Readonly<Record<string, D1Table>>, schemaVersion?: string, seedVersion?: string): D1Metadata {
  return {
    version: 1,
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    ...(seedVersion === undefined ? {} : { seedVersion }),
    collections: Object.entries(tables).map(([name, table]) => ({ name, columns: Object.keys(table.columns), primaryKey: table.primaryKey })),
  };
}

function corsHeaders(request: Request, allowedOrigins: ReadonlySet<string>): Headers {
  const headers = new Headers({ vary: "Origin" });
  const origin = request.headers.get("origin");
  if (origin !== null && allowedOrigins.has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    headers.set("access-control-allow-headers", `content-type, ${schemaHeader}, ${seedHeader}`);
    headers.set("access-control-max-age", "600");
  }
  return headers;
}

function matchesExpected(request: Request, options: D1ReadHandlerOptions): boolean {
  const schema = request.headers.get(schemaHeader);
  const seed = request.headers.get(seedHeader);
  return (schema === null || options.schemaVersion === undefined || schema === options.schemaVersion) &&
    (seed === null || options.seedVersion === undefined || seed === options.seedVersion);
}

function requestDto(value: unknown, tables: Readonly<Record<string, D1Table>>): D1QueryRequest {
  if (!plainObject(value) || Object.keys(value).some((key) => !new Set(["version", "collection", "columns", "filters", "orders", "limit", "offset"]).has(key))) throw new TypeError("invalid D1 request shape");
  if (value.version !== 1 || typeof value.collection !== "string") throw new TypeError("invalid D1 request version or collection");
  const table = Object.hasOwn(tables, value.collection) ? tables[value.collection] : undefined;
  if (table === undefined) throw new UnsupportedError("D1 collection is not configured");
  const columns = value.columns;
  if (columns !== undefined && (!Array.isArray(columns) || !columns.every((column) => typeof column === "string" && Object.hasOwn(table.columns, column)))) throw new TypeError("invalid D1 projection");
  const filtersValue = value.filters ?? [];
  if (!Array.isArray(filtersValue)) throw new TypeError("invalid D1 filters");
  const allowedOperators = new Set(["==", "!=", "<", "<=", ">", ">=", "in", "not-in"]);
  const filters: D1Filter[] = filtersValue.map((filter) => {
    if (!plainObject(filter) || Object.keys(filter).some((key) => !["field", "operator", "value"].includes(key)) ||
      typeof filter.field !== "string" || (!Object.hasOwn(table.columns, filter.field) && !(filter.field === "__name__" && table.primaryKey.length === 1)) || typeof filter.operator !== "string" || !allowedOperators.has(filter.operator) || !Object.hasOwn(filter, "value")) throw new TypeError("invalid D1 filter");
    checkJson(filter.value, "D1 filter");
    return { field: filter.field, operator: filter.operator as D1Filter["operator"], value: filter.value as D1Json };
  });
  const ordersValue = value.orders ?? [];
  if (!Array.isArray(ordersValue)) throw new TypeError("invalid D1 orders");
  const orders: D1Order[] = ordersValue.map((order) => {
    if (!plainObject(order) || Object.keys(order).some((key) => !["field", "direction"].includes(key)) ||
      typeof order.field !== "string" || (!Object.hasOwn(table.columns, order.field) && !(order.field === "__name__" && table.primaryKey.length === 1)) || (order.direction !== "asc" && order.direction !== "desc")) throw new TypeError("invalid D1 order");
    return { field: order.field, direction: order.direction };
  });
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1)) throw new TypeError("invalid D1 limit");
  if (value.offset !== undefined && (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0)) throw new TypeError("invalid D1 offset");
  return {
    version: 1,
    collection: value.collection,
    ...(columns === undefined ? {} : { columns: columns as string[] }),
    ...(filters.length === 0 ? {} : { filters }),
    ...(orders.length === 0 ? {} : { orders }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
    ...(value.offset === undefined ? {} : { offset: value.offset as number }),
  };
}

/** Creates a read-only Worker-compatible HTTP handler for one explicit D1 schema. */
export function createD1ReadHandler(db: D1Binding, options: D1ReadHandlerOptions): (request: Request) => Promise<Response> {
  const tables = validateD1Schema(options.tables);
  const queryPath = options.path ?? "/v1/query";
  const metadataPath = options.metadataPath ?? "/v1/metadata";
  if (!queryPath.startsWith("/") || !metadataPath.startsWith("/") || queryPath === metadataPath) throw new TypeError("D1 handler paths must be distinct absolute paths");
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]")) throw new TypeError("D1 allowed origins must be HTTPS origins or loopback HTTP origins");
  }
  const schemaVersion = validateVersion(options.schemaVersion, "schemaVersion");
  const seedVersion = validateVersion(options.seedVersion, "seedVersion");
  const maxRequestBytes = positive(options.maxRequestBytes, defaultRequestBytes, "maxRequestBytes");
  const maxResponseBytes = positive(options.maxResponseBytes, defaultResponseBytes, "maxResponseBytes");
  const maxQueryLimit = positive(options.maxQueryLimit, 100, "maxQueryLimit", 1_000);
  return async (request: Request): Promise<Response> => {
    const cors = corsHeaders(request, allowedOrigins);
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET" && url.pathname === metadataPath) {
      if (!matchesExpected(request, { ...options, ...(schemaVersion === undefined ? {} : { schemaVersion }), ...(seedVersion === undefined ? {} : { seedVersion }) })) return errorResponse(409, "version_mismatch", cors);
      const payload = JSON.stringify(metadata(tables, schemaVersion, seedVersion));
      if (new TextEncoder().encode(payload).byteLength > maxResponseBytes) return errorResponse(413, "response_too_large", cors);
      return new Response(payload, { status: 200, headers: { ...Object.fromEntries(cors), "content-type": "application/json; charset=utf-8" } });
    }
    if (request.method !== "POST" || url.pathname !== queryPath) return errorResponse(404, "not_found", cors);
    if (!matchesExpected(request, { ...options, ...(schemaVersion === undefined ? {} : { schemaVersion }), ...(seedVersion === undefined ? {} : { seedVersion }) })) return errorResponse(409, "version_mismatch", cors);
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get("content-type") ?? "")) return errorResponse(415, "unsupported_media_type", cors);
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxRequestBytes)) return errorResponse(413, "request_too_large", cors);
    try {
      const bytes = await readBytes(request.body, maxRequestBytes, request.signal);
      const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      const dto = requestDto(decoded, tables);
      const table = tables[dto.collection];
      if (table === undefined) throw new TypeError("D1 collection disappeared");
      const compiled = compileD1Request(table, dto, maxQueryLimit);
      const statement = db.prepare(compiled.sql);
      const result = await (compiled.args.length === 0 ? statement : statement.bind(...compiled.args)).all();
      if (result.success === false || !Array.isArray(result.results)) throw new Error("D1 query failed");
      const records = result.results.map((row) => {
        if (!isD1Record(row)) throw new TypeError("D1 returned an invalid row");
        const output: Record<string, D1WireValue> = {};
        for (const [key, value] of Object.entries(row)) output[key] = wireValue(value);
        return output;
      });
      const payload: D1QueryResponse = { version: 1, columns: compiled.fields, primaryKey: table.primaryKey, records };
      const text = JSON.stringify(payload);
      if (new TextEncoder().encode(text).byteLength > maxResponseBytes) return errorResponse(413, "response_too_large", cors);
      return new Response(text, { status: 200, headers: { ...Object.fromEntries(cors), "content-type": "application/json; charset=utf-8" } });
    } catch (error) {
      const status = httpStatus(error);
      const code = status === 400 ? "invalid_request" : status === 422 ? "unsupported_query" : "query_failed";
      return errorResponse(status, code, cors);
    }
  };
}

function safeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("baseUrl must be an absolute URL"); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new TypeError("baseUrl must use HTTPS except for loopback HTTP");
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname.split("/").some((part) => part === "." || part === "..")) throw new TypeError("baseUrl must not contain credentials, dot segments, a query, or a fragment");
  return `${url.toString().replace(/\/+$/u, "")}/`;
}

function validateHeaders(headers: D1Headers): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string" || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) throw new TypeError("D1 configured headers must be CR/LF-safe strings");
  }
}

function primaryValues(table: D1Table, id: string | number, collection: string): readonly unknown[] {
  if (table.primaryKey.length === 0) throw new UnsupportedError(`D1 collection ${collection} has no primary key`);
  if (table.primaryKey.length === 1) return [id];
  if (typeof id !== "string") throw new UnsupportedError(`D1 composite key for ${collection} must use its JSON-array string form`);
  let value: unknown;
  try { value = JSON.parse(id) as unknown; } catch { throw new TypeError(`invalid D1 composite key for ${collection}`); }
  if (!Array.isArray(value) || value.length !== table.primaryKey.length) throw new TypeError(`invalid D1 composite key for ${collection}`);
  if (value.some((part) => part === null || part === undefined || (typeof part !== "string" && typeof part !== "boolean" &&
    !(typeof part === "number" && Number.isFinite(part) && (!Number.isInteger(part) || Number.isSafeInteger(part)))))) throw new TypeError(`invalid D1 composite key for ${collection}`);
  return value;
}

function recordKey(table: D1Table, collection: string, row: Readonly<Record<string, unknown>>, index: number): Key {
  const values = table.primaryKey.map((field) => row[field]);
  if (values.some((value) => value === undefined)) throw new TypeError("D1 response omitted primary key fields");
  if (values.length === 1) {
    const value = values[0];
    if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value))) throw new TypeError("D1 response contains an invalid primary key");
    return new Key(collection, value);
  }
  if (values.length === 0) return new Key(collection, JSON.stringify([index, row]));
  checkJson(values, "D1 primary key");
  return new Key(collection, JSON.stringify(values));
}

function rowData<T>(table: D1Table, row: Readonly<Record<string, unknown>>, codec?: Codec<T>, includePrimaryKey = false): T {
  const output = { ...row };
  const data = Object.fromEntries(Object.entries(output).filter(([field]) => includePrimaryKey || !table.primaryKey.includes(field)));
  return (codec ?? identityCodec as Codec<T>).decode(data);
}

function responseBody(value: unknown, collection: string, table: D1Table, maxRows: number): readonly Readonly<Record<string, unknown>>[] {
  if (!plainObject(value) || value.version !== 1 || !Array.isArray(value.columns) || !value.columns.every((column) => typeof column === "string") ||
    !Array.isArray(value.primaryKey) || JSON.stringify(value.primaryKey) !== JSON.stringify(table.primaryKey) ||
    !Array.isArray(value.records) || value.records.length > maxRows || !value.records.every(plainObject)) throw new TypeError(`malformed D1 response for ${collection}`);
  const columns = value.columns;
  const allowed = new Set(Object.keys(table.columns));
  const expectedColumns = Object.keys(table.columns);
  if (new Set(columns).size !== columns.length || columns.length !== expectedColumns.length || columns.some((column) => !allowed.has(column)) ||
    expectedColumns.some((field) => !columns.includes(field)) || table.primaryKey.some((field) => !columns.includes(field)) ||
    value.records.some((row) => Object.keys(row).length !== columns.length || columns.some((field) => !Object.hasOwn(row, field)))) throw new TypeError(`malformed D1 projection for ${collection}`);
  return value.records.map((item) => {
    const row = fromWire(item);
    if (!plainObject(row)) throw new TypeError(`malformed D1 row for ${collection}`);
    for (const field of table.primaryKey) {
      const key = row[field];
      if (key === null || key === undefined || (typeof key !== "string" && typeof key !== "boolean" && !(typeof key === "number" && Number.isFinite(key) && (!Number.isInteger(key) || Number.isSafeInteger(key))))) throw new TypeError(`malformed D1 primary key for ${collection}`);
    }
    checkJson(row, `D1 response row for ${collection}`);
    return row;
  });
}

/** Read-only DALgo client for a D1 Worker endpoint, usable from browsers and servers. */
export class D1HttpDatabase implements QueryExecutor, ReadSession {
  readonly #baseUrl: string;
  readonly #tables: Readonly<Record<string, D1Table>>;
  readonly #headers: D1HeaderProvider | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #signal: AbortSignal | undefined;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxQueryLimit: number;
  readonly #maxScanRows: number;
  readonly #scanPageSize: number;
  readonly #schemaVersion: string | undefined;
  readonly #seedVersion: string | undefined;

  public constructor(options: D1HttpDatabaseOptions) {
    this.#baseUrl = safeUrl(options.baseUrl);
    this.#tables = validateD1Schema(options.tables);
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#signal = options.signal;
    this.#timeoutMs = positive(options.timeoutMs, defaultTimeoutMs, "timeoutMs", 120_000);
    this.#maxRequestBytes = positive(options.maxRequestBytes, defaultRequestBytes, "maxRequestBytes");
    this.#maxResponseBytes = positive(options.maxResponseBytes, defaultResponseBytes, "maxResponseBytes");
    this.#maxQueryLimit = positive(options.maxQueryLimit, 100, "maxQueryLimit", 1_000);
    this.#maxScanRows = positive(options.maxScanRows, 10_000, "maxScanRows", 100_000);
    this.#scanPageSize = positive(options.scanPageSize, Math.min(500, this.#maxQueryLimit), "scanPageSize", this.#maxQueryLimit);
    this.#schemaVersion = options.expectedSchemaVersion;
    this.#seedVersion = options.expectedSeedVersion;
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("D1 nested or collection-group queries");
    const table = this.tableFor(query.source.name);
    const limit = query.limit ?? this.#maxQueryLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#maxScanRows + 1) throw new UnsupportedError(`D1 query limit above ${String(this.#maxScanRows + 1)}`);
    if (query.startAt !== undefined || query.startAfter !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("D1 DALgo query cursors");
    const filters: D1Filter[] = query.filters.map((filter) => ({ field: String(filter.field), operator: filter.operator as D1Filter["operator"], value: wireValue(filter.value) }));
    const orders: D1Order[] = query.orders.map((order) => ({ field: String(order.field), direction: order.direction }));
    const request: D1QueryRequest = {
      version: 1,
      collection: query.source.name,
      filters,
      orders,
      limit,
      ...(query.offset === undefined ? {} : { offset: query.offset }),
    };
    if (query.limit !== undefined && query.limit <= this.#maxQueryLimit) return this.readPage(request, query.source.name, table, query.source.codec);
    const records: ExistingRecord<T>[] = [];
    for await (const page of this.scanPages({ name: query.source.name, joins: [] }, { ...query, orders: query.orders })) {
      records.push(...page.records);
      if (records.length > this.#maxScanRows) throw new RangeError(`D1 scan exceeds maxScanRows ${String(this.#maxScanRows)}`);
    }
    return { records };
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    if (key.parent !== undefined) throw new UnsupportedError("D1 nested keys");
    const table = this.tableFor(key.collection);
    const values = primaryValues(table, key.id, key.collection);
    const filters = table.primaryKey.map((field, index) => ({ field, operator: "==" as const, value: values[index] as D1Json }));
    const payload = await this.request("/v1/query", { version: 1, collection: key.collection, filters, limit: 2 });
    const rows = responseBody(payload, key.collection, table, 2);
    if (rows.length > 1) throw new TypeError("D1 primary key query returned duplicate rows");
    const row = rows[0];
    return row === undefined ? { key, exists: false } : { key, exists: true, data: rowData(table, row, codec) };
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > 100) throw new UnsupportedError("D1 getMany above 100 keys");
    return Promise.all(keys.map((key) => this.get(key, codec)));
  }

  /** Pages a full leaf scan for DALgo's streaming joined-query executor. */
  public async *scanPages<T>(_relation: import("@dalgo/core").QueryRelation, query: StructuredQuery<T>): AsyncIterable<QueryPage<T>> {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("D1 nested or collection-group queries");
    const table = this.tableFor(query.source.name);
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > this.#maxScanRows + 1)) {
      throw new UnsupportedError(`D1 scan limit above ${String(this.#maxScanRows + 1)}`);
    }
    const budget = query.limit ?? this.#maxScanRows;
    const pageSize = Math.min(this.#scanPageSize, budget);
    let collected = 0;
    let offset = query.offset ?? 0;
    for (;;) {
      const remaining = budget - collected;
      const limit = Math.min(pageSize, query.limit === undefined ? remaining + 1 : remaining);
      const orders = query.orders.length === 0 && table.primaryKey.length > 0
        ? table.primaryKey.map((field) => ({ field, direction: "asc" as const }))
        : query.orders;
      const request: D1QueryRequest = {
        version: 1, collection: query.source.name,
        filters: query.filters.map((filter) => ({ field: String(filter.field), operator: filter.operator as D1Filter["operator"], value: wireValue(filter.value) })),
        orders: orders.map((order) => ({ field: String(order.field), direction: order.direction })),
        limit, offset,
      };
      const page = await this.readPage(request, query.source.name, table, query.source.codec);
      if (page.records.length > remaining) throw new RangeError(`D1 scan exceeds maxScanRows ${String(this.#maxScanRows)}`);
      if (page.records.length === 0) return;
      yield page;
      collected += page.records.length;
      offset += page.records.length;
      if (query.limit !== undefined && collected >= query.limit) return;
      if (page.records.length < limit) return;
      if (query.limit === undefined && collected === budget) {
        const probe: D1QueryRequest = { ...request, offset, limit: 1 };
        if ((await this.readPage(probe, query.source.name, table, query.source.codec)).records.length > 0) throw new RangeError(`D1 scan exceeds maxScanRows ${String(this.#maxScanRows)}`);
        return;
      }
    }
  }

  private async readPage<T>(request: D1QueryRequest, collection: string, table: D1Table, codec?: Codec<T>): Promise<QueryPage<T>> {
    const payload = await this.request("/v1/query", request);
    const rows = responseBody(payload, collection, table, request.limit ?? this.#maxQueryLimit);
    const offset = request.offset ?? 0;
    const records: ExistingRecord<T>[] = rows.map((raw, index) => ({ key: recordKey(table, collection, raw, offset + index), exists: true, data: rowData(table, raw, codec, true) }));
    return { records };
  }

  public async metadata(): Promise<D1Metadata> {
    const value = await this.request("/v1/metadata");
    if (!plainObject(value) || value.version !== 1 || !Array.isArray(value.collections) ||
      !value.collections.every((item) => plainObject(item) && typeof item.name === "string" && Array.isArray(item.columns) && item.columns.every((column) => typeof column === "string") && Array.isArray(item.primaryKey) && item.primaryKey.every((field) => typeof field === "string"))) throw new TypeError("malformed D1 metadata response");
    if (this.#schemaVersion !== undefined && value.schemaVersion !== this.#schemaVersion) throw new D1HttpError(409, "version_mismatch");
    if (this.#seedVersion !== undefined && value.seedVersion !== this.#seedVersion) throw new D1HttpError(409, "version_mismatch");
    const returned = new Map((value.collections as D1Metadata["collections"]).map((item) => [item.name, item]));
    if (returned.size !== Object.keys(this.#tables).length || Object.entries(this.#tables).some(([name, table]) => {
      const item = returned.get(name);
      return item === undefined || JSON.stringify(item.columns) !== JSON.stringify(Object.keys(table.columns)) || JSON.stringify(item.primaryKey) !== JSON.stringify(table.primaryKey);
    })) throw new TypeError("D1 metadata does not match the configured schema");
    return value as unknown as D1Metadata;
  }

  private tableFor(collection: string): D1Table {
    const table = Object.hasOwn(this.#tables, collection) ? this.#tables[collection] : undefined;
    if (table === undefined) throw new UnsupportedError(`D1 collection is not configured: ${collection}`);
    return table;
  }

  private async request(path: string, body?: D1QueryRequest): Promise<unknown> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined && new TextEncoder().encode(text).byteLength > this.#maxRequestBytes) throw new RangeError("D1 request exceeds maxRequestBytes");
    const controller = new AbortController();
    if (this.#signal?.aborted === true) throw new D1HttpRequestError();
    const onAbort = (): void => { controller.abort(); };
    this.#signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => { controller.abort(); }, this.#timeoutMs);
    try {
      const configured = typeof this.#headers === "function" ? await abortable(Promise.resolve(this.#headers()), controller.signal) : this.#headers;
      if (configured !== undefined) validateHeaders(configured);
      const headers = new Headers(configured);
      headers.set("accept", "application/json");
      if (body !== undefined) headers.set("content-type", "application/json");
      if (this.#schemaVersion !== undefined) headers.set(schemaHeader, this.#schemaVersion);
      if (this.#seedVersion !== undefined) headers.set(seedHeader, this.#seedVersion);
      const response = await abortable(this.#fetch(new URL(path.slice(1), this.#baseUrl), {
        method: body === undefined ? "GET" : "POST",
        headers,
        redirect: "error",
        ...(text === undefined ? {} : { body: text }),
        signal: controller.signal,
      }), controller.signal);
      if (!response.ok) {
        let code = "request_failed";
        try {
          const payload = await readJson(response, Math.min(this.#maxResponseBytes, 4096), controller.signal);
          if (plainObject(payload) && plainObject(payload.error) && typeof payload.error.code === "string" && protocolErrorCodes.has(payload.error.code)) code = payload.error.code;
        } catch { cancelBody(response.body); }
        throw new D1HttpError(response.status, code);
      }
      return await readJson(response, this.#maxResponseBytes, controller.signal);
    } catch (error) {
      if (error instanceof D1HttpError || error instanceof D1HttpRequestError || error instanceof RangeError || error instanceof TypeError) throw error;
      throw new D1HttpRequestError();
    } finally {
      clearTimeout(timeout);
      this.#signal?.removeEventListener("abort", onAbort);
    }
  }
}
