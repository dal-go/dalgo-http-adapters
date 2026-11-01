import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { BSON, type Db, type FindCursor, type AggregationCursor } from "mongodb";
import { createAbortScope, QueryCancelledError, raceAbort } from "@dalgo/adapter-runtime";
import { MongoReadError, type MongoDocument, type MongoFindRequest, type MongoReadExecutor, type MongoReadRequest, type MongoReadResult } from "./types.js";
import { aborted, field, jsonBytes, object, positive, validateRequest } from "./validation.js";

export interface MongoNodeExecutorOptions {
  /** A trusted, already-authenticated Db. This executor never accepts client URIs. */
  readonly database: Db;
  /** Logical name -> physical collection. Server credentials must also be read-only. */
  readonly collections: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly maxPages?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly cursorTtlMs?: number;
  /** Optional stable server-only signing key (>=32 bytes) for multiple instances. */
  readonly cursorKey?: Uint8Array;
}

interface Continuation {
  readonly version: 1;
  readonly binding: string;
  readonly last: MongoDocument;
  readonly page: number;
  readonly expires: number;
}

function closeQuietly(cursor: FindCursor | AggregationCursor | undefined): void {
  if (cursor === undefined) return;
  try { void cursor.close().catch(() => undefined); } catch { /* Preserve the original result or cancellation. */ }
}

function redacted(error: unknown): MongoReadError {
  if (error instanceof MongoReadError) return error;
  const code: unknown = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === 13) return new MongoReadError("permission");
  if (code === 18) return new MongoReadError("authentication");
  return new MongoReadError("transport");
}

/** Read-only MongoDB driver entry. It intentionally owns no MongoClient lifecycle. */
export class MongoNodeExecutor implements MongoReadExecutor {
  public readonly readOnly = true as const;
  public readonly serverCancellation = "driver-signal-and-cursor-close" as const;
  readonly #database: Db;
  readonly #collections = new Map<string, string>();
  readonly #timeoutMs: number;
  readonly #maxRows: number;
  readonly #maxPages: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #cursorTtlMs: number;
  readonly #cursorKey: Uint8Array;

  public constructor(options: MongoNodeExecutorOptions) {
    this.#database = options.database;
    this.#timeoutMs = positive(options.timeoutMs, 30_000, 65_000);
    this.#maxRows = positive(options.maxRows, 1000, 10_000);
    this.#maxPages = positive(options.maxPages, 100, 1000);
    this.#maxRequestBytes = positive(options.maxRequestBytes, 65_536, 1_048_576);
    this.#maxResponseBytes = positive(options.maxResponseBytes, 4_194_304, 16_777_216);
    this.#cursorTtlMs = positive(options.cursorTtlMs, 300_000, 3_600_000);
    if (!object(options.collections) || Object.keys(options.collections).length > 256) throw new MongoReadError("bounds");
    for (const [logical, physical] of Object.entries(options.collections)) {
      field(logical);
      if (typeof physical !== "string" || physical.length < 1 || physical.length > 256 || physical.includes("\0") || physical.startsWith("system.")) throw new MongoReadError("unsupported");
      this.#collections.set(logical, physical);
    }
    if (options.cursorKey !== undefined && options.cursorKey.byteLength < 32) throw new MongoReadError("bounds");
    this.#cursorKey = options.cursorKey === undefined ? randomBytes(32) : Uint8Array.from(options.cursorKey);
  }

  public async execute(request: MongoReadRequest, signal?: AbortSignal): Promise<MongoReadResult> {
    const scope = createAbortScope(signal, this.#timeoutMs);
    const cancelled = (): QueryCancelledError => new QueryCancelledError(scope.deadlineExceeded ? "deadline" : "caller");
    let cursor: FindCursor | AggregationCursor | undefined;
    try {
      if (aborted(scope.signal)) throw cancelled();
      validateRequest(request, this.#maxRows, this.#maxRequestBytes);
      if (request.kind === "discover") {
        const result = { kind: "collections" as const, source: "configured" as const, collections: [...this.#collections.keys()] };
        jsonBytes(result, this.#maxResponseBytes);
        return result;
      }
      const physical = this.#collections.get(request.collection);
      if (physical === undefined) throw new MongoReadError("permission");
      const collection = this.#database.collection(physical);
      let continuation: Continuation | undefined;
      if (request.kind === "find") {
        const binding = jsonBytes({ database: this.#database.databaseName, collection: physical, logical: request.collection, filter: request.filter ?? {}, limit: request.limit }, this.#maxRequestBytes);
        continuation = request.after === undefined
          ? { version: 1, binding, last: {}, page: 1, expires: Date.now() + this.#cursorTtlMs }
          : this.decodeCursor(request.after, binding);
        let filter = this.deserialize(request.filter ?? {});
        if (request.after !== undefined) {
          const last = this.deserialize(continuation.last);
          if (!Object.hasOwn(last, "_id")) throw new MongoReadError("protocol");
          // $expr uses BSON comparison order across types. A normal query $gt
          // uses type bracketing and could skip records in a mixed-_id collection.
          filter = { $and: [filter, { $expr: { $gt: ["$_id", { $literal: last._id }] } }] };
        }
        cursor = collection.find(filter, {
          sort: { _id: 1 }, limit: request.limit + 1, batchSize: Math.min(request.limit + 1, 100),
          maxTimeMS: this.#timeoutMs, signal: scope.signal, promoteLongs: false, promoteValues: false,
        });
      } else {
        // Every accepted stage is intrinsically read-only; no $out/$merge, JS,
        // $lookup/$unionWith or user-selected command/collection is forwarded.
        const pipeline = request.pipeline.map((stage) => this.deserialize(stage));
        pipeline.push({ $limit: request.limit + 1 });
        cursor = collection.aggregate(pipeline, {
          batchSize: Math.min(request.limit + 1, 100), maxTimeMS: this.#timeoutMs,
          allowDiskUse: false, signal: scope.signal, promoteLongs: false, promoteValues: false,
        });
      }
      const documents: MongoDocument[] = [];
      let bytes = 128;
      let hasMore = false;
      for (;;) {
        if (aborted(scope.signal)) throw cancelled();
        const row: unknown = await raceAbort(cursor.next(), scope.signal, cancelled);
        if (row === null) break;
        if (documents.length === request.limit) { hasMore = true; break; }
        if (!object(row)) throw new MongoReadError("protocol");
        const serialized: unknown = BSON.EJSON.serialize(row, { relaxed: false });
        if (!object(serialized)) throw new MongoReadError("protocol");
        const document = serialized as MongoDocument;
        bytes += new TextEncoder().encode(jsonBytes(document, this.#maxResponseBytes)).byteLength + 1;
        if (bytes > this.#maxResponseBytes) throw new MongoReadError("bounds");
        documents.push(document);
      }
      if (aborted(scope.signal)) throw cancelled();
      if (request.kind === "aggregate" && hasMore) throw new MongoReadError("bounds");
      let nextCursor: string | undefined;
      if (hasMore && request.kind === "find" && continuation !== undefined) {
        if (continuation.page >= this.#maxPages) throw new MongoReadError("bounds");
        const last = documents.at(-1);
        if (last === undefined || !Object.hasOwn(last, "_id")) throw new MongoReadError("protocol");
        nextCursor = this.encodeCursor({ ...continuation, last: { _id: last._id as MongoDocument[string] }, page: continuation.page + 1 });
      }
      const result = { kind: "documents" as const, documents, ...(nextCursor === undefined ? {} : { nextCursor }) };
      jsonBytes(result, this.#maxResponseBytes);
      return result;
    } catch (error) {
      if (aborted(scope.signal)) throw cancelled();
      if (error !== null && typeof error === "object" && "code" in error && error.code === 50) throw new QueryCancelledError("deadline");
      throw redacted(error);
    } finally {
      closeQuietly(cursor);
      scope.dispose();
    }
  }

  private deserialize(document: MongoDocument): Record<string, unknown> {
    try {
      const value: unknown = BSON.EJSON.deserialize(document, { relaxed: false });
      if (!object(value)) throw new MongoReadError("protocol");
      return value;
    } catch { throw new MongoReadError("unsupported"); }
  }

  private encodeCursor(value: Continuation): string {
    const payload = Buffer.from(jsonBytes(value, 24_000)).toString("base64url");
    const signature = createHmac("sha256", this.#cursorKey).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  private decodeCursor(token: string, binding: string): Continuation {
    try {
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token) || token.length > 32_768) throw new MongoReadError("protocol");
      const [payload, signature] = token.split(".");
      if (payload === undefined || signature === undefined) throw new MongoReadError("protocol");
      const expected = createHmac("sha256", this.#cursorKey).update(payload).digest();
      const actual = Buffer.from(signature, "base64url");
      if (actual.toString("base64url") !== signature || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new MongoReadError("permission");
      const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (!object(value) || value.version !== 1 || value.binding !== binding || !object(value.last)
        || typeof value.page !== "number" || !Number.isSafeInteger(value.page) || value.page < 2 || value.page > this.#maxPages
        || typeof value.expires !== "number" || !Number.isSafeInteger(value.expires) || value.expires < Date.now()) throw new MongoReadError("protocol");
      return value as unknown as Continuation;
    } catch (error) { throw error instanceof MongoReadError ? error : new MongoReadError("protocol"); }
  }
}

/** Returns true only for the documented find/page capability, not arbitrary Mongo commands. */
export function isMongoFindRequest(value: MongoReadRequest): value is MongoFindRequest { return value.kind === "find"; }
