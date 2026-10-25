/** One bounded SQL column in a DALgo collection projection. */
export interface LibSQLColumn {
  readonly column: string;
  /** Required for every ordered, cursor-paginated column. */
  readonly nullable?: boolean;
}

/** Maps one top-level DALgo collection to a SQLite/libSQL table. */
export interface LibSQLTable {
  readonly table: string;
  /** Caller-confirmed UNIQUE or PRIMARY KEY constraint on `keyColumn`; required before this adapter enables writes. */
  readonly uniqueKey?: boolean;
  readonly keyColumn: LibSQLColumn;
  readonly columns: Readonly<Record<string, LibSQLColumn>>;
}

/** Called for each request to supply header-only authentication or other deployment-specific headers. */
export type LibSQLHeadersProvider = () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
export type LibSQLFetch = typeof globalThis.fetch;

export interface LibSQLDatabaseOptions {
  /** Credential-free HTTPS base URL of a server that implements JSON Hrana HTTP v3. */
  readonly serverUrl: string;
  /** Injected request headers, for example `{ authorization: `Bearer ${token}` }`. */
  readonly headers?: LibSQLHeadersProvider;
  /** Maps each DALgo collection to one explicit table projection. */
  readonly tables: Readonly<Record<string, LibSQLTable>>;
  /** Maximum records returned by a DALgo operation. Defaults to 1000. */
  readonly maxRows?: number;
  /** Maximum JSON response size accepted from the pipeline endpoint. Defaults to 1 MiB. */
  readonly maxResponseBytes?: number;
  /** Per-request deadline. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
  readonly fetch?: LibSQLFetch;
}
