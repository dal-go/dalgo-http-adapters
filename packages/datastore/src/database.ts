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
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
  type WriteSession,
} from "@dal-go/dalgo";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_GET_MANY = 1_000;
const DEFAULT_MAX_QUERY_LIMIT = 1_000;
const CURSOR_PREFIX = "dalgo-datastore:v2:";

export type DatastoreFetch = typeof globalThis.fetch;
export type DatastoreAccessTokenProvider = () => string | Promise<string>;

export interface DatastoreDatabaseOptions {
  readonly projectId: string;
  /** Datastore database ID. The Datastore-mode default is `(default)`. */
  readonly databaseId?: string;
  /** Namespace for every operation from this adapter instance. */
  readonly namespaceId?: string;
  /** Re-evaluated for every request. Return a short-lived Google OAuth access token. */
  readonly accessToken: DatastoreAccessTokenProvider;
  readonly fetch?: DatastoreFetch;
  /** For deterministic tests or a loopback proxy only. Defaults to Google's v1 endpoint. */
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxGetManyKeys?: number;
  readonly maxQueryLimit?: number;
}

type JsonObject = Record<string, unknown>;
type DatastoreValue = JsonObject;
type DatastoreKey = JsonObject;

export class DatastoreHttpError extends Error {
  public readonly status: number;
  public constructor(status: number) {
    super(`Datastore request failed with HTTP ${String(status)}`);
    this.name = "DatastoreHttpError";
    this.status = status;
  }
}

/** Redacted token, transport, redirect, timeout, body and malformed-response failure. */
export class DatastoreRequestError extends Error {
  public constructor() {
    super("Datastore request could not be completed");
    this.name = "DatastoreRequestError";
  }
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plainObject(value: unknown): value is JsonObject {
  return object(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function positive(value: number | undefined, fallback: number, label: string, maximum = 16_777_216): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`${label} must be a safe integer from 1 to ${String(maximum)}`);
  return result;
}

function identifier(value: string, label: string): string {
  if (value.length === 0 || value.length > 1_500 || Array.from(value).some((character) => (character.codePointAt(0) ?? 0) < 32)) throw new TypeError(`Datastore ${label} must be a non-empty control-character-free string`);
  return value;
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DatastoreRequestError());
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new DatastoreRequestError());
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function cancel(body: ReadableStream<Uint8Array> | null): void { void body?.cancel().catch(() => undefined); }

async function jsonBody(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) { cancel(response.body); throw new RangeError("Datastore response exceeds maxResponseBytes"); }
  if (response.body === null) throw new TypeError("Datastore response body is required");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) { void reader.cancel().catch(() => undefined); throw new RangeError("Datastore response exceeds maxResponseBytes"); }
      chunks.push(item.value);
    }
  } finally {
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* hostile streams can retain a lock */ }
  }
  if (size === 0) throw new TypeError("Datastore response body is required");
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function dataValue(value: unknown, seen = new Set<object>(), insideArray = false): DatastoreValue {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("Datastore numbers must be finite and not -0");
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    if (insideArray) throw new TypeError("Datastore values must not contain nested arrays");
    if (seen.has(value)) throw new TypeError("Datastore values must not contain cycles");
    seen.add(value); const values = value.map((item) => dataValue(item, seen, true)); seen.delete(value);
    return { arrayValue: { values } };
  }
  if (!plainObject(value)) throw new TypeError("Datastore values must be JSON primitives, arrays, or plain objects");
  if (seen.has(value)) throw new TypeError("Datastore values must not contain cycles");
  seen.add(value);
  const properties: JsonObject = {};
  for (const [name, item] of Object.entries(value)) properties[identifier(name, "property name")] = dataValue(item, seen, false);
  seen.delete(value);
  return { entityValue: { properties } };
}

function decodedValue(value: unknown, insideArray = false): unknown {
  if (!object(value)) throw new TypeError("malformed Datastore value");
  const fields = ["nullValue", "stringValue", "booleanValue", "integerValue", "doubleValue", "arrayValue", "entityValue"].filter((field) => Object.hasOwn(value, field));
  if (fields.length !== 1) throw new TypeError("malformed Datastore value type");
  const field = fields[0];
  if (field === "nullValue") return null;
  if (field === "stringValue" && typeof value.stringValue === "string") return value.stringValue;
  if (field === "booleanValue" && typeof value.booleanValue === "boolean") return value.booleanValue;
  if (field === "integerValue" && typeof value.integerValue === "string" && /^-?\d+$/u.test(value.integerValue)) {
    const integer = Number(value.integerValue); if (!Number.isSafeInteger(integer)) throw new TypeError("Datastore integer is outside JavaScript safe range"); return integer;
  }
  if (field === "doubleValue" && typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue) && !Object.is(value.doubleValue, -0)) return value.doubleValue;
  if (field === "arrayValue" && object(value.arrayValue)) {
    if (insideArray) throw new TypeError("malformed nested Datastore array value");
    const values = value.arrayValue.values; if (values !== undefined && !Array.isArray(values)) throw new TypeError("malformed Datastore array value");
    return (values ?? []).map((item) => decodedValue(item, true));
  }
  if (field === "entityValue" && object(value.entityValue) && object(value.entityValue.properties)) {
    return Object.fromEntries(Object.entries(value.entityValue.properties).map(([name, item]) => [name, decodedValue(item, false)]));
  }
  throw new TypeError("unsupported Datastore value type");
}

function pathFor(key: Key): readonly JsonObject[] {
  const result: JsonObject[] = [];
  for (let current: Key | undefined = key; current !== undefined; current = current.parent) {
    identifier(current.collection, "kind");
    if (typeof current.id === "string") { if (current.id.length === 0) throw new TypeError("Datastore key names must not be empty"); result.unshift({ kind: current.collection, name: current.id }); }
    else if (typeof current.id === "number" && Number.isSafeInteger(current.id) && current.id > 0) result.unshift({ kind: current.collection, id: String(current.id) });
    else throw new TypeError("Datastore DALgo key IDs must be non-empty strings or positive safe integers");
  }
  return result;
}

function equalPaths(left: readonly JsonObject[], right: readonly JsonObject[]): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function filterValue(filter: QueryFilter<unknown>, collection: string): DatastoreValue {
  if (filter.field !== DOCUMENT_ID) return dataValue(filter.value);
  if (typeof filter.value !== "string" && typeof filter.value !== "number") throw new TypeError("Datastore document-ID filters require a string or number key ID");
  return { keyValue: { path: pathFor(new Key(collection, filter.value)) } };
}

function propertyName(field: unknown): string {
  if (field === DOCUMENT_ID) return "__key__";
  if (typeof field !== "string") throw new UnsupportedError("Datastore non-string query fields");
  return identifier(field, "query property name");
}

function compileFilter(filter: QueryFilter<unknown>, collection: string): JsonObject {
  const operators: Record<string, string> = { "==": "EQUAL", "!=": "NOT_EQUAL", "<": "LESS_THAN", "<=": "LESS_THAN_OR_EQUAL", ">": "GREATER_THAN", ">=": "GREATER_THAN_OR_EQUAL", in: "IN", "not-in": "NOT_IN" };
  const operation = operators[String(filter.operator)];
  if (operation === undefined) throw new UnsupportedError(`Datastore ${String(filter.operator)} query filters`);
  if ((operation === "IN" || operation === "NOT_IN")) {
    if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 10) throw new TypeError("Datastore in and not-in filters require 1 to 10 values");
    return { propertyFilter: { property: { name: propertyName(filter.field) }, op: operation, value: { arrayValue: { values: filter.value.map((item) => filterValue({ ...filter, value: item }, collection)) } } } };
  }
  if (filter.value === undefined) throw new UnsupportedError("Datastore undefined query filters");
  return { propertyFilter: { property: { name: propertyName(filter.field) }, op: operation, value: filterValue(filter, collection) } };
}

function base64url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!object(value)) throw new TypeError("cursor fingerprint requires JSON data");
  return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonicalJson(value[name])}`).join(",")}}`;
}

function fingerprint(value: unknown, nonce: string): string {
  let hash = 0x811c9dc5;
  for (const character of `${nonce}\n${canonicalJson(value)}`) { hash ^= character.codePointAt(0) ?? 0; hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function opaqueCursor(raw: string, queryShape: unknown, secret: string): string {
  if (raw.length === 0) throw new DatastoreRequestError();
  return `${CURSOR_PREFIX}${base64url(JSON.stringify({ f: fingerprint({ queryShape, raw }, secret), c: raw }))}`;
}

function rawCursor(cursor: import("@dal-go/dalgo").QueryCursor, queryShape: unknown, secret: string): string {
  if (cursor.values.length !== 1 || typeof cursor.values[0] !== "string" || !cursor.values[0].startsWith(CURSOR_PREFIX)) {
    throw new UnsupportedError("Datastore cursors other than adapter-generated opaque cursors");
  }
  const encoded = cursor.values[0].slice(CURSOR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new UnsupportedError("Datastore malformed opaque cursor");
  try {
    const envelope: unknown = JSON.parse(fromBase64url(encoded));
    if (!object(envelope) || typeof envelope.f !== "string" || typeof envelope.c !== "string" || opaqueCursor(envelope.c, queryShape, secret) !== cursor.values[0]) throw new Error("invalid cursor envelope");
    return envelope.c;
  } catch {
    throw new UnsupportedError("Datastore malformed opaque cursor");
  }
}

function validateQuery<T>(query: StructuredQuery<T>): void {
  const operators = query.filters.map((filter) => filter.operator);
  const notEqual = query.filters.filter((filter) => filter.operator === "!=");
  const notIn = query.filters.filter((filter) => filter.operator === "not-in");
  const inFilters = query.filters.filter((filter) => filter.operator === "in");
  if (notEqual.length > 1 || notIn.length > 1 || inFilters.length > 1) throw new UnsupportedError("Datastore repeated disjunctive filters");
  if ((notEqual.length > 0 && notIn.length > 0) || (notIn.length > 0 && inFilters.length > 0)) throw new UnsupportedError("Datastore incompatible not-equal, not-in, and in filters");
  const inequalities = query.filters.filter((filter) => ["!=", "<", "<=", ">", ">=", "not-in"].includes(filter.operator));
  const inequalityFields = new Set(inequalities.map((filter) => propertyName(filter.field)));
  if (inequalityFields.size > 1) throw new UnsupportedError("Datastore inequalities on multiple properties");
  if (inequalities.length > 0) {
    const firstOrder = query.orders[0];
    const field = inequalities[0];
    if (firstOrder === undefined || field === undefined || propertyName(firstOrder.field) !== propertyName(field.field)) {
      throw new UnsupportedError("Datastore inequality filters without matching first order");
    }
  }
  const orderFields = new Set<string>();
  for (const order of query.orders) {
    const field = propertyName(order.field);
    if (orderFields.has(field)) throw new UnsupportedError("Datastore duplicate order properties");
    orderFields.add(field);
  }
  for (const filter of query.filters) {
    if (filter.value === undefined) throw new UnsupportedError("Datastore undefined query filters");
    if (filter.value === null && filter.operator !== "==") throw new UnsupportedError("Datastore null filters other than equality");
    if (["in", "not-in"].includes(filter.operator) && (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 10)) {
      throw new TypeError("Datastore in and not-in filters require 1 to 10 values");
    }
  }
  void operators;
}

export class DatastoreDatabase implements Database, WriteSession {
  readonly #projectId: string; readonly #databaseId: string; readonly #namespaceId: string | undefined;
  readonly #accessToken: DatastoreAccessTokenProvider; readonly #fetch: DatastoreFetch; readonly #baseUrl: string;
  readonly #timeoutMs: number; readonly #maxRequestBytes: number; readonly #maxResponseBytes: number; readonly #maxGetMany: number; readonly #maxQueryLimit: number;
  readonly #cursorSecret: string;

  public constructor(options: DatastoreDatabaseOptions) {
    this.#projectId = identifier(options.projectId, "project ID"); this.#databaseId = identifier(options.databaseId ?? "(default)", "database ID");
    this.#namespaceId = options.namespaceId === undefined ? undefined : identifier(options.namespaceId, "namespace ID");
    if (typeof options.accessToken !== "function") throw new TypeError("accessToken must be a function returning a short-lived OAuth token"); this.#accessToken = options.accessToken;
    const base = new URL(options.apiBaseUrl ?? "https://datastore.googleapis.com/v1/"); const loopback = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]";
    if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) throw new TypeError("apiBaseUrl must use HTTPS, except for loopback development");
    if (base.username || base.password || base.search || base.hash) throw new TypeError("apiBaseUrl must not contain credentials, query, or fragment"); this.#baseUrl = `${base.toString().replace(/\/+$/u, "")}/`;
    this.#fetch = options.fetch ?? globalThis.fetch; this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 120_000);
    this.#maxRequestBytes = positive(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, "maxRequestBytes"); this.#maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
    this.#maxGetMany = positive(options.maxGetManyKeys, DEFAULT_MAX_GET_MANY, "maxGetManyKeys", 1_000); this.#maxQueryLimit = positive(options.maxQueryLimit, DEFAULT_MAX_QUERY_LIMIT, "maxQueryLimit", 1_000);
    const secret = new Uint32Array(4); crypto.getRandomValues(secret); this.#cursorSecret = Array.from(secret, (part) => part.toString(16).padStart(8, "0")).join("");
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> { return (await this.getMany([key], codec))[0] as RecordSnapshot<T>; }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#maxGetMany) throw new UnsupportedError(`Datastore getMany above ${String(this.#maxGetMany)} keys`); if (keys.length === 0) return [];
    const paths = keys.map(pathFor); const response = await this.call("lookup", { databaseId: this.requestDatabaseId(), keys: paths.map((path) => this.wireKey(path)) });
    if (!object(response) || (response.deferred !== undefined && (!Array.isArray(response.deferred) || response.deferred.length > 0))) throw new DatastoreRequestError();
    const found = response.found ?? []; const missing = response.missing ?? []; if (!Array.isArray(found) || !Array.isArray(missing)) throw new DatastoreRequestError();
    const byPath = new Map<string, { readonly exists: boolean; readonly entity?: JsonObject }>();
    for (const item of found) { const entity = this.entityFromResult(item); const encoded = this.pathFromWire(entity.key); const token = JSON.stringify(encoded); if (byPath.has(token)) throw new DatastoreRequestError(); byPath.set(token, { exists: true, entity }); }
    for (const item of missing) { if (!object(item) || !object(item.entity)) throw new DatastoreRequestError(); const token = JSON.stringify(this.pathFromWire(item.entity.key)); if (byPath.has(token)) throw new DatastoreRequestError(); byPath.set(token, { exists: false }); }
    return keys.map((key, index) => { const path = paths[index]; if (path === undefined) throw new Error("Datastore key disappeared"); const result = byPath.get(JSON.stringify(path)); if (result === undefined) throw new DatastoreRequestError(); return result.exists ? this.snapshot(key, result.entity as JsonObject, codec) : { key, exists: false }; });
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> { try { await this.commit({ insert: this.entity(key, data, codec) }); } catch (error) { if (error instanceof DatastoreHttpError && error.status === 409) throw new AlreadyExistsError(key, { cause: error }); throw error; } }
  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> { await this.commit({ upsert: this.entity(key, data, codec) }); }
  public async update(key: Key, data: UpdateData): Promise<void> { void key; void data; throw new UnsupportedError("Datastore partial update without an atomic field-mask mapping"); }
  public async delete(key: Key): Promise<void> { await this.commit({ delete: this.wireKey(pathFor(key)) }); }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    if (query.source.kind !== "collection") throw new UnsupportedError("Datastore collection-group queries");
    if (query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("Datastore inclusive or end query cursors");
    const collection = identifier(query.source.name, "kind"); const limit = query.limit ?? this.#maxQueryLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#maxQueryLimit) throw new UnsupportedError(`Datastore query limit above ${String(this.#maxQueryLimit)}`);
    if (query.offset !== undefined && (!Number.isSafeInteger(query.offset) || query.offset < 0)) throw new TypeError("Datastore query offset must be a non-negative safe integer");
    validateQuery(query);
    const filters = query.filters.map((filter) => compileFilter(filter as QueryFilter<unknown>, collection));
    const parent = query.source.parent === undefined ? undefined : this.wireKey(pathFor(query.source.parent));
    const allFilters = parent === undefined ? filters : [{ propertyFilter: { property: { name: "__key__" }, op: "HAS_ANCESTOR", value: { keyValue: parent } } }, ...filters];
    const wireQuery: JsonObject = { kind: [{ name: collection }], limit, ...(allFilters.length === 0 ? {} : { filter: allFilters.length === 1 ? allFilters[0] : { compositeFilter: { op: "AND", filters: allFilters } } }), ...(query.orders.length === 0 ? {} : { order: query.orders.map((order) => { if (order.direction !== "asc" && order.direction !== "desc") throw new UnsupportedError("Datastore query order direction"); return { property: { name: propertyName(order.field) }, direction: order.direction === "asc" ? "ASCENDING" : "DESCENDING" }; }) }), ...(query.offset === undefined ? {} : { offset: query.offset }) };
    const queryShape = { projectId: this.#projectId, databaseId: this.requestDatabaseId(), namespaceId: this.#namespaceId ?? "", query: wireQuery };
    const body: JsonObject = { databaseId: this.requestDatabaseId(), partitionId: { ...(this.#namespaceId === undefined ? {} : { namespaceId: this.#namespaceId }) }, query: { ...wireQuery, ...(query.startAfter === undefined ? {} : { startCursor: rawCursor(query.startAfter, queryShape, this.#cursorSecret) }) } };
    const response = await this.call("runQuery", body); if (!object(response) || !object(response.batch)) throw new DatastoreRequestError(); const batch = response.batch;
    if (!Array.isArray(batch.entityResults) || typeof batch.moreResults !== "string" || !new Set(["NOT_FINISHED", "MORE_RESULTS_AFTER_LIMIT", "MORE_RESULTS_AFTER_CURSOR", "NO_MORE_RESULTS", "MORE_RESULTS_TYPE_UNSPECIFIED"]).has(batch.moreResults)) throw new DatastoreRequestError();
    if (batch.entityResults.length > limit || (batch.moreResults !== "NO_MORE_RESULTS" && (batch.moreResults === "MORE_RESULTS_TYPE_UNSPECIFIED" || typeof batch.endCursor !== "string" || batch.endCursor.length === 0))) throw new DatastoreRequestError();
    const records = batch.entityResults.map((item) => { const entity = this.entityFromResult(item); const key = this.keyFromPath(this.pathFromWire(entity.key)); return this.snapshot(key, entity, query.source.codec); });
    return { records, ...(batch.moreResults === "NO_MORE_RESULTS" ? {} : { nextCursor: { values: [opaqueCursor(batch.endCursor as string, queryShape, this.#cursorSecret)] } }) };
  }

  public async runReadwriteTransaction<Result>(callback: (transaction: import("@dal-go/dalgo").ReadwriteTransaction) => Promise<Result>): Promise<Result> { void callback; throw new UnsupportedError("Datastore callback transactions"); }

  private wireKey(path: readonly JsonObject[]): DatastoreKey { return { partitionId: { projectId: this.#projectId, databaseId: this.#databaseId, ...(this.#namespaceId === undefined ? {} : { namespaceId: this.#namespaceId }) }, path }; }
  private entity<T>(key: Key, data: T, codec?: Codec<T>): JsonObject { const encoded = codecOrIdentity(codec).encode(data); if (!plainObject(encoded)) throw new TypeError("Datastore DALgo records must encode to a plain object"); const properties: JsonObject = {}; for (const [name, value] of Object.entries(encoded)) properties[identifier(name, "property name")] = dataValue(value); return { key: this.wireKey(pathFor(key)), properties }; }
  private requestDatabaseId(): string { return this.#databaseId === "(default)" ? "" : this.#databaseId; }
  private async commit(mutation: JsonObject): Promise<void> { const response = await this.call("commit", { databaseId: this.requestDatabaseId(), mode: "NON_TRANSACTIONAL", mutations: [mutation] }); if (!object(response) || !Array.isArray(response.mutationResults) || response.mutationResults.length !== 1) throw new DatastoreRequestError(); }
  private entityFromResult(value: unknown): JsonObject { if (!object(value) || !object(value.entity) || !object(value.entity.key) || !object(value.entity.properties)) throw new DatastoreRequestError(); return value.entity; }
  private pathFromWire(value: unknown): readonly JsonObject[] { if (!object(value) || !Array.isArray(value.path) || value.path.length === 0 || !value.path.every(object)) throw new DatastoreRequestError(); return value.path; }
  private keyFromPath(path: readonly JsonObject[]): Key { let result: Key | undefined; for (const segment of path) { if (typeof segment.kind !== "string") throw new DatastoreRequestError(); const id = typeof segment.name === "string" ? segment.name : typeof segment.id === "string" && /^\d+$/u.test(segment.id) ? Number(segment.id) : undefined; if (id === undefined || (typeof id === "number" && (!Number.isSafeInteger(id) || id <= 0))) throw new DatastoreRequestError(); result = new Key(segment.kind, id, result); } if (result === undefined) throw new DatastoreRequestError(); return result; }
  private snapshot<T>(key: Key, entity: JsonObject, codec?: Codec<T>): ExistingRecord<T> { const path = this.pathFromWire(entity.key); if (!equalPaths(path, pathFor(key))) throw new DatastoreRequestError(); let data: Record<string, unknown>; try { data = Object.fromEntries(Object.entries(entity.properties as JsonObject).map(([name, value]) => [name, decodedValue(value)])); } catch { throw new DatastoreRequestError(); } return { key, exists: true, data: codecOrIdentity(codec).decode(data) }; }
  private async call(action: string, body: JsonObject): Promise<unknown> { const text = JSON.stringify(body); if (new TextEncoder().encode(text).byteLength > this.#maxRequestBytes) throw new RangeError("Datastore request exceeds maxRequestBytes"); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.#timeoutMs); try { const rawToken = await abortable(Promise.resolve().then(() => this.#accessToken()), controller.signal); if (typeof rawToken !== "string" || rawToken.length === 0 || /[\r\n]/u.test(rawToken)) throw new TypeError("Datastore access token must be a non-empty CR/LF-safe string"); const response = await abortable(Promise.resolve().then(() => this.#fetch(new URL(`projects/${encodeURIComponent(this.#projectId)}:${action}`, this.#baseUrl), { method: "POST", headers: { authorization: `Bearer ${rawToken}`, "content-type": "application/json", accept: "application/json" }, body: text, redirect: "error", signal: controller.signal })), controller.signal); if (!response.ok) { cancel(response.body); throw new DatastoreHttpError(response.status); } return await jsonBody(response, this.#maxResponseBytes, controller.signal); } catch (error) { if (error instanceof DatastoreHttpError || error instanceof DatastoreRequestError) throw error; throw new DatastoreRequestError(); } finally { clearTimeout(timeout); } }
}
