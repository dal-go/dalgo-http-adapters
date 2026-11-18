/** Low-level AWS values: numbers stay decimal strings, binary stays bytes. */
export type NativeDynamoDbValue =
  | { readonly S: string } | { readonly N: string } | { readonly B: Uint8Array }
  | { readonly BOOL: boolean } | { readonly NULL: true }
  | { readonly SS: string[] } | { readonly NS: string[] } | { readonly BS: Uint8Array[] }
  | { readonly L: NativeDynamoDbValue[] } | { readonly M: Record<string, NativeDynamoDbValue> };
export type NativeDynamoDbItem = Readonly<Record<string, NativeDynamoDbValue>>;
export type NativeDynamoDbKeyValue = { readonly S: string } | { readonly N: string } | { readonly B: Uint8Array };
export type NativeDynamoDbKey = Readonly<Record<string, NativeDynamoDbKeyValue>>;
export interface NativeDynamoDbClientLike {
  send(command: unknown, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown>;
}
export interface NativeDynamoDbKeyAttribute { readonly name: string; readonly type: "S" | "N" | "B"; }
export interface NativeDynamoDbIndex {
  readonly indexName: string;
  readonly kind: "gsi" | "lsi";
  readonly partitionKey: NativeDynamoDbKeyAttribute;
  readonly sortKey?: NativeDynamoDbKeyAttribute;
  readonly projection: "ALL" | "KEYS_ONLY" | readonly string[];
}
export interface NativeDynamoDbTable {
  readonly tableName: string;
  readonly partitionKey: NativeDynamoDbKeyAttribute;
  readonly sortKey?: NativeDynamoDbKeyAttribute;
  readonly consistentRead?: boolean;
  /** Trusted attribute grant. Keys are always included for identity validation. */
  readonly readAttributes?: "all" | readonly string[];
  readonly indexes?: Readonly<Record<string, NativeDynamoDbIndex>>;
}
export interface NativeDynamoDbOptions {
  readonly tables: Readonly<Record<string, NativeDynamoDbTable>>;
  readonly timeoutMs?: number;
  readonly maxReadBytes?: number;
  readonly maxRecords?: number;
  readonly maxPages?: number;
  readonly maxEvaluated?: number;
  readonly pageSize?: number;
  readonly maxConcurrent?: number;
}
export interface NativeDynamoDbReadOptions { readonly projection?: readonly string[]; readonly consistentRead?: boolean; }
export interface NativeDynamoDbSortCondition {
  readonly operator: "=" | "<" | "<=" | ">" | ">=" | "between" | "begins_with";
  readonly values: readonly NativeDynamoDbKeyValue[];
}
/** An instance-owned handle; serializing or reconstructing it does not resume. */
export interface NativeDynamoDbCursor { readonly adapter: "native-dynamodb"; readonly version: 1; }
export interface NativeDynamoDbQuery extends NativeDynamoDbReadOptions {
  readonly collection: string;
  readonly index?: string;
  readonly partition: NativeDynamoDbKeyValue;
  readonly sort?: NativeDynamoDbSortCondition;
  readonly descending?: boolean;
  readonly limit: number;
  readonly cursor?: NativeDynamoDbCursor;
}
export interface NativeDynamoDbPage {
  readonly items: readonly NativeDynamoDbItem[];
  readonly nextCursor?: NativeDynamoDbCursor;
  readonly pages: number;
  readonly evaluated: number;
}
export type NativeDynamoDbErrorCode = "configuration" | "request" | "invalid-response" | "limit" | "unprocessed" | "transport" | "closed";
export class NativeDynamoDbError extends Error {
  public constructor(public readonly code: NativeDynamoDbErrorCode) {
    super(`Native DynamoDB read failed: ${code}`);
    this.name = "NativeDynamoDbError";
  }
}
