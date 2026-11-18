import { DOCUMENT_ID, Key, UnsupportedError, identityCodec, type Codec, type Database, type ExistingRecord, type QueryPage, type ReadwriteTransaction, type RecordSnapshot, type StructuredQuery } from "@dalgo/core";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { MongoReadError, type MongoDocument, type MongoJsonValue, type MongoReadExecutor } from "./types.js";
import { aborted, field, object, onlyKeys, validateFilter } from "./validation.js";

export interface MongoDatabaseOptions {
  /** Explicit core key interpretation; native execute() also supports other BSON IDs. */
  readonly idKind?: "objectId" | "string";
  readonly maxRows?: number;
}

function codecOr<T>(codec: Codec<T> | undefined): Codec<T> { return (codec ?? identityCodec) as Codec<T>; }

/**
 * Actual modern DALgo Database facade over either Node or trusted HTTP transport.
 * Documents retain canonical EJSON values; caller codecs may decode these tags.
 * No DALgo envelope or synthetic ID is stored in the user's collection.
 */
export class MongoDatabase implements Database {
  readonly #executor: MongoReadExecutor;
  readonly #idKind: "objectId" | "string";
  readonly #maxRows: number;

  public constructor(executor: MongoReadExecutor, options: MongoDatabaseOptions = {}) {
    this.#executor = executor;
    const idKind: unknown = options.idKind ?? "objectId";
    if (idKind !== "objectId" && idKind !== "string") throw new MongoReadError("unsupported");
    this.#idKind = idKind;
    this.#maxRows = options.maxRows ?? 1000;
    if (!Number.isSafeInteger(this.#maxRows) || this.#maxRows < 1 || this.#maxRows > 10_000) throw new MongoReadError("bounds");
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    if (key.parent !== undefined) throw new UnsupportedError("MongoDB nested collection keys");
    const id = this.encodeId(key.id);
    const result = await this.#executor.execute({ kind: "find", collection: key.collection, filter: { _id: id }, limit: 1 });
    if (result.kind !== "documents") throw new MongoReadError("protocol");
    const row = result.documents[0];
    if (row === undefined) return { key, exists: false };
    if (result.documents.length !== 1 || result.nextCursor !== undefined || this.decodeId(row._id) !== key.id) throw new MongoReadError("protocol");
    return this.record(row, key.collection, codec);
  }

  public async getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#maxRows) throw new MongoReadError("bounds");
    for (const key of keys) {
      if (key.parent !== undefined) throw new UnsupportedError("MongoDB nested collection keys");
      field(key.collection); this.encodeId(key.id);
    }
    // Serial execution avoids a getMany() fan-out creating hundreds of cursors.
    const records: RecordSnapshot<T>[] = [];
    for (const key of keys) records.push(await this.get(key, codec));
    return records;
  }

  public query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> { return this.queryPage(query); }
  public queryWithSignal<T>(query: StructuredQuery<T>, signal: AbortSignal): Promise<QueryPage<T>> { return this.queryPage(query, signal); }

  public async discover(signal?: AbortSignal): Promise<readonly string[]> {
    const result = await this.#executor.execute({ kind: "discover" }, signal);
    if (signal !== undefined && aborted(signal)) throw new QueryCancelledError("caller");
    if (result.kind !== "collections") throw new MongoReadError("protocol");
    return result.collections;
  }

  /** Real read against a selected collection; discover() alone is configured metadata. */
  public async testConnection(collection: string, signal?: AbortSignal): Promise<void> {
    await this.#executor.execute({ kind: "find", collection, limit: 1 }, signal);
    if (signal !== undefined && aborted(signal)) throw new QueryCancelledError("caller");
  }

  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result>;
  public runReadwriteTransaction<Result>(): Promise<Result> {
    return Promise.reject(new UnsupportedError("MongoDB read-only callback transactions"));
  }

  private async queryPage<T>(query: StructuredQuery<T>, signal?: AbortSignal): Promise<QueryPage<T>> {
    if (signal?.aborted === true) throw new QueryCancelledError("caller");
    onlyKeys(query, ["source", "filters", "orders", "limit", "offset", "startAt", "startAfter", "endAt", "endBefore"]);
    if (query.source.kind !== "collection" || query.source.parent !== undefined || (query.offset ?? 0) !== 0
      || query.startAt !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("MongoDB collection/query capability");
    if (query.filters.length > 64 || query.orders.length > 1) throw new MongoReadError("bounds");
    for (const order of query.orders) {
      if ((order.field !== DOCUMENT_ID && order.field !== "_id") || order.direction !== "asc") throw new UnsupportedError("MongoDB stable _id ascending ordering only");
    }
    const operations: Readonly<Record<string, string>> = { "==": "$eq", "!=": "$ne", "<": "$lt", "<=": "$lte", ">": "$gt", ">=": "$gte", in: "$in", "not-in": "$nin" };
    const filters: MongoDocument[] = query.filters.map((filter) => {
      const name = filter.field === DOCUMENT_ID ? "_id" : filter.field;
      field(name);
      const operator = Object.hasOwn(operations, filter.operator) ? operations[filter.operator] : undefined;
      if (operator === undefined) throw new UnsupportedError("MongoDB query filter operator");
      const value = name === "_id" ? Array.isArray(filter.value) ? filter.value.map((item: unknown) => this.encodeId(item)) : this.encodeId(filter.value) : filter.value as MongoJsonValue;
      return { [name]: { [operator]: value } };
    });
    const filter: MongoDocument = filters.length === 0 ? {} : { $and: filters };
    validateFilter(filter);
    const limit = query.limit ?? this.#maxRows;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#maxRows) throw new MongoReadError("bounds");
    let after: string | undefined;
    if (query.startAfter !== undefined) {
      if (query.startAfter.values.length !== 1 || typeof query.startAfter.values[0] !== "string") throw new UnsupportedError("MongoDB opaque query cursor");
      after = query.startAfter.values[0];
    }
    const result = await this.#executor.execute({ kind: "find", collection: query.source.name, filter, limit, ...(after === undefined ? {} : { after }) }, signal);
    if (signal !== undefined && aborted(signal)) throw new QueryCancelledError("caller");
    if (result.kind !== "documents" || result.documents.length > limit) throw new MongoReadError("protocol");
    const records = result.documents.map((row) => this.record(row, query.source.name, query.source.codec));
    return { records, ...(result.nextCursor === undefined ? {} : { nextCursor: { values: [result.nextCursor] } }) };
  }

  private encodeId(value: unknown): MongoJsonValue {
    if (typeof value !== "string") throw new UnsupportedError("MongoDB core keys require string or hexadecimal ObjectId strings");
    if (this.#idKind === "string") return value;
    if (!/^[0-9a-f]{24}$/u.test(value)) throw new UnsupportedError("MongoDB canonical lowercase ObjectId key");
    return { $oid: value };
  }

  private decodeId(value: unknown): string {
    if (this.#idKind === "string" && typeof value === "string") return value;
    if (this.#idKind === "objectId" && object(value) && Object.keys(value).length === 1
      && typeof value.$oid === "string" && /^[0-9a-f]{24}$/u.test(value.$oid)) return value.$oid;
    throw new UnsupportedError("MongoDB document _id does not match configured core key kind; use native execute for other BSON identities");
  }

  private record<T>(row: MongoDocument, collection: string, codec: Codec<T> | undefined): ExistingRecord<T> {
    const key = new Key(collection, this.decodeId(row._id));
    const data = Object.fromEntries(Object.entries(row).filter(([name]) => name !== "_id"));
    return { key, exists: true, data: codecOr(codec).decode(data) };
  }
}
