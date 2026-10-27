import type { AdapterReadCapabilities } from "@dalgo/adapter-runtime";

/**
 * Honest read/query capabilities of the managed-envelope layout.
 *
 * Records live in the adapter-owned `__dalgo_*` + `data` envelope. Native
 * application-document reading is a separate explicit mode with its own
 * `NATIVE_COUCHDB_READ_CAPABILITIES` descriptor and read-only facade.
 */
export const COUCHDB_READ_CAPABILITIES = {
  adapter: "@dal-go/dalgo2couchdb",
  storage: "managed-envelope",
  read: {
    get: true,
    getMany: true,
    maxGetManyKeys: { default: 100, maximum: 1_000 },
    maxParallelReads: { default: 8, maximum: 1_000 },
  },
  query: {
    projection: {
      status: "unsupported",
      detail: "records are always returned in full",
    },
    filter: {
      status: "native",
      detail: "simple top-level data fields or DOCUMENT_ID; null, undefined, array and complex field-path filters are refused",
    },
    sort: {
      status: "unsupported",
      detail: "ordered DALgo queries are refused; Mango index order is not a portable contract",
    },
    pagination: {
      status: "native",
      detail: "limit plus an adapter-bound Mango bookmark cursor; offsets and other cursors are refused",
    },
    joins: { status: "unsupported" },
    aggregation: { status: "unsupported" },
    grouping: { status: "unsupported" },
    subquery: { status: "unsupported" },
    fulltext: { status: "unsupported" },
    timeseries: { status: "unsupported" },
    native: {
      status: "unsupported",
      detail: "the adapter does not expose a raw Mango request",
    },
    discovery: {
      status: "unsupported",
      detail: "there is no database, index or schema discovery",
    },
  },
  bounds: {
    maxQueryLimit: { default: 100, maximum: 1_000 },
    maxRequestBytes: { default: 1_048_576, maximum: 16_777_216 },
    maxResponseBytes: { default: 1_048_576, maximum: 16_777_216 },
    filterOperators: ["==", "!=", "<", "<=", ">", ">=", "in", "not-in"],
    orderDirections: [],
  },
} as const satisfies AdapterReadCapabilities;

export type CouchDbReadCapabilities = typeof COUCHDB_READ_CAPABILITIES;

/**
 * Honest read/query capabilities of the native application-document mode.
 *
 * A native database maps to one configured logical collection. It reads
 * existing documents without a DALgo envelope, preserves `_id`/`_rev`, and
 * refuses every mutation. Ordered queries are available only through an
 * explicit permitted index; no raw Mango selector escape hatch is exposed.
 */
export const NATIVE_COUCHDB_READ_CAPABILITIES = {
  adapter: "@dal-go/dalgo2couchdb",
  storage: "native-rows",
  read: {
    get: true,
    getMany: true,
    maxGetManyKeys: { default: 100, maximum: 1_000 },
    maxParallelReads: { default: 8, maximum: 1_000 },
  },
  query: {
    projection: {
      status: "native",
      detail: "Mango fields projection through the adapter's optional projection; _id must be included and is never dropped",
    },
    filter: {
      status: "native",
      detail: "simple top-level fields, _id and _rev; ==/!= null match explicit null or present-non-null and never missing fields; other null comparisons and complex paths are refused",
    },
    sort: {
      status: "configured",
      detail: "only an explicitly permitted index whose fields exactly match the order plus a final _id tie-break; fallback scans are disabled",
    },
    pagination: {
      status: "native",
      detail: "stable limit plus an adapter-issued opaque single-use handle; bounded stored query, page size, instance, credential-scope and bookmark binding",
    },
    joins: { status: "unsupported" },
    aggregation: { status: "unsupported" },
    grouping: { status: "unsupported" },
    subquery: { status: "unsupported" },
    fulltext: { status: "unsupported" },
    timeseries: { status: "unsupported" },
    native: {
      status: "unsupported",
      detail: "there is no raw selector/order escape hatch; native documents use the same bounded structured query and optional projection",
    },
    discovery: {
      status: "native",
      detail: "configured database info, database _index and bounded _all_docs field sampling; no cluster _all_dbs or administration APIs",
    },
  },
  bounds: {
    maxQueryLimit: { default: 100, maximum: 1_000 },
    maxRequestBytes: { default: 1_048_576, maximum: 16_777_216 },
    maxResponseBytes: { default: 1_048_576, maximum: 16_777_216 },
    filterOperators: ["==", "!=", "<", "<=", ">", ">=", "in", "not-in"],
    orderDirections: ["asc", "desc"],
  },
} as const satisfies AdapterReadCapabilities;

export type NativeCouchDbReadCapabilities = typeof NATIVE_COUCHDB_READ_CAPABILITIES;
