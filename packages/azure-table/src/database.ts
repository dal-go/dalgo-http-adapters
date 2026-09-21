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
  type QueryCursor,
  type QueryFilter,
  type QueryPage,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
} from "@dal-go/dalgo";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_QUERY_LIMIT = 1_000;

export type AzureTableFetch = typeof globalThis.fetch;
export type AzureTableHeaders = Readonly<Record<string, string>>;
export type AzureTableAuthorization = (request: AzureTableAuthorizationRequest) => string | Promise<string>;

export interface AzureTableAuthorizationRequest {
  readonly method: string;
  readonly url: string;
  readonly date: string;
  readonly serviceVersion: string;
}

export interface AzureTableOptions {
  /** Existing Table service endpoint, optionally with the Azurite account path. */
  readonly endpoint: string;
  /** Supplies an OAuth bearer or other HTTP authorization header for every request. */
  readonly authorization: AzureTableAuthorization;
  /** Maps a top-level DALgo collection name to an existing Azure table name. */
  readonly tableName?: (collection: string) => string;
  /** Maps each collection to one string PartitionKey. Defaults to the collection name. */
  readonly partitionKey?: (collection: string) => string;
  readonly serviceVersion?: string;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxGetManyKeys?: number;
  readonly maxParallelReads?: number;
  readonly maxQueryLimit?: number;
  readonly fetch?: AzureTableFetch;
  readonly now?: () => Date;
}

interface Options extends Required<Omit<AzureTableOptions, "tableName" | "partitionKey" | "fetch" | "now">> {
  readonly tableName: (collection: string) => string;
  readonly partitionKey: (collection: string) => string;
  readonly fetch: AzureTableFetch;
  readonly now: () => Date;
  readonly endpoint: string;
}

interface AzureCursor {
  readonly adapter: "@dal-go/dalgo2azure-table";
  readonly version: 1;
  readonly endpoint: string;
  readonly table: string;
  readonly partition: string;
  /** Exact canonical filter and $top used to obtain this service continuation. */
  readonly queryShape: string;
  readonly nextPartitionKey: string;
  readonly nextRowKey?: string;
}

/** Deliberately excludes Azure error bodies, which may contain user data. */
export class AzureTableHttpError extends Error {
  public readonly status: number;
  public constructor(status: number) {
    super(`Azure Table Storage request failed with HTTP ${String(status)}`);
    this.name = "AzureTableHttpError";
    this.status = status;
  }
}

/** A redacted transport, authorization, timeout, or response-consumption failure. */
export class AzureTableRequestError extends Error {
  public constructor() { super("Azure Table Storage request could not be completed"); this.name = "AzureTableRequestError"; }
}

function positive(value: number | undefined, fallback: number, field: string, maximum = 16_777_216): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`${field} must be a safe integer from 1 to ${String(maximum)}`);
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }

function keyId(value: unknown): asserts value is string | number {
  if (typeof value === "string") return;
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return;
  throw new TypeError("Azure Table DALgo key IDs must be strings or safe integers, excluding -0");
}

function rowKey(id: string | number): string {
  keyId(id);
  const bytes = new TextEncoder().encode(JSON.stringify(id));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=/gu, "");
}

function table(value: string): string {
  // Azure table names are 3-63 alphanumeric chars and start with a letter.
  if (!/^[A-Za-z][A-Za-z0-9]{2,62}$/u.test(value)) throw new TypeError("Azure Table names must start with a letter and contain 3-63 alphanumeric characters");
  return value;
}

function partition(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || hasControlCharacter(value)) {
    throw new TypeError("Azure Table PartitionKey must be a non-empty control-character-free string of at most 1024 characters");
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function field(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,254}$/u.test(value) || ["PartitionKey", "RowKey", "Timestamp", "odata"].includes(value)) {
    throw new UnsupportedError("Azure Table property names");
  }
  return value;
}

function scalar(value: unknown, context: string): string | number | boolean {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  throw new UnsupportedError(`Azure Table ${context} values must be strings, booleans, or finite numbers`);
}

function entity<T>(key: Key, partitionKey: string, data: T, codec?: Codec<T>): Record<string, unknown> {
  if (key.parent !== undefined) throw new UnsupportedError("Azure Table nested DALgo keys");
  keyId(key.id);
  const encoded = codecOrIdentity(codec).encode(data);
  if (!isPlainObject(encoded)) throw new TypeError("Azure Table DALgo data must encode to a non-null plain object with scalar properties");
  const result: Record<string, unknown> = { PartitionKey: partitionKey, RowKey: rowKey(key.id) };
  for (const [name, value] of Object.entries(encoded)) {
    const property = field(name);
    result[property] = scalar(value, "entity property");
  }
  return result;
}

function odataString(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function filter<T>(item: QueryFilter<T>): string {
  const property = item.field === DOCUMENT_ID ? "RowKey" : field(item.field);
  const value = item.field === DOCUMENT_ID ? (() => { keyId(item.value); return rowKey(item.value); })() : scalar(item.value, "filter");
  const literal = typeof value === "string" ? odataString(value) : String(value);
  const operator: Record<string, string> = { "==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge" };
  const mapped = operator[item.operator];
  if (mapped === undefined) throw new UnsupportedError(`Azure Table ${item.operator} filters`);
  return `${property} ${mapped} ${literal}`;
}

function validateHeaders(headers: AzureTableHeaders): void {
  for (const [name, value] of Object.entries(headers)) if (typeof value !== "string" || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) throw new TypeError("Azure Table headers must be CR/LF-safe strings");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AzureTableRequestError());
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => reject(new AzureTableRequestError());
    signal.addEventListener("abort", cancel, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

async function readJson(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) { void response.body?.cancel(); throw new RangeError("Azure Table response exceeds maxResponseBytes"); }
  if (response.body === null) return undefined;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) { void reader.cancel(); throw new RangeError("Azure Table response exceeds maxResponseBytes"); }
      chunks.push(next.value);
    }
  } finally { if (signal.aborted) void reader.cancel(); try { reader.releaseLock(); } catch { /* cancellation retains a lock in some implementations */ } }
  if (total === 0) return undefined;
  const output = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(output)) as unknown;
}

export class AzureTableDatabase implements Database {
  readonly #options: Options;
  public constructor(options: AzureTableOptions) {
    const url = new URL(options.endpoint.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new TypeError("endpoint must use HTTPS, except for loopback development");
    if (url.username || url.password || url.search || url.hash) throw new TypeError("endpoint must not contain credentials, a query, or a fragment");
    this.#options = {
      endpoint: url.toString().replace(/\/+$/u, "") + "/", authorization: options.authorization,
      tableName: options.tableName ?? ((collection) => collection), partitionKey: options.partitionKey ?? ((collection) => collection),
      serviceVersion: options.serviceVersion ?? "2019-02-02", timeoutMs: positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 120_000),
      maxRequestBytes: positive(options.maxRequestBytes, DEFAULT_MAX_BYTES, "maxRequestBytes"), maxResponseBytes: positive(options.maxResponseBytes, DEFAULT_MAX_BYTES, "maxResponseBytes"),
      maxGetManyKeys: positive(options.maxGetManyKeys, 100, "maxGetManyKeys", 1_000), maxParallelReads: positive(options.maxParallelReads, Math.min(8, options.maxGetManyKeys ?? 100), "maxParallelReads", options.maxGetManyKeys ?? 100),
      maxQueryLimit: positive(options.maxQueryLimit, 100, "maxQueryLimit", DEFAULT_MAX_QUERY_LIMIT), fetch: options.fetch ?? globalThis.fetch, now: options.now ?? (() => new Date()),
    };
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const { tableName, partitionKey } = this.mapping(key);
    try { return this.record(await this.request(this.entityUrl(tableName, partitionKey, key.id), "GET"), key, codec, undefined, partitionKey); }
    catch (error) { if (error instanceof AzureTableHttpError && error.status === 404) return { key, exists: false }; throw error; }
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#options.maxGetManyKeys) throw new UnsupportedError(`Azure Table getMany above ${String(this.#options.maxGetManyKeys)} keys`);
    const output: RecordSnapshot<T>[] = new Array(keys.length); let index = 0;
    const worker = async (): Promise<void> => { for (;;) { const current = index++; const key = keys[current]; if (key === undefined) return; output[current] = await this.get(key, codec); } };
    await Promise.all(Array.from({ length: Math.min(keys.length, this.#options.maxParallelReads) }, worker)); return output;
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const { tableName, partitionKey } = this.mapping(key);
    try { await this.request(this.tableUrl(tableName), "POST", entity(key, partitionKey, data, codec)); }
    catch (error) { if (error instanceof AzureTableHttpError && error.status === 409) throw new AlreadyExistsError(key, { cause: error }); throw error; }
  }

  /** Insert-or-replace. Use setIfMatch for optimistic ETag concurrency. */
  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const { tableName, partitionKey } = this.mapping(key);
    await this.request(this.entityUrl(tableName, partitionKey, key.id), "PUT", entity(key, partitionKey, data, codec));
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    const { tableName, partitionKey } = this.mapping(key);
    const patch = entity(key, partitionKey, data);
    try { await this.request(this.entityUrl(tableName, partitionKey, key.id), "MERGE", patch, { "if-match": "*" }); }
    catch (error) { if (error instanceof AzureTableHttpError && error.status === 404) throw new NotFoundError(key, { cause: error }); throw error; }
  }

  public async delete(key: Key): Promise<void> {
    const { tableName, partitionKey } = this.mapping(key);
    try { await this.request(this.entityUrl(tableName, partitionKey, key.id), "DELETE", undefined, { "if-match": "*" }); }
    catch (error) { if (error instanceof AzureTableHttpError && error.status === 404) return; throw error; }
  }

  /** Replaces only when the entity still has the ETag returned by get/query. */
  public async setIfMatch<T>(key: Key, data: T, etag: string, codec?: Codec<T>): Promise<void> { await this.conditional(key, "PUT", entity(key, this.mapping(key).partitionKey, data, codec), etag); }
  /** Merges only when the entity still has the ETag returned by get/query. */
  public async updateIfMatch(key: Key, data: UpdateData, etag: string): Promise<void> { await this.conditional(key, "MERGE", entity(key, this.mapping(key).partitionKey, data), etag); }
  /** Deletes only when the entity still has the ETag returned by get/query. */
  public async deleteIfMatch(key: Key, etag: string): Promise<void> { await this.conditional(key, "DELETE", undefined, etag); }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("Azure Table collection-group or nested-collection queries");
    if (query.orders.length > 0 || query.offset !== undefined || query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("Azure Table DALgo ordering, offsets, or inclusive/end cursors");
    const tableName = table(this.#options.tableName(query.source.name)); const partitionKey = partition(this.#options.partitionKey(query.source.name));
    const limit = query.limit ?? this.#options.maxQueryLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#options.maxQueryLimit) throw new UnsupportedError(`Azure Table query limit above ${String(this.#options.maxQueryLimit)}`);
    if (query.filters.length > 14) throw new UnsupportedError("Azure Table queries with more than 15 comparisons");
    const url = this.tableUrl(tableName);
    const clauses = [`PartitionKey eq ${odataString(partitionKey)}`, ...query.filters.map(filter)];
    const queryShape = JSON.stringify({ filter: clauses, top: limit });
    const cursor = this.cursor(query.startAfter, tableName, partitionKey, queryShape);
    url.searchParams.set("$filter", clauses.join(" and ")); url.searchParams.set("$top", String(limit));
    if (cursor !== undefined) { url.searchParams.set("NextPartitionKey", cursor.nextPartitionKey); if (cursor.nextRowKey !== undefined) url.searchParams.set("NextRowKey", cursor.nextRowKey); }
    const result = await this.request(url, "GET");
    if (!isPlainObject(result.body) || !Array.isArray(result.body.value) || !result.body.value.every(isPlainObject)) throw new TypeError("Azure Table query response must contain a value array of entity objects");
    const records = result.body.value.map((item) => this.record({ body: item, headers: result.headers }, undefined, query.source.codec, query.source.name, partitionKey));
    const nextPartitionKey = result.headers.get("x-ms-continuation-NextPartitionKey"); const nextRowKey = result.headers.get("x-ms-continuation-NextRowKey");
    const nextCursor = nextPartitionKey === null || nextPartitionKey.length === 0 ? undefined : { values: [{ adapter: "@dal-go/dalgo2azure-table", version: 1, endpoint: this.#options.endpoint, table: tableName, partition: partitionKey, queryShape, nextPartitionKey, ...(nextRowKey === null || nextRowKey.length === 0 ? {} : { nextRowKey }) } satisfies AzureCursor] };
    return nextCursor === undefined ? { records } : { records, nextCursor };
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    if (typeof callback !== "function") return Promise.reject(new TypeError("transaction callback is required"));
    return Promise.reject(new UnsupportedError("Azure Table callback transactions; entity group transactions are limited to one physical PartitionKey and cannot preserve DALgo callback retry semantics"));
  }

  private mapping(key: Key): { tableName: string; partitionKey: string } { if (key.parent !== undefined) throw new UnsupportedError("Azure Table nested DALgo keys"); return { tableName: table(this.#options.tableName(key.collection)), partitionKey: partition(this.#options.partitionKey(key.collection)) }; }
  private tableUrl(tableName: string): URL { return new URL(encodeURIComponent(tableName), this.#options.endpoint); }
  private entityUrl(tableName: string, partitionKey: string, id: string | number): URL { keyId(id); return new URL(`${encodeURIComponent(tableName)}(PartitionKey=${encodeURIComponent(odataString(partitionKey))},RowKey=${encodeURIComponent(odataString(rowKey(id)))})`, this.#options.endpoint); }
  private async conditional(key: Key, method: string, body: unknown, etag: string): Promise<void> { if (etag.length === 0 || /[\r\n]/u.test(etag)) throw new TypeError("ETag must be a non-empty CR/LF-safe string"); const mapping = this.mapping(key); await this.request(this.entityUrl(mapping.tableName, mapping.partitionKey, key.id), method, body, { "if-match": etag }); }
  private cursor(cursor: QueryCursor | undefined, tableName: string, partitionKey: string, queryShape: string): AzureCursor | undefined {
    if (cursor === undefined) return undefined;
    if (cursor.values.length !== 1 || !isPlainObject(cursor.values[0])) throw new TypeError("Azure Table startAfter must be a cursor returned by this adapter");
    const value = cursor.values[0];
    if (value.adapter !== "@dal-go/dalgo2azure-table" || value.version !== 1 || value.endpoint !== this.#options.endpoint || value.table !== tableName || value.partition !== partitionKey || value.queryShape !== queryShape || typeof value.nextPartitionKey !== "string" || value.nextPartitionKey.length === 0 || (value.nextRowKey !== undefined && typeof value.nextRowKey !== "string")) throw new TypeError("Azure Table startAfter does not belong to this exact endpoint, table, partition, and query");
    return value as unknown as AzureCursor;
  }
  private record<T>(response: { body: unknown; headers: Headers }, requestedKey: Key | undefined, codec?: Codec<T>, collection?: string, expectedPartition?: string): ExistingRecord<T> {
    if (!isPlainObject(response.body) || typeof response.body.PartitionKey !== "string" || typeof response.body.RowKey !== "string") throw new TypeError("Azure Table response must be an entity with PartitionKey and RowKey");
    if (expectedPartition !== undefined && response.body.PartitionKey !== expectedPartition) throw new TypeError("Azure Table response PartitionKey does not match the configured mapping");
    let key: Key;
    if (requestedKey !== undefined) { if (response.body.RowKey !== rowKey(requestedKey.id)) throw new TypeError("Azure Table response does not match requested DALgo key"); key = requestedKey; }
    else { if (collection === undefined) throw new Error("Azure Table query record collection is required"); const id = decodeRowKey(response.body.RowKey); key = new Key(collection, id); }
    const data: Record<string, unknown> = { ...response.body }; delete data.PartitionKey; delete data.RowKey; delete data.Timestamp; delete data["odata.etag"];
    for (const [name, value] of Object.entries(data)) { field(name); scalar(value, "response property"); }
    const etag = typeof response.body["odata.etag"] === "string" ? response.body["odata.etag"] : response.headers.get("etag") ?? undefined;
    return { key, exists: true, data: codecOrIdentity(codec).decode(data), metadata: etag === undefined ? {} : { etag } };
  }
  private async request(url: URL, method: string, body?: unknown, extraHeaders: AzureTableHeaders = {}): Promise<{ body: unknown; headers: Headers }> {
    let serialized: string | undefined;
    if (body !== undefined) { serialized = JSON.stringify(body); if (new TextEncoder().encode(serialized).byteLength > this.#options.maxRequestBytes) throw new RangeError("Azure Table request exceeds maxRequestBytes"); }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs);
    try {
      const date = this.#options.now().toUTCString();
      const authorization = await abortable(Promise.resolve().then(() => this.#options.authorization({ method, url: url.toString(), date, serviceVersion: this.#options.serviceVersion })), controller.signal);
      validateHeaders({ authorization, ...extraHeaders });
      const response = await abortable(Promise.resolve().then(() => this.#options.fetch(url.toString(), { method, redirect: "error", signal: controller.signal, headers: { accept: "application/json;odata=fullmetadata", "x-ms-date": date, "x-ms-version": this.#options.serviceVersion, authorization, ...extraHeaders, ...(serialized === undefined ? {} : { "content-type": "application/json" }) }, ...(serialized === undefined ? {} : { body: serialized }) })), controller.signal);
      if (!response.ok) { void response.body?.cancel(); throw new AzureTableHttpError(response.status); }
      return { body: await readJson(response, this.#options.maxResponseBytes, controller.signal), headers: response.headers };
    } catch (error) { if (error instanceof AzureTableHttpError || error instanceof AzureTableRequestError || error instanceof RangeError || error instanceof TypeError || error instanceof UnsupportedError || error instanceof AlreadyExistsError || error instanceof NotFoundError) throw error; throw new AzureTableRequestError(); }
    finally { clearTimeout(timer); }
  }
}

function decodeRowKey(value: string): string | number {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError("Azure Table response has an invalid DALgo RowKey");
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - value.length % 4) % 4);
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)))); } catch { throw new TypeError("Azure Table response has an invalid DALgo RowKey"); }
  keyId(decoded); return decoded;
}
