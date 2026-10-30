import type { OrdinalQueryExecutor } from "@dalgo/adapter-runtime";

export interface ClickHouseReadGrant {
  readonly database: string;
  readonly table: string;
  /** Logical field name to physical column name. No implicit SELECT *. */
  readonly columns: Readonly<Record<string, string>>;
}

export interface NativeClickHouseDatabaseOptions {
  /** Credential-free HTTPS origin with format override and nonce-tagged HTTP errors. */
  readonly serverUrl: string;
  readonly allowInsecureLoopbackHttp?: boolean;
  /** Refreshed per operation, scoped to server-side readonly=1 credentials. */
  readonly headers?: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  readonly fetch?: typeof fetch;
  readonly tables: Readonly<Record<string, ClickHouseReadGrant>>;
  /** Separate from structured table grants: grants credential-scoped arbitrary native SQL. */
  readonly allowNativeSql?: boolean;
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly maxColumns?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** Total nested values across the response, not merely per array. */
  readonly maxValues?: number;
  readonly maxDepth?: number;
}

/** A factory can return this independently from a keyed core Database. */
export type NativeClickHouseExecutor = OrdinalQueryExecutor;
