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

/** The native SQL storage class a configured primary key must preserve. */
export type LibSQLKeyType = "text" | "integer" | "real";

/** A read-only mapping of one native column. The key column is configured separately. */
export interface NativeLibSQLColumn {
  readonly column: string;
  /**
   * `true` when the native column can hold NULL. It is a discovery/label fact,
   * not a permission to write, and a nullable key column cannot be used as a
   * stable unique ID.
   */
  readonly nullable: boolean;
}

/** One explicit read-only allowlist entry for an existing table or view. */
export interface NativeLibSQLTable {
  readonly table: string;
  /** The native single-column identity. Its storage class must be declared explicitly. */
  readonly key: {
    readonly column: string;
    readonly type: LibSQLKeyType;
  };
  /** Explicit data-field allowlist. The key column must not be repeated here. */
  readonly columns: Readonly<Record<string, NativeLibSQLColumn>>;
  /**
   * The caller's explicit one-row-per-key contract. It is required for every
   * native allowlist entry: metadata discovery can prove a key independently,
   * but it never expands the read allowlist or authorises a query by itself.
   */
  readonly uniqueKey: true;
}

export interface LibSQLDatabaseOptions {
  /** Credential-free HTTPS base URL of a server that implements JSON Hrana HTTP v3. */
  readonly serverUrl: string;
  /**
   * Allows plain HTTP only for `localhost`, `127.0.0.1` or `[::1]`. HTTPS is
   * the default and remains the only option for every hosted origin.
   */
  readonly allowInsecureLoopbackHttp?: boolean;
  /** Injected request headers, for example `{ authorization: `Bearer ${token}` }`. */
  readonly headers?: LibSQLHeadersProvider;
  /** Maps each DALgo collection to one explicit table projection. */
  readonly tables: Readonly<Record<string, LibSQLTable>>;
  /**
   * Stable, non-secret tenant/user identity bound into modern opaque cursors. If
   * omitted, cursors are bound to a digest of the headers actually used, so a
   * rotating token retires outstanding cursors instead of crossing auth scopes.
   */
  readonly identityScope?: string;
  /** Maximum records returned by one DALgo operation and the legacy `query` limit. Defaults to 1000. */
  readonly maxRows?: number;
  /** Maximum keys accepted by one `getMany`. Defaults to min(100, maxRows). */
  readonly maxGetManyKeys?: number;
  /** Maximum concurrent point reads inside one `getMany`. Defaults to 8. */
  readonly maxParallelReads?: number;
  /** Cumulative response bytes one `getMany` may retain. Defaults to 1 MiB. */
  readonly maxGetManyBytes?: number;
  /** Maximum JSON request bytes. Defaults to 1 MiB. */
  readonly maxRequestBytes?: number;
  /** Maximum JSON response size accepted from the pipeline endpoint. Defaults to 1 MiB. */
  readonly maxResponseBytes?: number;
  /** Per-operation deadline. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /** Maximum pages one opaque cursor family may continue. Defaults to 10 000. */
  readonly maxQueryPages?: number;
  /** Maximum characters in one opaque or legacy string cursor value. Defaults to 8192. */
  readonly maxCursorBytes?: number;
  /** Maximum pending opaque cursors. Defaults to 1000. */
  readonly maxIssuedCursors?: number;
  /** Maximum consumed cursor handles retained for replay detection. Defaults to 1000. */
  readonly maxConservedCursors?: number;
  /** Maximum tables or views described by one discovery. Defaults to 100. */
  readonly maxMetadataTables?: number;
  /** Maximum columns retained for one discovered table. Defaults to 256. */
  readonly maxMetadataFieldsPerTable?: number;
  /** Maximum statements in one discovery pipeline request. Defaults to 512. */
  readonly maxMetadataStatements?: number;
  /** Maximum JSON bytes accepted for one discovery response. Defaults to 1 MiB. */
  readonly maxMetadataBytes?: number;
  readonly fetch?: LibSQLFetch;
}

export interface NativeLibSQLDatabaseOptions {
  readonly serverUrl: string;
  /** Explicit opt-in required before a loopback HTTP URL is accepted. */
  readonly allowInsecureLoopbackHttp?: boolean;
  readonly headers?: LibSQLHeadersProvider;
  /** Explicit per-collection allowlist. Discovery never expands it. */
  readonly tables: Readonly<Record<string, NativeLibSQLTable>>;
  /** Stable, non-secret identity bound into cursors; falls back to a header digest. */
  readonly identityScope?: string;
  readonly maxGetManyKeys?: number;
  readonly maxParallelReads?: number;
  readonly maxGetManyBytes?: number;
  readonly maxQueryLimit?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  readonly maxQueryPages?: number;
  /** Maximum characters in one native cursor position (keyset value). Defaults to 8192. */
  readonly maxCursorBytes?: number;
  readonly maxIssuedCursors?: number;
  readonly maxConservedCursors?: number;
  readonly maxMetadataTables?: number;
  readonly maxMetadataFieldsPerTable?: number;
  readonly maxMetadataStatements?: number;
  readonly maxMetadataBytes?: number;
  readonly fetch?: LibSQLFetch;
}

/** SQLite's column affinity, derived from the declared type text. */
export type LibSQLColumnAffinity = "integer" | "real" | "text" | "blob" | "numeric" | "any";

export interface LibSQLFieldDiscovery {
  readonly name: string;
  /** The declared type text exactly as SQLite reports it, or `""` when undeclared. */
  readonly declaredType: string;
  readonly affinity: LibSQLColumnAffinity;
  readonly nullable: boolean;
  /** 1-based position in the primary key, or 0 for a non-key column. */
  readonly primaryKeyPosition: number;
  /** SQLite's `hidden` flag: 1 for a hidden virtual-table column, 2 or 3 for generated columns. */
  readonly hidden: number;
  /** Default value SQL expression text, or `null`. */
  readonly defaultValue: string | null;
}

export type LibSQLUniquenessStatus =
  | "declared-primary-key"
  | "unique-index"
  | "configured-contract"
  | "not-unique"
  | "unavailable";

export interface LibSQLUniquenessDiscovery {
  readonly status: LibSQLUniquenessStatus;
  readonly columns: readonly string[];
  readonly indexName?: string;
  readonly detail: string;
}

export interface LibSQLPrimaryKeyDiscovery {
  readonly status: "declared" | "not-declared" | "unavailable";
  readonly columns: readonly string[];
}

export interface LibSQLConfiguredKeyDiscovery {
  readonly collection: string;
  readonly column: string;
  /** Present for a native mapping, whose storage class is explicit; omitted for a managed mapping. */
  readonly type?: LibSQLKeyType;
}

export interface LibSQLTableDiscovery {
  readonly name: string;
  readonly kind: "table" | "view";
  /** `false` when the table is not in the adapter's explicit configuration allowlist. */
  readonly allowlisted: boolean;
  readonly fields: readonly LibSQLFieldDiscovery[];
  readonly fieldsStatus: "declared" | "truncated" | "unavailable";
  readonly omittedFields: number;
  readonly primaryKey: LibSQLPrimaryKeyDiscovery;
  readonly unique: LibSQLUniquenessDiscovery;
  readonly configuredKey?: LibSQLConfiguredKeyDiscovery;
  /** True only when this adapter instance can address rows of this table with its configured key. */
  readonly adapterQueryable: boolean;
  readonly adapterQueryableReason?: string;
}

export type LibSQLDiscoveryReason =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "request-failed"
  | "malformed-metadata"
  | "metadata-unsupported"
  | "metadata-too-large";

export interface LibSQLDiscoveryBounds {
  readonly maxTables: number;
  readonly maxFieldsPerTable: number;
  readonly maxStatements: number;
  readonly maxMetadataBytes: number;
}

/**
 * Bounded read-only metadata. `status: "unavailable"` is deliberately distinct
 * from an available database that currently has no user tables.
 */
export interface LibSQLDiscovery {
  readonly adapter: "@dalgo/dalgo2libsql";
  readonly protocol: "sqlite-hrana-pipeline";
  readonly endpoint: string;
  readonly status: "available" | "unavailable";
  readonly reason?: LibSQLDiscoveryReason;
  readonly detail: string;
  readonly httpStatus?: number;
  readonly tables: readonly LibSQLTableDiscovery[];
  readonly tableCount: number;
  readonly truncated: boolean;
  readonly omittedTables: number;
  readonly bounds: LibSQLDiscoveryBounds;
}

export interface LibSQLConnectionStatus {
  readonly ok: boolean;
  readonly status:
    | "connected"
    | "unauthorized"
    | "forbidden"
    | "metadata-malformed"
    | "metadata-unsupported"
    | "unreachable";
  readonly httpStatus?: number;
  readonly tableCount?: number;
  readonly detail: string;
}

export interface NativeLibSQLDescribe {
  readonly adapter: "@dalgo/dalgo2libsql";
  readonly storage: "native-rows";
  readonly readOnly: true;
  readonly endpoint: string;
  readonly connection: LibSQLConnectionStatus;
  readonly discovery: LibSQLDiscovery;
  readonly limits: {
    readonly maxGetManyKeys: number;
    readonly maxGetManyBytes: number;
    readonly maxParallelReads: number;
    readonly maxQueryLimit: number;
    readonly maxRequestBytes: number;
    readonly maxResponseBytes: number;
    readonly maxMetadataTables: number;
    readonly maxMetadataFieldsPerTable: number;
    readonly maxMetadataStatements: number;
    readonly maxMetadataBytes: number;
    readonly maxQueryPages: number;
    readonly maxCursorBytes: number;
    readonly maxIssuedCursors: number;
    readonly maxConservedCursors: number;
  };
}
