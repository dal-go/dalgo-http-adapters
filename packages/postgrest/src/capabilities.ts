import type { AdapterReadCapabilities } from "@dalgo/adapter-runtime";

/**
 * Honest read/query capabilities of the PostgREST adapter.
 *
 * It reads existing exposed relations and never rewrites rows into a DALgo
 * envelope. It does not expose the PostgREST OpenAPI document, schema
 * discovery or raw query parameters.
 */
export const POSTGREST_READ_CAPABILITIES = {
  adapter: "@dal-go/dalgo2postgrest",
  storage: "native-rows",
  read: {
    get: true,
    getMany: true,
    maxGetManyKeys: { default: 100, maximum: 1_000 },
    maxParallelReads: { default: 8, maximum: 1_000 },
  },
  query: {
    projection: {
      status: "unsupported",
      detail: "records are always selected with select=*",
    },
    filter: {
      status: "native",
      detail: "simple column identifiers or DOCUMENT_ID; null only for equality and inequality",
    },
    sort: {
      status: "native",
      detail: "ascending or descending on simple column identifiers",
    },
    pagination: {
      status: "native",
      detail: "limit and offset; DALgo query cursors are refused",
    },
    joins: { status: "unsupported" },
    aggregation: { status: "unsupported" },
    grouping: { status: "unsupported" },
    subquery: { status: "unsupported" },
    fulltext: { status: "unsupported" },
    timeseries: { status: "unsupported" },
    native: {
      status: "unsupported",
      detail: "the adapter does not expose raw PostgREST query parameters",
    },
    discovery: {
      status: "unsupported",
      detail: "there is no OpenAPI, schema or relation discovery",
    },
  },
  bounds: {
    maxQueryLimit: { default: 100, maximum: 1_000 },
    maxRequestBytes: { default: 1_048_576, maximum: 16_777_216 },
    maxResponseBytes: { default: 1_048_576, maximum: 16_777_216 },
    filterOperators: [
      "==",
      "!=",
      "<",
      "<=",
      ">",
      ">=",
      "in",
      "not-in",
      "array-contains",
      "array-contains-any",
    ],
    orderDirections: ["asc", "desc"],
  },
} as const satisfies AdapterReadCapabilities;

export type PostgrestReadCapabilities = typeof POSTGREST_READ_CAPABILITIES;
