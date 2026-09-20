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
import { compileElasticsearchQuery, validateElasticsearchIndex } from "./query.js";

export type ElasticsearchFetch = typeof globalThis.fetch;
export type ElasticsearchHeaders = Readonly<Record<string, string>>;

export interface ElasticsearchDatabaseOptions {
  readonly baseUrl: string;
  readonly headers?: ElasticsearchHeaders | (() => ElasticsearchHeaders | Promise<ElasticsearchHeaders>);
  readonly fetch?: ElasticsearchFetch;
}

interface ElasticsearchDocument<T = unknown> {
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

function validateTopLevelKey(key: Key): void {
  if (key.parent !== undefined) throw new UnsupportedError("Elasticsearch nested collection keys");
  validateElasticsearchIndex(key.collection);
}

function pathFor(key: Key, operation = "_doc"): string {
  validateTopLevelKey(key);
  return `/${encodeURIComponent(key.collection)}/${operation}/${encodeURIComponent(String(key.id))}`;
}

function metadata(document: ElasticsearchDocument): Readonly<Record<string, unknown>> {
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

function documentFrom(value: unknown, context: string): ElasticsearchDocument {
  if (!isObject(value) || typeof value._id !== "string" || typeof value._index !== "string") {
    throw new TypeError(`malformed Elasticsearch ${context} document`);
  }
  if (value.found !== undefined && typeof value.found !== "boolean") {
    throw new TypeError(`malformed Elasticsearch ${context} found flag`);
  }
  if (value.sort !== undefined && !Array.isArray(value.sort)) {
    throw new TypeError(`malformed Elasticsearch ${context} sort values`);
  }
  return value as unknown as ElasticsearchDocument;
}

function sourceFrom(document: ElasticsearchDocument, context: string): unknown {
  if (!Object.hasOwn(document, "_source")) {
    throw new UnsupportedError(`Elasticsearch ${context} without _source`);
  }
  return document._source;
}

function documentsFromMultiGet(value: unknown): readonly ElasticsearchDocument[] {
  if (!isObject(value) || !Array.isArray(value.docs)) {
    throw new TypeError("malformed Elasticsearch _mget response");
  }
  return value.docs.map((document) => documentFrom(document, "_mget"));
}

function documentsFromSearch(value: unknown): readonly ElasticsearchDocument[] {
  if (!isObject(value) || !isObject(value.hits) || !Array.isArray(value.hits.hits)) {
    throw new TypeError("malformed Elasticsearch search response");
  }
  return value.hits.hits.map((document) => documentFrom(document, "search hit"));
}

export class ElasticsearchHttpError extends Error {
  public readonly status: number;
  public readonly body: unknown;

  public constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ElasticsearchHttpError";
    this.status = status;
    this.body = body;
  }
}

export class ElasticsearchDatabase implements Database, WriteSession {
  readonly #baseUrl: string;
  readonly #headers: ElasticsearchDatabaseOptions["headers"];
  readonly #fetch: ElasticsearchFetch;

  public constructor(options: ElasticsearchDatabaseOptions) {
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
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const response = await this.request("GET", pathFor(key), undefined, [404]);
    if (response.status === 404) return { key, exists: false };
    const document = documentFrom(response.body, "get");
    if (document.found === false) return { key, exists: false };
    return {
      key,
      exists: true,
      data: codecOrIdentity(codec).decode(sourceFrom(document, "get response")),
      metadata: metadata(document),
    };
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    for (const key of keys) validateTopLevelKey(key);
    if (keys.length === 0) return [];
    const response = await this.request("POST", "/_mget", {
      docs: keys.map((key) => ({ _index: key.collection, _id: String(key.id) })),
    });
    const documents = documentsFromMultiGet(response.body);
    if (documents.length !== keys.length) {
      throw new ElasticsearchHttpError(response.status, "Elasticsearch _mget returned an unexpected document count", response.body);
    }
    return documents.map((document, index) => {
      const key = keys[index];
      if (key === undefined) throw new Error("missing DALgo key for Elasticsearch _mget result");
      if (document.found === false) return { key, exists: false };
      return {
        key,
        exists: true,
        data: codecOrIdentity(codec).decode(sourceFrom(document, "_mget response")),
        metadata: metadata(document),
      };
    });
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    const compiled = compileElasticsearchQuery(query);
    const response = await this.request(
      "POST",
      `/${encodeURIComponent(query.source.name)}/_search`,
      compiled.body,
    );
    const documents = documentsFromSearch(response.body);
    const records = documents.map((hit): ExistingRecord<T> => {
      return {
        key: new Key(query.source.name, hit._id),
        exists: true,
        data: codecOrIdentity(query.source.codec).decode(sourceFrom(hit, "search hit")),
        metadata: metadata(hit),
      };
    });
    const last = documents.at(-1);
    const nextCursor = query.limit !== undefined
      && records.length === query.limit
      && last?.sort !== undefined
      ? { values: [...last.sort] }
      : undefined;
    return { records, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const response = await this.request("PUT", pathFor(key, "_create"), codecOrIdentity(codec).encode(data), [409]);
    if (response.status === 409) throw new AlreadyExistsError(key, { cause: new ElasticsearchHttpError(409, "document already exists", response.body) });
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    await this.request("PUT", pathFor(key), codecOrIdentity(codec).encode(data));
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    const response = await this.request("POST", pathFor(key, "_update"), { doc: data }, [404]);
    if (response.status === 404) throw new NotFoundError(key, { cause: new ElasticsearchHttpError(404, "document not found", response.body) });
  }

  public async delete(key: Key): Promise<void> {
    await this.request("DELETE", pathFor(key), undefined, [404]);
  }

  public runReadwriteTransaction<Result>(
    callback: (transaction: ReadwriteTransaction) => Promise<Result>,
  ): Promise<Result> {
    if (typeof callback !== "function") throw new TypeError("transaction callback is required");
    return Promise.reject(new UnsupportedError("Elasticsearch multi-document transactions"));
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    acceptedStatuses: readonly number[] = [],
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const configured = typeof this.#headers === "function" ? await this.#headers() : (this.#headers ?? {});
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      redirect: "error",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...configured,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      throw new ElasticsearchHttpError(response.status, `Elasticsearch request failed with HTTP ${String(response.status)}`, parsed);
    }
    return { status: response.status, body: parsed };
  }
}
