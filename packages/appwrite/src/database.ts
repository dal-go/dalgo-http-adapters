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
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
} from "@dal-go/dalgo";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_GET_MANY = 100;
const DEFAULT_MAX_PARALLEL_READS = 8;
const DEFAULT_MAX_QUERY_LIMIT = 100;

export type AppwriteFetch = typeof globalThis.fetch;
export type AppwriteHeaders = Readonly<Record<string, string>>;
export type AppwriteHeaderProvider = AppwriteHeaders | (() => AppwriteHeaders | Promise<AppwriteHeaders>);
export type AppwriteCredentialMode = "browser-session" | "trusted-server";

export interface AppwriteDatabaseOptions {
  /** Appwrite API endpoint, including `/v1` (for example `https://cloud.appwrite.io/v1`). */
  readonly endpoint: string;
  readonly projectId: string;
  readonly databaseId: string;
  /** Defaults to browser-session, which sends fetch credentials for Appwrite's session cookie. */
  readonly credentialMode?: AppwriteCredentialMode;
  /** Required only in trusted-server mode. Never pass an Appwrite API key to browser code. */
  readonly apiKey?: string;
  /** Re-evaluated per request: use this for a browser JWT, not an Appwrite API key. */
  readonly headers?: AppwriteHeaderProvider;
  readonly fetch?: AppwriteFetch;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxGetManyKeys?: number;
  readonly maxParallelReads?: number;
  readonly maxQueryLimit?: number;
}

/** Deliberately excludes Appwrite response bodies, which may contain application data. */
export class AppwriteHttpError extends Error {
  public constructor(public readonly status: number) {
    super(`Appwrite request failed with HTTP ${String(status)}`);
    this.name = "AppwriteHttpError";
  }
}

/** Redacted failure obtaining credentials, making a request, or reading a response. */
export class AppwriteRequestError extends Error {
  public constructor() {
    super("Appwrite request could not be completed");
    this.name = "AppwriteRequestError";
  }
}

function positive(value: number | undefined, fallback: number, name: string, maximum = 16_777_216): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`${name} must be a safe integer from 1 to ${String(maximum)}`);
  return result;
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function json(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("Appwrite JSON numbers must be finite and not -0");
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Appwrite JSON must not contain cycles");
    seen.add(value); for (const item of value) json(item, seen); seen.delete(value); return;
  }
  if (!plainObject(value) || seen.has(value)) throw new TypeError("Appwrite JSON must contain only plain objects, arrays, and primitives");
  seen.add(value); for (const item of Object.values(value)) json(item, seen); seen.delete(value);
}

function rowData<T>(data: T, codec: Codec<T>): Record<string, unknown> {
  const encoded = codec.encode(data);
  if (!plainObject(encoded)) throw new TypeError("Appwrite DALgo records must encode to a non-null plain JSON object");
  for (const field of Object.keys(encoded)) if (field.startsWith("$")) throw new TypeError("Appwrite record data must not contain Appwrite system fields");
  json(encoded);
  return encoded;
}

function tableId(collection: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/u.test(collection)) throw new UnsupportedError("Appwrite table IDs outside Appwrite's ID syntax");
  return collection;
}

function rowId(key: Key): string {
  if (key.parent !== undefined) throw new UnsupportedError("Appwrite nested DALgo keys");
  if (typeof key.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/u.test(key.id)) throw new UnsupportedError("Appwrite row IDs outside Appwrite's ID syntax");
  return key.id;
}

function field(value: unknown): string {
  if (value === DOCUMENT_ID) return "$id";
  if (typeof value !== "string" || !/^[A-Za-zA-Z][A-Za-zA-Z0-9_]{0,35}$/u.test(value)) throw new UnsupportedError("Appwrite query field names");
  return value;
}

function queryValue(value: unknown): unknown {
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") throw new UnsupportedError("Appwrite query value types");
  json(value);
  return value;
}

interface AppwriteQuery { readonly method: string; readonly column?: string; readonly values?: readonly unknown[]; }

function queryWire(query: AppwriteQuery): string { return JSON.stringify(query); }

function compileFilter<T>(filter: QueryFilter<T>): AppwriteQuery {
  const name = field(filter.field);
  const one = (): readonly unknown[] => [queryValue(filter.value)];
  const many = (): readonly unknown[] => {
    if (!Array.isArray(filter.value) || filter.value.length === 0) throw new TypeError("Appwrite in query filters require a non-empty array");
    return filter.value.map(queryValue);
  };
  switch (filter.operator) {
    case "==": return { method: "equal", column: name, values: one() };
    case "!=": return { method: "notEqual", column: name, values: one() };
    case "<": return { method: "lessThan", column: name, values: one() };
    case "<=": return { method: "lessThanEqual", column: name, values: one() };
    case ">": return { method: "greaterThan", column: name, values: one() };
    case ">=": return { method: "greaterThanEqual", column: name, values: one() };
    case "in": return { method: "equal", column: name, values: many() };
    case "not-in": return { method: "notEqual", column: name, values: many() };
    case "array-contains": return { method: "contains", column: name, values: one() };
    default: throw new UnsupportedError(`Appwrite ${String(filter.operator)} query filters`);
  }
}

function validateHeaders(headers: AppwriteHeaders): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string" || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) throw new TypeError("Appwrite configured headers must be CR/LF-safe strings");
    if (name.toLowerCase() === "x-appwrite-key") throw new TypeError("Appwrite API keys require explicit trusted-server credential mode");
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AppwriteRequestError());
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new AppwriteRequestError());
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function cancel(body: ReadableStream<Uint8Array> | null): void { void body?.cancel().catch(() => undefined); }

async function readJson(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) { cancel(response.body); throw new RangeError("Appwrite response exceeds maxResponseBytes"); }
  if (response.body === null) return undefined;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) { void reader.cancel().catch(() => undefined); throw new RangeError("Appwrite response exceeds maxResponseBytes"); }
      chunks.push(item.value);
    }
  } finally { if (signal.aborted) void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* cancellation can retain a read */ } }
  const bytes = new Uint8Array(total); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes.byteLength === 0 ? undefined : JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export class AppwriteDatabase implements Database {
  readonly #base: string; readonly #projectId: string; readonly #credentialMode: AppwriteCredentialMode; readonly #apiKey: string | undefined; readonly #headers: AppwriteHeaderProvider | undefined;
  readonly #fetch: AppwriteFetch; readonly #timeoutMs: number; readonly #maxRequestBytes: number; readonly #maxResponseBytes: number;
  readonly #maxGetManyKeys: number; readonly #maxParallelReads: number; readonly #maxQueryLimit: number;

  public constructor(options: AppwriteDatabaseOptions) {
    const endpoint = new URL(options.endpoint.trim());
    const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && local)) throw new TypeError("endpoint must use HTTPS, except for loopback development");
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new TypeError("endpoint must not contain credentials, a query, or a fragment");
    if (!options.projectId || !options.databaseId) throw new TypeError("projectId and databaseId are required");
    tableId(options.databaseId);
    const credentialMode = options.credentialMode ?? "browser-session";
    if (credentialMode !== "browser-session" && credentialMode !== "trusted-server") throw new TypeError("credentialMode must be browser-session or trusted-server");
    if (credentialMode === "browser-session" && options.apiKey !== undefined) throw new TypeError("Appwrite API keys require trusted-server credential mode");
    if (credentialMode === "trusted-server" && (!options.apiKey || /[\r\n]/u.test(options.apiKey))) throw new TypeError("trusted-server mode requires a CR/LF-safe API key");
    this.#base = `${endpoint.toString().replace(/\/+$/u, "")}/tablesdb/${encodeURIComponent(options.databaseId)}/tables/`;
    this.#projectId = options.projectId; this.#credentialMode = credentialMode; this.#apiKey = options.apiKey; this.#headers = options.headers; this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 120_000);
    this.#maxRequestBytes = positive(options.maxRequestBytes, DEFAULT_MAX_BYTES, "maxRequestBytes"); this.#maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_MAX_BYTES, "maxResponseBytes");
    this.#maxGetManyKeys = positive(options.maxGetManyKeys, DEFAULT_MAX_GET_MANY, "maxGetManyKeys", 1_000);
    this.#maxParallelReads = positive(options.maxParallelReads, Math.min(DEFAULT_MAX_PARALLEL_READS, this.#maxGetManyKeys), "maxParallelReads", this.#maxGetManyKeys);
    this.#maxQueryLimit = positive(options.maxQueryLimit, DEFAULT_MAX_QUERY_LIMIT, "maxQueryLimit", 1_000);
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    try { return this.record(await this.request(this.rowUrl(key), "GET", undefined, true), key, codec); }
    catch (error) { if (error instanceof AppwriteHttpError && error.status === 404) return { key, exists: false }; throw error; }
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#maxGetManyKeys) throw new UnsupportedError(`Appwrite getMany above ${String(this.#maxGetManyKeys)} keys`);
    const result: RecordSnapshot<T>[] = new Array(keys.length); let next = 0;
    const worker = async (): Promise<void> => { for (;;) { const index = next++; const item = keys[index]; if (item === undefined) return; result[index] = await this.get(item, codec); } };
    await Promise.all(Array.from({ length: Math.min(keys.length, this.#maxParallelReads) }, worker)); return result;
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    try { await this.request(this.rowsUrl(key.collection), "POST", { rowId: rowId(key), data: rowData(data, codecOrIdentity(codec)) }, false); }
    catch (error) { if (error instanceof AppwriteHttpError && error.status === 409) throw new AlreadyExistsError(key, { cause: error }); throw error; }
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    await this.request(this.rowUrl(key), "PUT", { data: rowData(data, codecOrIdentity(codec)) }, false);
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    try { await this.request(this.rowUrl(key), "PATCH", { data: rowData(data, identityCodec as Codec<UpdateData>) }, false); }
    catch (error) { if (error instanceof AppwriteHttpError && error.status === 404) throw new NotFoundError(key, { cause: error }); throw error; }
  }

  public async delete(key: Key): Promise<void> {
    try { await this.request(this.rowUrl(key), "DELETE", undefined, false); }
    catch (error) { if (error instanceof AppwriteHttpError && error.status === 404) return; throw error; }
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("Appwrite collection-group or nested-collection queries");
    if (query.startAt !== undefined || query.startAfter !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("Appwrite DALgo query cursors");
    const limit = query.limit ?? this.#maxQueryLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#maxQueryLimit) throw new UnsupportedError(`Appwrite query limit above ${String(this.#maxQueryLimit)}`);
    if (query.offset !== undefined && (!Number.isSafeInteger(query.offset) || query.offset < 0)) throw new TypeError("Appwrite query offset must be a non-negative safe integer");
    const url = this.rowsUrl(query.source.name); for (const item of query.filters) url.searchParams.append("queries[]", queryWire(compileFilter(item)));
    for (const order of query.orders) { if (order.direction !== "asc" && order.direction !== "desc") throw new UnsupportedError("Appwrite query order directions"); url.searchParams.append("queries[]", queryWire({ method: order.direction === "asc" ? "orderAsc" : "orderDesc", column: field(order.field) })); }
    url.searchParams.append("queries[]", queryWire({ method: "limit", values: [limit] })); if (query.offset !== undefined) url.searchParams.append("queries[]", queryWire({ method: "offset", values: [query.offset] }));
    const payload = await this.request(url, "GET", undefined, true);
    if (!plainObject(payload) || !Array.isArray(payload.rows) || !payload.rows.every(plainObject)) throw new AppwriteRequestError();
    return { records: payload.rows.map((row) => this.record(row, undefined, query.source.codec, query.source.name)) };
  }

  public async runReadwriteTransaction<Result>(callback: (transaction: import("@dal-go/dalgo").ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    void callback; throw new UnsupportedError("Appwrite callback transactions");
  }

  private rowsUrl(collection: string): URL { return new URL(`${encodeURIComponent(tableId(collection))}/rows`, this.#base); }
  private rowUrl(key: Key): URL { return new URL(`${encodeURIComponent(tableId(key.collection))}/rows/${encodeURIComponent(rowId(key))}`, this.#base); }

  private async request(url: URL, method: string, body: unknown | undefined, decode: boolean): Promise<unknown> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined && new TextEncoder().encode(text).byteLength > this.#maxRequestBytes) throw new RangeError("Appwrite request exceeds maxRequestBytes");
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const provided = await abortable(Promise.resolve().then(() => typeof this.#headers === "function" ? this.#headers() : this.#headers), controller.signal);
      if (provided !== undefined) validateHeaders(provided);
      const headers = new Headers(provided); headers.set("x-appwrite-project", this.#projectId); headers.set("accept", "application/json");
      if (this.#apiKey !== undefined) headers.set("x-appwrite-key", this.#apiKey);
      if (text !== undefined) headers.set("content-type", "application/json");
      const response = await abortable(this.#fetch(url, { method, headers, redirect: "error", credentials: this.#credentialMode === "browser-session" ? "include" : "omit", ...(text === undefined ? {} : { body: text }), signal: controller.signal }), controller.signal);
      if (!response.ok) { cancel(response.body); throw new AppwriteHttpError(response.status); }
      if (!decode) { cancel(response.body); return undefined; }
      return await readJson(response, this.#maxResponseBytes, controller.signal);
    } catch (error) { if (error instanceof AppwriteHttpError || error instanceof AppwriteRequestError || error instanceof AlreadyExistsError || error instanceof NotFoundError) throw error; throw new AppwriteRequestError(); }
    finally { clearTimeout(timeout); }
  }

  private record<T>(row: unknown, requested: Key | undefined, codec?: Codec<T>, collection?: string): ExistingRecord<T> {
    if (!plainObject(row) || typeof row.$id !== "string") throw new AppwriteRequestError();
    const parsed = requested ?? new Key(collection ?? (() => { throw new AppwriteRequestError(); })(), row.$id);
    if (requested !== undefined && row.$id !== rowId(requested)) throw new AppwriteRequestError();
    const data = { ...row }; for (const name of Object.keys(data)) if (name.startsWith("$")) delete data[name];
    return { key: parsed, exists: true, data: codecOrIdentity(codec).decode(data) };
  }
}
