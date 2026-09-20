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
} from "@dal-go/dalgo";
import { compileNeo4jQuery, cursorFromNode } from "./query.js";
import {
  assertDatabaseName,
  assertIdentifier,
  assertJsonValue,
  assertKeyId,
  assertNode,
  collectionForKey,
  isPlainRecord,
  quoteIdentifier,
  validateBaseUrl,
} from "./validation.js";
import type {
  Neo4jCollectionOptions,
  Neo4jDatabaseOptions,
  Neo4jErrorBody,
  Neo4jHeaders,
  Neo4jNode,
  ResolvedCollection,
} from "./types.js";
import { Neo4jQueryError } from "./types.js";
import { keyIdParameter } from "./types.js";

interface QueryData {
  readonly fields: readonly string[];
  readonly values: readonly (readonly unknown[])[];
}

interface QueryResponse {
  readonly data?: QueryData;
  readonly errors?: readonly Neo4jErrorBody[];
  readonly transaction?: { readonly id?: string };
}

interface ApiResponse {
  readonly body: QueryResponse;
  readonly headers: Headers;
}

interface TransactionContext {
  readonly id: string;
  readonly affinity?: string;
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function apiError(response: QueryResponse): Neo4jQueryError | undefined {
  const error = response.errors?.[0];
  return error === undefined ? undefined : new Neo4jQueryError(error.code);
}

function queryData(response: QueryResponse): QueryData {
  const error = apiError(response);
  if (error !== undefined) throw error;
  if (response.data === undefined || !Array.isArray(response.data.fields) || !Array.isArray(response.data.values)) {
    throw new TypeError("Neo4j Query API returned no valid result data");
  }
  if (!response.data.fields.every((field) => typeof field === "string")
    || !response.data.values.every((row) => Array.isArray(row) && row.length === response.data?.fields.length)) {
    throw new TypeError("Neo4j Query API returned malformed result data");
  }
  return response.data;
}

function fieldValues(response: QueryResponse, field: string): readonly unknown[] {
  const data = queryData(response);
  const index = data.fields.indexOf(field);
  if (index === -1) throw new TypeError(`Neo4j Query API response is missing field: ${field}`);
  return data.values.map((row) => row[index]);
}

function nodeValues(response: QueryResponse): readonly Neo4jNode[] {
  return fieldValues(response, "node").map(assertNode);
}

function collectionMap(configurations: Readonly<Record<string, Neo4jCollectionOptions>>): ReadonlyMap<string, ResolvedCollection> {
  const mapped = new Map<string, ResolvedCollection>();
  for (const [collection, configuration] of Object.entries(configurations)) {
    assertIdentifier(collection, "Neo4j collection name");
    mapped.set(collection, {
      collection,
      label: assertIdentifier(configuration.label, "Neo4j node label"),
      idProperty: assertIdentifier(configuration.idProperty ?? "id", "Neo4j ID property"),
    });
  }
  if (mapped.size === 0) throw new TypeError("at least one Neo4j collection must be configured");
  return mapped;
}

function encodedProperties<T>(key: Key, data: T, collection: ResolvedCollection, codec?: Codec<T>): Readonly<Record<string, unknown>> {
  const encoded = codecOrIdentity(codec).encode(data);
  if (!isPlainRecord(encoded)) throw new TypeError("Neo4j DALgo codecs must encode a plain object");
  const id = keyIdParameter(key);
  const currentId = encoded[collection.idProperty];
  if (currentId !== undefined && currentId !== id) {
    throw new TypeError(`encoded data has a different ${collection.idProperty} than the DALgo key`);
  }
  const properties = { ...encoded, [collection.idProperty]: id };
  assertJsonValue(properties, "Neo4j node properties");
  return properties;
}

function snapshotFromNode<T>(key: Key, node: Neo4jNode, codec?: Codec<T>): ExistingRecord<T> {
  return { key, exists: true, data: codecOrIdentity(codec).decode(node.properties) };
}

class Neo4jReadwriteTransaction implements ReadwriteTransaction {
  readonly #database: Neo4jDatabase;
  readonly #context: TransactionContext;

  public constructor(database: Neo4jDatabase, context: TransactionContext) {
    this.#database = database;
    this.#context = context;
  }

  public get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    return this.#database.getInTransaction(this.#context, key, codec);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    const records: RecordSnapshot<T>[] = [];
    for (const key of keys) records.push(await this.get(key, codec));
    return records;
  }

  public insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    return this.#database.insertInTransaction(this.#context, key, data, codec);
  }

  public set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    return this.#database.setInTransaction(this.#context, key, data, codec);
  }

  public update(key: Key, data: UpdateData): Promise<void> {
    return this.#database.updateInTransaction(this.#context, key, data);
  }

  public delete(key: Key): Promise<void> {
    return this.#database.deleteInTransaction(this.#context, key);
  }
}

export class Neo4jDatabase implements Database {
  readonly #baseUrl: URL;
  readonly #database: string;
  readonly #collections: ReadonlyMap<string, ResolvedCollection>;
  readonly #headers: Neo4jDatabaseOptions["headers"];
  readonly #timeoutMs: number;
  readonly #transactionDeployment: Neo4jDatabaseOptions["transactionDeployment"];
  readonly #fetch: typeof fetch;

  public constructor(options: Neo4jDatabaseOptions) {
    this.#baseUrl = validateBaseUrl(options.baseUrl);
    this.#database = assertDatabaseName(options.database);
    this.#collections = collectionMap(options.collections);
    this.#headers = options.headers;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) {
      throw new RangeError("Neo4j timeoutMs must be a safe integer between 1 and 60000");
    }
    this.#transactionDeployment = options.transactionDeployment;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    return this.getWithContext(undefined, key, codec);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    return Promise.all(keys.map(async (key) => this.get(key, codec)));
  }

  public async query<T>(dalQuery: StructuredQuery<T>): Promise<QueryPage<T>> {
    const compiled = compileNeo4jQuery(dalQuery, this.#collections);
    const nodes = nodeValues(await this.execute(compiled.statement, compiled.parameters));
    const records = nodes.map((node): ExistingRecord<T> => {
      const id = assertKeyId(node.properties[compiled.collection.idProperty], "Neo4j node ID property");
      return snapshotFromNode(new Key(compiled.collection.collection, id), node, dalQuery.source.codec);
    });
    const last = nodes.at(-1);
    const nextCursor = dalQuery.limit !== undefined && nodes.length === dalQuery.limit && last !== undefined
      ? cursorFromNode(last.properties, compiled.orders, compiled.collection)
      : undefined;
    return { records, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  public async runReadwriteTransaction<Result>(
    callback: (transaction: ReadwriteTransaction) => Promise<Result>,
  ): Promise<Result> {
    if (this.#transactionDeployment === undefined) {
      throw new UnsupportedError("Neo4j explicit transactions without transactionDeployment: aura or single-instance");
    }
    const context = await this.openTransaction();
    try {
      const result = await callback(new Neo4jReadwriteTransaction(this, context));
      await this.commit(context);
      return result;
    } catch (error) {
      await this.rollback(context);
      throw error;
    }
  }

  public getInTransaction<T>(context: TransactionContext, key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    return this.getWithContext(context, key, codec);
  }

  public insertInTransaction<T>(context: TransactionContext, key: Key, data: T, codec?: Codec<T>): Promise<void> {
    return this.insertWithContext(context, key, data, codec);
  }

  public setInTransaction<T>(context: TransactionContext, key: Key, data: T, codec?: Codec<T>): Promise<void> {
    return this.setWithContext(context, key, data, codec);
  }

  public updateInTransaction(context: TransactionContext, key: Key, data: UpdateData): Promise<void> {
    return this.updateWithContext(context, key, data);
  }

  public deleteInTransaction(context: TransactionContext, key: Key): Promise<void> {
    return this.deleteWithContext(context, key);
  }

  public insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    return this.insertWithContext(undefined, key, data, codec);
  }

  public set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    return this.setWithContext(undefined, key, data, codec);
  }

  public update(key: Key, data: UpdateData): Promise<void> {
    return this.updateWithContext(undefined, key, data);
  }

  public delete(key: Key): Promise<void> {
    return this.deleteWithContext(undefined, key);
  }

  private async getWithContext<T>(context: TransactionContext | undefined, key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const collection = this.collectionForKey(key);
    const statement = `MATCH (n:${quoteIdentifier(collection.label, "Neo4j node label")}) WHERE n.${quoteIdentifier(collection.idProperty, "Neo4j ID property")} = $id RETURN n AS node LIMIT 2`;
    const nodes = nodeValues(await this.execute(statement, { id: keyIdParameter(key) }, context));
    if (nodes.length === 0) return { key, exists: false };
    if (nodes.length !== 1) throw new TypeError(`Neo4j collection ${collection.collection} has duplicate DALgo IDs`);
    const node = nodes[0];
    if (node === undefined) throw new TypeError("Neo4j Query API returned an empty node result");
    return snapshotFromNode(key, node, codec);
  }

  private async insertWithContext<T>(context: TransactionContext | undefined, key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const collection = this.collectionForKey(key);
    const statement = `CREATE (n:${quoteIdentifier(collection.label, "Neo4j node label")}) SET n = $properties RETURN n AS node`;
    try {
      nodeValues(await this.execute(statement, { properties: encodedProperties(key, data, collection, codec) }, context));
    } catch (error) {
      if (error instanceof Neo4jQueryError && error.code === "Neo.ClientError.Schema.ConstraintValidationFailed") {
        throw new AlreadyExistsError(key, { cause: error });
      }
      throw error;
    }
  }

  private async setWithContext<T>(context: TransactionContext | undefined, key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const collection = this.collectionForKey(key);
    const statement = `MERGE (n:${quoteIdentifier(collection.label, "Neo4j node label")} {${quoteIdentifier(collection.idProperty, "Neo4j ID property")}: $id}) SET n = $properties RETURN n AS node`;
    nodeValues(await this.execute(statement, { id: keyIdParameter(key), properties: encodedProperties(key, data, collection, codec) }, context));
  }

  private async updateWithContext(context: TransactionContext | undefined, key: Key, data: UpdateData): Promise<void> {
    const collection = this.collectionForKey(key);
    if (Object.hasOwn(data, collection.idProperty)) {
      throw new UnsupportedError("Neo4j DALgo update of an immutable ID property");
    }
    assertJsonValue(data, "Neo4j update data");
    const statement = `MATCH (n:${quoteIdentifier(collection.label, "Neo4j node label")}) WHERE n.${quoteIdentifier(collection.idProperty, "Neo4j ID property")} = $id SET n += $patch RETURN n AS node`;
    const nodes = nodeValues(await this.execute(statement, { id: keyIdParameter(key), patch: data }, context));
    if (nodes.length === 0) throw new NotFoundError(key);
    if (nodes.length !== 1) throw new TypeError(`Neo4j collection ${collection.collection} has duplicate DALgo IDs`);
  }

  private async deleteWithContext(context: TransactionContext | undefined, key: Key): Promise<void> {
    const collection = this.collectionForKey(key);
    const statement = `MATCH (n:${quoteIdentifier(collection.label, "Neo4j node label")}) WHERE n.${quoteIdentifier(collection.idProperty, "Neo4j ID property")} = $id WITH n LIMIT 2 DELETE n RETURN count(n) AS deleted`;
    const values = fieldValues(await this.execute(statement, { id: keyIdParameter(key) }, context), "deleted");
    const deleted = values[0];
    if (values.length !== 1 || typeof deleted !== "number" || !Number.isSafeInteger(deleted)) {
      throw new TypeError("Neo4j Query API returned an invalid delete result");
    }
    if (deleted === 0) throw new NotFoundError(key);
    if (deleted !== 1) throw new TypeError(`Neo4j collection ${collection.collection} has duplicate DALgo IDs`);
  }

  private collectionForKey(key: Key): ResolvedCollection {
    keyIdParameter(key);
    return collectionForKey(this.#collections, key.collection);
  }

  private endpoint(path: string): URL {
    return new URL(`/db/${encodeURIComponent(this.#database)}/query/v2${path}`, this.#baseUrl);
  }

  private async headers(extra?: Neo4jHeaders): Promise<Headers> {
    const supplied = typeof this.#headers === "function" ? await this.#headers() : this.#headers;
    const headers = new Headers(supplied);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    if (extra !== undefined) {
      for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    }
    return headers;
  }

  private async request(method: "POST" | "DELETE", path: string, body?: Readonly<Record<string, unknown>>, context?: TransactionContext): Promise<ApiResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.#timeoutMs);
    const extra = context?.affinity === undefined ? undefined : { "neo4j-cluster-affinity": context.affinity };
    try {
      const response = await this.#fetch(this.endpoint(path), {
        method,
        headers: await this.headers(extra),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: "error",
      });
      const text = await response.text();
      let parsed: unknown = {};
      if (text.length > 0) {
        try { parsed = JSON.parse(text); } catch { throw new TypeError("Neo4j Query API returned invalid JSON"); }
      }
      if (!isPlainRecord(parsed)) throw new TypeError("Neo4j Query API returned an invalid JSON object");
      const result = parsed as QueryResponse;
      const error = apiError(result);
      if (!response.ok || error !== undefined) throw error ?? new Neo4jQueryError(undefined);
      return { body: result, headers: response.headers };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`Neo4j Query API request timed out after ${this.#timeoutMs.toString()}ms`, { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private execute(statement: string, parameters: Readonly<Record<string, unknown>>, context?: TransactionContext): Promise<QueryResponse> {
    assertJsonValue(parameters, "Neo4j statement parameters");
    const path = context === undefined ? "" : `/tx/${encodeURIComponent(context.id)}`;
    return this.request("POST", path, { statement, parameters }, context).then(({ body }) => body);
  }

  private async openTransaction(): Promise<TransactionContext> {
    const opened = await this.request("POST", "/tx", {});
    const response = opened.body;
    const error = apiError(response);
    if (error !== undefined) throw error;
    const id = response.transaction?.id;
    if (typeof id !== "string" || id.length === 0) throw new TypeError("Neo4j Query API did not return an explicit transaction ID");
    if (this.#transactionDeployment === "aura") {
      const affinity = opened.headers.get("neo4j-cluster-affinity");
      if (affinity === null || affinity.length === 0) {
        throw new UnsupportedError("Neo4j Aura explicit transactions require an exposed neo4j-cluster-affinity response header");
      }
      return { id, affinity };
    }
    return { id };
  }

  private async commit(context: TransactionContext): Promise<void> {
    const { body: response } = await this.request("POST", `/tx/${encodeURIComponent(context.id)}/commit`, {}, context);
    const error = apiError(response);
    if (error !== undefined) throw error;
  }

  private async rollback(context: TransactionContext): Promise<void> {
    try {
      const { body: response } = await this.request("DELETE", `/tx/${encodeURIComponent(context.id)}`, undefined, context);
      const error = apiError(response);
      if (error !== undefined) throw error;
    } catch {
      // The callback/commit error is more useful and a server-side expiry also rolls back.
    }
  }
}
