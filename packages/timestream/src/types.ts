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
  /** Regional endpoint used only for signed Query DescribeEndpoints discovery. */
  readonly queryEndpoint?: string;
  /** Regional endpoint used only for signed Write DescribeEndpoints discovery. */
  readonly writeEndpoint?: string;
  readonly maxRows?: number;
  readonly maxResponseBytes?: number;
  readonly maxRequestBytes?: number;
  readonly maxWriteRecords?: number;
  readonly timeoutMs?: number;
  /** Required only when this code intentionally runs in a browser window. */
  readonly trustedRuntime?: true;
  /** Injected only for deterministic tests; production uses the system clock. */
  readonly clock?: () => Date;
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
