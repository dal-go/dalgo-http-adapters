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
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
} from "@dal-go/dalgo";
import { compileNeptuneQuery, cursorFromNode } from "./query.js";
import { assertNode, assertPropertyMap, collectionForKey, dalgoId, isPlainRecord, neptuneId, validateBaseUrl } from "./validation.js";
import type { NeptuneCollectionOptions, NeptuneDatabaseOptions, NeptuneNode, ResolvedCollection } from "./types.js";
import { NeptuneQueryError } from "./types.js";

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }

function collectionMap(values: Readonly<Record<string, NeptuneCollectionOptions>>): ReadonlyMap<string, ResolvedCollection> {
  const collections = new Map<string, ResolvedCollection>();
  for (const [collection, configuration] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(collection)) throw new TypeError("Neptune collection name must be a simple identifier");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(configuration.label)) throw new TypeError("Neptune node label must be a simple identifier");
    const idPrefix = configuration.idPrefix ?? `${collection}:`;
    if (idPrefix.length === 0) throw new TypeError("Neptune idPrefix must not be empty");
    collections.set(collection, { collection, label: configuration.label, idPrefix });
  }
  if (collections.size === 0) throw new TypeError("at least one Neptune collection must be configured");
  const prefixes = new Set<string>();
  for (const item of collections.values()) {
    if (prefixes.has(item.idPrefix)) throw new TypeError("each Neptune collection needs a distinct idPrefix");
    prefixes.add(item.idPrefix);
  }
  return collections;
}

function recordFromNode<T>(key: Key, node: NeptuneNode, collection: ResolvedCollection, codec?: Codec<T>): ExistingRecord<T> {
  if (!node.labels.includes(collection.label) || dalgoId(collection, node.id) !== key.id) throw new TypeError("Neptune response node does not match the requested DALgo key");
  return { key, exists: true, data: codecOrIdentity(codec).decode(node.properties) };
}

function propertyMap<T>(data: T, codec?: Codec<T>): Readonly<Record<string, string | number | boolean>> {
  const encoded = codecOrIdentity(codec).encode(data);
  assertPropertyMap(encoded, "Neptune node properties");
  return encoded;
}

export class NeptuneDatabase implements Database {
  readonly #baseUrl: URL;
  readonly #collections: ReadonlyMap<string, ResolvedCollection>;
  readonly #headers: NeptuneDatabaseOptions["headers"];
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  public constructor(options: NeptuneDatabaseOptions) {
    this.#baseUrl = validateBaseUrl(options.baseUrl);
    this.#collections = collectionMap(options.collections);
    this.#headers = options.headers;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) throw new RangeError("Neptune timeoutMs must be a safe integer between 1 and 60000");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const collection = collectionForKey(this.#collections, key);
    const nodes = this.nodes(await this.execute(`MATCH (n:\`${collection.label}\` {\`~id\`: $id}) RETURN n AS node LIMIT 2`, { id: neptuneId(collection, key.id) }), collection);
    if (nodes.length === 0) return { key, exists: false };
    if (nodes.length !== 1) throw new TypeError("Neptune custom node IDs are not unique");
    const node = nodes[0];
    if (node === undefined) throw new TypeError("Neptune returned an empty node result");
    return recordFromNode(key, node, collection, codec);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> { return Promise.all(keys.map(async (key) => this.get(key, codec))); }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    const compiled = compileNeptuneQuery(query, this.#collections);
    const nodes = this.nodes(await this.execute(compiled.statement, compiled.parameters), compiled.collection);
    const records = nodes.map((node): ExistingRecord<T> => {
      const id = dalgoId(compiled.collection, node.id);
      return recordFromNode(new Key(compiled.collection.collection, id), node, compiled.collection, query.source.codec);
    });
    const last = nodes.at(-1);
    const nextCursor = query.limit !== undefined && nodes.length === query.limit && last !== undefined
      ? cursorFromNode({ "~id": last.id, ...last.properties }, compiled.orders, compiled.collection) : undefined;
    return { records, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const collection = collectionForKey(this.#collections, key);
    try {
      const nodes = this.nodes(await this.execute(`CREATE (n:\`${collection.label}\` {\`~id\`: $id}) SET n = $properties RETURN n AS node`, { id: neptuneId(collection, key.id), properties: propertyMap(data, codec) }), collection);
      if (nodes.length !== 1) throw new TypeError("Neptune insert did not return exactly one node");
    } catch (error) {
      if (error instanceof NeptuneQueryError && error.code?.includes("DuplicateDataException") === true) throw new AlreadyExistsError(key, { cause: error });
      throw error;
    }
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const collection = collectionForKey(this.#collections, key);
    const nodes = this.nodes(await this.execute(`MERGE (n:\`${collection.label}\` {\`~id\`: $id}) SET n = $properties RETURN n AS node`, { id: neptuneId(collection, key.id), properties: propertyMap(data, codec) }), collection);
    if (nodes.length !== 1) throw new TypeError("Neptune set did not return exactly one node");
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    const collection = collectionForKey(this.#collections, key);
    assertPropertyMap(data, "Neptune update data");
    const nodes = this.nodes(await this.execute(`MATCH (n:\`${collection.label}\` {\`~id\`: $id}) SET n += $properties RETURN n AS node`, { id: neptuneId(collection, key.id), properties: data }), collection);
    if (nodes.length === 0) throw new NotFoundError(key);
    if (nodes.length !== 1) throw new TypeError("Neptune update returned multiple nodes");
  }

  public async delete(key: Key): Promise<void> {
    const collection = collectionForKey(this.#collections, key);
    const rows = await this.execute(`MATCH (n:\`${collection.label}\` {\`~id\`: $id}) WITH n LIMIT 2 DELETE n RETURN count(n) AS deleted`, { id: neptuneId(collection, key.id) });
    if (rows.length !== 1 || typeof rows[0]?.deleted !== "number" || !Number.isSafeInteger(rows[0].deleted)) throw new TypeError("Neptune returned an invalid delete result");
    if (rows[0].deleted === 0) throw new NotFoundError(key);
    if (rows[0].deleted !== 1) throw new TypeError("Neptune delete affected multiple nodes");
  }

  public runReadwriteTransaction<Result>(): Promise<Result> {
    return Promise.reject(new UnsupportedError("Neptune openCypher HTTPS endpoint has only per-request autocommit transactions"));
  }

  private nodes(rows: readonly Readonly<Record<string, unknown>>[], collection: ResolvedCollection): readonly NeptuneNode[] {
    return rows.map((row) => {
      const node = assertNode(row.node);
      if (!node.labels.includes(collection.label) || !node.id.startsWith(collection.idPrefix)) throw new TypeError("Neptune result is outside the configured collection mapping");
      return node;
    });
  }

  private async requestHeaders(): Promise<Headers> {
    const supplied = await Promise.resolve().then(async () => typeof this.#headers === "function" ? this.#headers() : this.#headers);
    const headers = new Headers(supplied);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return headers;
  }

  private async execute(query: string, parameters: Readonly<Record<string, unknown>>): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.#timeoutMs);
    try {
      const body = new URLSearchParams({ query, parameters: JSON.stringify(parameters) });
      const response = await Promise.resolve().then(async () => this.#fetch(new URL("/openCypher", this.#baseUrl), {
        method: "POST", headers: await this.requestHeaders(), body, signal: controller.signal, redirect: "error",
      }));
      const text = await response.text();
      if (!response.ok) throw new NeptuneQueryError(response.headers.get("x-neptune-status") ?? undefined);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new TypeError("Neptune openCypher returned invalid JSON"); }
      if (!isPlainRecord(parsed) || !Array.isArray(parsed.results) || !parsed.results.every(isPlainRecord)) throw new TypeError("Neptune openCypher returned an invalid results object");
      return parsed.results;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Neptune openCypher request timed out after ${this.#timeoutMs.toString()}ms`, { cause: error });
      throw error;
    } finally { clearTimeout(timer); }
  }
}
