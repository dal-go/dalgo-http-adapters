/** Supported scalar parameter types for mapped BigQuery columns. */
export type BigQueryScalarType =
  | "STRING"
  | "INT64"
  | "FLOAT64"
  | "BOOL"
  | "NUMERIC"
  | "BIGNUMERIC"
  | "DATE"
  | "DATETIME"
  | "TIME"
  | "TIMESTAMP"
  | "JSON";

export interface BigQueryColumn {
  /** BigQuery column name. Nested/repeated columns are deliberately unsupported. */
  readonly column: string;
  readonly type: BigQueryScalarType;
  /** Required as false for an ordered field that participates in DALgo pagination. */
  readonly nullable?: boolean;
}

/**
 * The bounded record projection that a DALgo collection represents.
 * All application fields that this adapter reads or writes must be declared in
 * `columns`; unrelated warehouse columns remain outside DALgo's model.
 */
export interface BigQueryTable {
  readonly datasetId: string;
  readonly tableId: string;
  readonly keyColumn: BigQueryColumn;
  readonly columns: Readonly<Record<string, BigQueryColumn>>;
}

export type AccessTokenProvider = () => string | Promise<string>;
export type BigQueryFetch = typeof globalThis.fetch;

export interface BigQueryDatabaseOptions {
  /** Google Cloud project that owns query jobs. */
  readonly projectId: string;
  /** Maps each DALgo collection name to one bounded BigQuery table projection. */
  readonly tables: Readonly<Record<string, BigQueryTable>>;
  /** Returns a short-lived OAuth 2.0 access token for every request. */
  readonly accessToken: AccessTokenProvider;
  readonly location?: string;
  /** Caps query cost; omitted only when the caller explicitly accepts project defaults. */
  readonly maximumBytesBilled?: bigint | number | string;
  /** Maximum DALgo records returned by one query; defaults to 1000. */
  readonly maxRows?: number;
  /** Maximum rows requested from one BigQuery results response; defaults to 500. */
  readonly pageSize?: number;
  /** End-to-end request and polling deadline; defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /** Initial synchronous wait supplied to jobs.query; defaults to 1000 milliseconds. */
  readonly initialWaitMs?: number;
  readonly fetch?: BigQueryFetch;
}

export interface BigQueryQueryMetadata {
  readonly jobId?: string;
  readonly totalBytesProcessed?: string;
  readonly totalBytesBilled?: string;
  readonly cacheHit?: boolean;
}
