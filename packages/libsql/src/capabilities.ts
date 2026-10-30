import type {
  AdapterReadCapabilities,
  NumericCapabilityBound,
  QueryCapabilityBounds,
} from "@dalgo/adapter-runtime";

/** libSQL-specific safety bounds in addition to the shared capability shape. */
export interface LibSQLQueryBounds extends QueryCapabilityBounds {
  readonly maxGetManyKeys: NumericCapabilityBound;
  readonly maxGetManyBytes: NumericCapabilityBound;
  readonly maxParallelReads: NumericCapabilityBound;
  readonly maxQueryPages: NumericCapabilityBound;
  readonly maxMetadataTables: NumericCapabilityBound;
  readonly maxMetadataFieldsPerTable: NumericCapabilityBound;
  readonly maxMetadataStatements: NumericCapabilityBound;
  readonly maxMetadataBytes: NumericCapabilityBound;
  readonly maxCursorBytes: NumericCapabilityBound;
}

export interface LibSQLCapabilityDescriptor extends Omit<AdapterReadCapabilities, "bounds"> {
  readonly bounds: LibSQLQueryBounds;
}

/**
 * Honest capabilities of the configured-table adapter. It reads and writes
 * existing SQLite/libSQL tables and never creates a DALgo storage envelope.
 * `getMany` is bounded and fail-fast; ordering and cursor paging are native SQL
 * keysets with a unique key tie-breaker. Raw SQL, arbitrary TugQL/joins,
 * aggregation, offsets, session/baton reuse and callback transactions are
 * unsupported rather than silently emulated.
 */
export const LIBSQL_READ_CAPABILITIES = {
  adapter: "@dalgo/dalgo2libsql",
  storage: "native-rows",
  read: {
    get: true,
    getMany: true,
    maxGetManyKeys: { default: 100, maximum: 1_000 },
    maxParallelReads: { default: 8, maximum: 1_000 },
  },
  query: {
    projection: {
      status: "configured",
      detail: "the explicit table mapping is the projection; an undeclared field never becomes visible through query metadata",
    },
    filter: {
      status: "native",
      detail: "simple mapped fields or DOCUMENT_ID with ==, !=, <, <=, > and >=; null only for equality and inequality; values are Hrana positional bindings, never SQL text",
    },
    sort: {
      status: "native",
      detail: "ascending or descending mapped columns; an order-less modern page uses the configured unique key as an honest deterministic order, and every ordered query appends that key as the final tie-breaker",
    },
    pagination: {
      status: "native",
      detail: "legacy query returns open keyset position values and never mints a cursor for an unordered query; queryWithSignal returns an adapter-issued, single-use, query/credential-bound handle, including for an unordered query continued in configured key order; SQL LIMIT makes each page explicit and an empty page is the only end signal",
    },
    joins: { status: "unsupported" },
    aggregation: { status: "unsupported" },
    grouping: { status: "unsupported" },
    subquery: { status: "unsupported" },
    fulltext: { status: "unsupported" },
    timeseries: { status: "unsupported" },
    native: {
      status: "unsupported",
      detail: "the adapter does not expose arbitrary SQL, raw Hrana batches, batons, attachments or a TugQL escape hatch",
    },
    discovery: {
      status: "native",
      detail: "bounded read-only sqlite metadata for tables, views, fields, declared types, nullability, primary keys and single-column unique indexes; denied, truncated and unsupported metadata are explicit",
    },
  },
  bounds: {
    maxQueryLimit: { default: 1_000, maximum: 1_000_000 },
    maxGetManyKeys: { default: 100, maximum: 1_000 },
    maxGetManyBytes: { default: 1_048_576, maximum: 16_777_216 },
    maxParallelReads: { default: 8, maximum: 1_000 },
    maxQueryPages: { default: 10_000, maximum: 1_000_000 },
    maxRequestBytes: { default: 1_048_576, maximum: 16_777_216 },
    maxResponseBytes: { default: 1_048_576, maximum: 16_777_216 },
    maxMetadataTables: { default: 100, maximum: 10_000 },
    maxMetadataFieldsPerTable: { default: 256, maximum: 10_000 },
    maxMetadataStatements: { default: 512, maximum: 10_000 },
    maxMetadataBytes: { default: 1_048_576, maximum: 16_777_216 },
    maxCursorBytes: { default: 8_192, maximum: 65_536 },
    filterOperators: ["==", "!=", "<", "<=", ">", ">="],
    orderDirections: ["asc", "desc"],
  },
} as const satisfies LibSQLCapabilityDescriptor;

/**
 * Capabilities of the read-only native facade. It addresses only explicitly
 * allowlisted existing tables/views, refuses every mutation before I/O, and
 * exposes bounded metadata for a future browser table factory.
 */
export const NATIVE_LIBSQL_READ_CAPABILITIES = {
  ...LIBSQL_READ_CAPABILITIES,
  query: {
    ...LIBSQL_READ_CAPABILITIES.query,
    pagination: {
      status: "native",
      detail: "every non-empty native page carries an adapter-issued single-use cursor bound to the endpoint, table, query, page size and credential scope, with the configured key as the deterministic order when the caller supplies none; only an empty page ends the stream",
    },
    filter: {
      status: "native",
      detail: "simple allowlisted fields or DOCUMENT_ID with ==, !=, <, <=, > and >=; native IDs keep their string or safe number type; nulls participate only in equality/inequality",
    },
  },
  bounds: {
    ...LIBSQL_READ_CAPABILITIES.bounds,
    maxQueryLimit: { default: 100, maximum: 1_000 },
  },
} as const satisfies LibSQLCapabilityDescriptor;

export type LibSQLReadCapabilities = typeof LIBSQL_READ_CAPABILITIES;
export type NativeLibSQLReadCapabilities = typeof NATIVE_LIBSQL_READ_CAPABILITIES;
