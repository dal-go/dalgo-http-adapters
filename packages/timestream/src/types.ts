/** Refreshable AWS credentials; never put these in an endpoint URL. */
export interface TimestreamCredentials { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string; }
export type TimestreamCredentialsProvider = () => TimestreamCredentials | Promise<TimestreamCredentials>;
export type TimestreamFetch = typeof globalThis.fetch;

/** One top-level DALgo collection projected from a Timestream table. */
export interface TimestreamTable { readonly table: string; readonly keyColumn: string; readonly columns: Readonly<Record<string, string>>; }
export interface TimestreamDatabaseOptions {
  readonly region: string;
  readonly database: string;
  readonly credentials: TimestreamCredentialsProvider;
  readonly tables: Readonly<Record<string, TimestreamTable>>;
  /** Override only for AWS endpoint discovery, PrivateLink, or deterministic tests. Must be an HTTPS origin. */
  readonly queryEndpoint?: string;
  /** Override only for AWS endpoint discovery, PrivateLink, or deterministic tests. Must be an HTTPS origin. */
  readonly writeEndpoint?: string;
  readonly maxRows?: number;
  readonly maxResponseBytes?: number;
  readonly maxWriteRecords?: number;
  readonly timeoutMs?: number;
  readonly fetch?: TimestreamFetch;
}

/** Native Timestream Write Record shape. The service validates its time-series schema. */
export interface TimestreamRecord {
  readonly Dimensions?: readonly { readonly Name: string; readonly Value: string; readonly DimensionValueType?: "VARCHAR" }[];
  readonly MeasureName?: string;
  readonly MeasureValue?: string;
  readonly MeasureValueType?: "BIGINT" | "BOOLEAN" | "DOUBLE" | "VARCHAR" | "MULTI";
  readonly MeasureValues?: readonly { readonly Name: string; readonly Value: string; readonly Type: "BIGINT" | "BOOLEAN" | "DOUBLE" | "VARCHAR" }[];
  readonly Time?: string;
  readonly TimeUnit?: "SECONDS" | "MILLISECONDS" | "MICROSECONDS" | "NANOSECONDS";
  readonly Version?: number;
}
export interface TimestreamWriteResult { readonly recordsIngested: Readonly<Record<string, number>>; }
export interface TimestreamQueryPage { readonly columns: readonly string[]; readonly rows: readonly Readonly<Record<string, unknown>>[]; readonly nextToken?: string; readonly queryId: string; }
