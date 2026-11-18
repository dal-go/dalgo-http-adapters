/** Canonical Extended JSON retains ObjectId, int64, decimal, binary and dates. */
export type MongoJsonValue = null | boolean | number | string | readonly MongoJsonValue[] | { readonly [key: string]: MongoJsonValue };
export type MongoDocument = Readonly<Record<string, MongoJsonValue>>;

export interface MongoFindRequest {
  readonly kind: "find";
  /** A configured logical collection name, never a database or connection URI. */
  readonly collection: string;
  readonly filter?: MongoDocument;
  readonly limit: number;
  /** Adapter-generated query-bound keyset continuation; not a server cursor ID. */
  readonly after?: string;
}

export interface MongoAggregateRequest {
  readonly kind: "aggregate";
  readonly collection: string;
  /** Only $match, simple $project, $sort and bounded $limit are accepted. */
  readonly pipeline: readonly MongoDocument[];
  readonly limit: number;
}

export type MongoReadRequest = MongoFindRequest | MongoAggregateRequest | { readonly kind: "discover" };
export interface MongoDocumentsResult {
  readonly kind: "documents";
  readonly documents: readonly MongoDocument[];
  readonly nextCursor?: string;
}
export interface MongoCollectionsResult {
  readonly kind: "collections";
  /** Explicit grants, not a claim of automatic server discovery. */
  readonly source: "configured";
  readonly collections: readonly string[];
}
export type MongoReadResult = MongoDocumentsResult | MongoCollectionsResult;
export interface MongoReadExecutor {
  execute(request: MongoReadRequest, signal?: AbortSignal): Promise<MongoReadResult>;
}
export type MongoErrorCode = "unsupported" | "permission" | "authentication" | "bounds" | "transport" | "protocol";

/** Never includes provider error messages, request data, URI, credentials or cause. */
export class MongoReadError extends Error {
  public constructor(public readonly code: MongoErrorCode) {
    super(`MongoDB read failed (${code})`);
    this.name = "MongoReadError";
  }
}
