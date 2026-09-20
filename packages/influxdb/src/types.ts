/** A bounded SQL column in an InfluxDB 3 table. */
export interface InfluxDB3Column {
  /** InfluxDB SQL column name. */
  readonly column: string;
  /** Set false for every field used in an ordered, cursor-paginated query. */
  readonly nullable?: boolean;
}

/** Maps one top-level DALgo collection to one InfluxDB 3 table. */
export interface InfluxDB3Table {
  readonly table: string;
  readonly keyColumn: InfluxDB3Column;
  readonly columns: Readonly<Record<string, InfluxDB3Column>>;
}

export type InfluxDB3AccessTokenProvider = () => string | Promise<string>;
export type InfluxDB3Fetch = typeof globalThis.fetch;

export interface InfluxDB3DatabaseOptions {
  /** InfluxDB 3 database selected for both SQL and line-protocol requests. */
  readonly database: string;
  /** HTTPS InfluxDB 3 Core, Enterprise, or Cloud endpoint; loopback HTTP is allowed for local development. */
  readonly serverUrl: string;
  /** Returns a short-lived bearer token for every request. */
  readonly accessToken: InfluxDB3AccessTokenProvider;
  /** Maps each DALgo collection to a bounded table projection. */
  readonly tables: Readonly<Record<string, InfluxDB3Table>>;
  /** Maximum records returned by a DALgo operation. Defaults to 1000. */
  readonly maxRows?: number;
  /** Maximum accepted JSON response size. Defaults to 1 MiB. */
  readonly maxResponseBytes?: number;
  /** Maximum line-protocol request size. Defaults to 1 MiB. */
  readonly maxWriteBytes?: number;
  /** Per-request deadline. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
  readonly fetch?: InfluxDB3Fetch;
}
