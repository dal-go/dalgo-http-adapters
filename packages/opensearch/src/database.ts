import {
  AlreadyExistsError,
  Key,
  NotFoundError,
  UnsupportedError,
  identityCodec,
  type Codec,
  type Database,
  type ExistingRecord,
  type QueryPage,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
  type WriteSession,
} from "@dal-go/dalgo";
import { compileOpenSearchQuery, validateOpenSearchIndex } from "./query.js";

const DEFAULT_MAX_QUERY_LIMIT = 1_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 30_000;

export type OpenSearchFetch = typeof globalThis.fetch;
export type OpenSearchHeaders = Readonly<Record<string, string>>;

export interface OpenSearchDatabaseOptions {
  readonly baseUrl: string;
  readonly headers?: OpenSearchHeaders | (() => OpenSearchHeaders | Promise<OpenSearchHeaders>);
  readonly fetch?: OpenSearchFetch;
  /** Maximum number of records a query may request. Defaults to 1,000. */
  readonly maxQueryLimit?: number;
  /** Maximum serialized JSON request-body size. Defaults to 1 MiB. */
  readonly maxRequestBytes?: number;
  /** Maximum response-body size accepted from OpenSearch. Defaults to 1 MiB. */
  readonly maxResponseBytes?: number;
  /** Per-request timeout. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

interface OpenSearchDocument<T = unknown> {
  readonly _id: string;
  readonly _index: string;
  readonly _source?: T;
  readonly found?: boolean;
  readonly sort?: readonly unknown[];
  readonly _seq_no?: number;
  readonly _primary_term?: number;
  readonly _version?: number;
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function validatePositiveInteger(value: number | undefined, name: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function validateStringId(id: unknown): asserts id is string {
  if (typeof id !== "string") throw new TypeError("OpenSearch DALgo key IDs must be strings");
}

function validateTopLevelKey(key: Key): void {
  if (key.parent !== undefined) throw new UnsupportedError("OpenSearch nested collection keys");
  validateStringId(key.id);
  validateOpenSearchIndex(key.collection);
}

function pathFor(key: Key, operation = "_doc"): string {
  validateTopLevelKey(key);
  return `/${encodeURIComponent(key.collection)}/${operation}/${encodeURIComponent(key.id)}`;
}

function metadata(document: OpenSearchDocument): Readonly<Record<string, unknown>> {
  return {
    index: document._index,
    ...(document._seq_no === undefined ? {} : { sequenceNumber: document._seq_no }),
    ...(document._primary_term === undefined ? {} : { primaryTerm: document._primary_term }),
    ...(document._version === undefined ? {} : { version: document._version }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function documentFrom(value: unknown, context: string): OpenSearchDocument {
  if (!isObject(value) || typeof value._id !== "string" || typeof value._index !== "string") {
    throw new TypeError(`malformed OpenSearch ${context} document`);
  }
  if (value.found !== undefined && typeof value.found !== "boolean") {
    throw new TypeError(`malformed OpenSearch ${context} found flag`);
  }
  if (value.sort !== undefined && !Array.isArray(value.sort)) {
    throw new TypeError(`malformed OpenSearch ${context} sort values`);
  }
  return value as unknown as OpenSearchDocument;
}

function sourceFrom(document: OpenSearchDocument, context: string): unknown {
  if (!Object.hasOwn(document, "_source")) {
    throw new UnsupportedError(`OpenSearch ${context} without _source`);
  }
  return document._source;
}

function documentsFromMultiGet(value: unknown): readonly OpenSearchDocument[] {
  if (!isObject(value) || !Array.isArray(value.docs)) {
    throw new TypeError("malformed OpenSearch _mget response");
  }
  return value.docs.map((document) => documentFrom(document, "_mget"));
}

function documentsFromSearch(value: unknown): readonly OpenSearchDocument[] {
  if (!isObject(value) || !isObject(value.hits) || !Array.isArray(value.hits.hits)) {
    throw new TypeError("malformed OpenSearch search response");
  }
  return value.hits.hits.map((document) => documentFrom(document, "search hit"));
}

function assertDocumentMatchesKey(document: OpenSearchDocument, key: Key, context: string): void {
  if (document._id !== key.id || document._index !== key.collection) {
    throw new TypeError(`OpenSearch ${context} response does not match requested key`);
  }
}

function validateConfiguredHeaders(headers: OpenSearchHeaders): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string" || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) {
      throw new TypeError("OpenSearch configured headers must be CR/LF-safe strings");
    }
  }
}

function serializeJson(value: unknown, maxBytes: number): string {
  let serialized: unknown;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError("OpenSearch request body must be JSON-serializable", { cause: error });
  }
  if (typeof serialized !== "string") throw new TypeError("OpenSearch request body must be JSON-serializable");
  const json = serialized;
  if (new TextEncoder().encode(json).byteLength > maxBytes) {
    throw new RangeError(`OpenSearch request body exceeds maxRequestBytes (${String(maxBytes)})`);
  }
  return json;
}

async function readResponse(response: Response, maxBytes: number): Promise<string> {
  const advertisedLength = response.headers.get("content-length");
  if (advertisedLength !== null && /^\d+$/u.test(advertisedLength) && Number(advertisedLength) > maxBytes) {
    await response.body?.cancel();
    throw new RangeError(`OpenSearch response exceeds maxResponseBytes (${String(maxBytes)})`);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new RangeError(`OpenSearch response exceeds maxResponseBytes (${String(maxBytes)})`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export class OpenSearchHttpError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super(`OpenSearch request failed with HTTP ${String(status)}`);
    this.name = "OpenSearchHttpError";
    this.status = status;
  }
}

export class OpenSearchDatabase implements Database, WriteSession {
  readonly #baseUrl: string;
  readonly #headers: OpenSearchDatabaseOptions["headers"];
  readonly #fetch: OpenSearchFetch;
  readonly #maxQueryLimit: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #timeoutMs: number;

  public constructor(options: OpenSearchDatabaseOptions) {
    const url = new URL(options.baseUrl.trim());
    const isLoopback = url.hostname === "localhost"
      || url.hostname === "127.0.0.1"
      || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
      throw new TypeError("baseUrl must use HTTPS, except for loopback development");
    }
    if (url.username.length > 0 || url.password.length > 0) {
      throw new TypeError("baseUrl must not contain credentials");
    }
    if (url.search.length > 0 || url.hash.length > 0) {
      throw new TypeError("baseUrl must not contain a query or fragment");
    }
    this.#baseUrl = url.toString().replace(/\/+$/u, "");
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxQueryLimit = validatePositiveInteger(options.maxQueryLimit, "maxQueryLimit", DEFAULT_MAX_QUERY_LIMIT);
    this.#maxRequestBytes = validatePositiveInteger(options.maxRequestBytes, "maxRequestBytes", DEFAULT_MAX_REQUEST_BYTES);
    this.#maxResponseBytes = validatePositiveInteger(options.maxResponseBytes, "maxResponseBytes", DEFAULT_MAX_RESPONSE_BYTES);
    this.#timeoutMs = validatePositiveInteger(options.timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS);
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const response = await this.request("GET", pathFor(key), undefined, [404]);
    const document = documentFrom(response.body, "get");
    assertDocumentMatchesKey(document, key, "get");
    if (response.status === 404 || document.found === false) return { key, exists: false };
    return { key, exists: true, data: codecOrIdentity(codec).decode(sourceFrom(document, "get response")), metadata: metadata(document) };
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    for (const key of keys) validateTopLevelKey(key);
    if (keys.length === 0) return [];
    const response = await this.request("POST", "/_mget", { docs: keys.map((key) => ({ _index: key.collection, _id: key.id })) });
    const documents = documentsFromMultiGet(response.body);
    if (documents.length !== keys.length) throw new OpenSearchHttpError(response.status);
    return documents.map((document, index) => {
      const key = keys[index];
      if (key === undefined) throw new Error("missing DALgo key for OpenSearch _mget result");
      assertDocumentMatchesKey(document, key, "_mget");
      if (document.found === false) return { key, exists: false };
      return { key, exists: true, data: codecOrIdentity(codec).decode(sourceFrom(document, "_mget response")), metadata: metadata(document) };
    });
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    const compiled = compileOpenSearchQuery(query, this.#maxQueryLimit);
    const response = await this.request("POST", `/${encodeURIComponent(query.source.name)}/_search`, compiled.body);
    const documents = documentsFromSearch(response.body);
    const records = documents.map((hit): ExistingRecord<T> => {
      if (hit._index !== query.source.name) throw new TypeError("OpenSearch search hit is not from the requested direct index");
      if (query.orders.length > 0 && hit.sort?.length !== query.orders.length) {
        throw new TypeError("OpenSearch search hit sort value count does not match query order count");
      }
      return { key: new Key(query.source.name, hit._id), exists: true, data: codecOrIdentity(query.source.codec).decode(sourceFrom(hit, "search hit")), metadata: metadata(hit) };
    });
    const last = documents.at(-1);
    const nextCursor = query.limit !== undefined && records.length === query.limit && last?.sort !== undefined
      ? { values: [...last.sort] }
      : undefined;
    return { records, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const response = await this.request("PUT", pathFor(key, "_create"), codecOrIdentity(codec).encode(data), [409]);
    if (response.status === 409) throw new AlreadyExistsError(key, { cause: new OpenSearchHttpError(409) });
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    await this.request("PUT", pathFor(key), codecOrIdentity(codec).encode(data));
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    const response = await this.request("POST", pathFor(key, "_update"), { doc: data }, [404]);
    if (response.status === 404) throw new NotFoundError(key, { cause: new OpenSearchHttpError(404) });
  }

  public async delete(key: Key): Promise<void> {
    await this.request("DELETE", pathFor(key), undefined, [404]);
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> {
    if (typeof callback !== "function") throw new TypeError("transaction callback is required");
    return Promise.reject(new UnsupportedError("OpenSearch multi-document transactions"));
  }

  private async request(method: string, path: string, body?: unknown, acceptedStatuses: readonly number[] = []): Promise<{ readonly status: number; readonly body: unknown }> {
    const configured = typeof this.#headers === "function" ? await this.#headers() : (this.#headers ?? {});
    validateConfiguredHeaders(configured);
    const serialized = body === undefined ? undefined : serializeJson(body, this.#maxRequestBytes);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error("OpenSearch request timed out"));
    }, this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          ...configured,
          accept: "application/json",
          ...(serialized === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(serialized === undefined ? {} : { body: serialized }),
      });
      const text = await readResponse(response, this.#maxResponseBytes);
      if (!response.ok && !acceptedStatuses.includes(response.status)) throw new OpenSearchHttpError(response.status);
      let parsed: unknown;
      try { parsed = text.length === 0 ? undefined : JSON.parse(text); } catch { parsed = text; }
      return { status: response.status, body: parsed };
    } finally {
      clearTimeout(timeout);
    }
  }
}
