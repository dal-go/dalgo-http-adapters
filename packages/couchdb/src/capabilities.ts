import type { AdapterReadCapabilities } from "@dalgo/adapter-runtime";

/**
 * Honest read/query capabilities of the current managed CouchDB layout.
 *
 * Records live in the adapter-owned `__dalgo_*` + `data` envelope. Reading
 * existing application documents and native Mango pass-through are future work
 * and are not claimed here.
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
