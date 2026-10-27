import type {
  AdapterReadCapabilities,
  NumericCapabilityBound,
  QueryCapabilityBounds,
} from "@dalgo/adapter-runtime";

/** PostgREST-specific bounds in addition to the shared adapter capability shape. */
export interface PostgrestQueryBounds extends QueryCapabilityBounds {
  readonly maxQueryOffset: NumericCapabilityBound;
  readonly maxQueryPages: NumericCapabilityBound;
  readonly maxDiscoveryRelations: NumericCapabilityBound;
  readonly maxDiscoveryFieldsPerRelation: NumericCapabilityBound;
  readonly maxDiscoveryBytes: NumericCapabilityBound;
  readonly maxCursorBytes: NumericCapabilityBound;
  readonly maxSchemaDepth: NumericCapabilityBound;
}

export interface PostgrestCapabilityDescriptor extends Omit<AdapterReadCapabilities, "bounds"> {
  readonly bounds: PostgrestQueryBounds;
}

/**
 * Honest read/query capabilities of the PostgREST adapter.
 *
 * It reads existing exposed relations and never rewrites rows into a DALgo
 * envelope. Discovery is a bounded read of the OpenAPI document generated for
 * the request role; it is not an administration API and not a promise that the
 * role can read every advertised relation. Core `StructuredQuery` has no
 * projection field, so projection is explicitly unsupported rather than
 * silently ignored.
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
      detail: "core StructuredQuery has no projection; every record is selected with select=* and no field is silently dropped",
    },
    filter: {
      status: "native",
      detail: "simple column identifiers or DOCUMENT_ID; null only for equality and inequality",
    },
    sort: {
      status: "native",
      detail: "ascending or descending on simple column identifiers; queryWithSignal adds the configured primary key as a deterministic tie-breaker",
    },
    pagination: {
      status: "native",
      detail: "limit/offset in query and queryWithSignal, plus an adapter-bound opaque keyset cursor in queryWithSignal; legacy query refuses cursors; no count=exact or full scan",
    },
    joins: { status: "unsupported" },
    aggregation: { status: "unsupported" },
    grouping: { status: "unsupported" },
    subquery: { status: "unsupported" },
    fulltext: { status: "unsupported" },
    timeseries: { status: "unsupported" },
    native: {
      status: "unsupported",
      detail: "the adapter does not expose raw PostgREST query parameters, embedding, RPC or administration endpoints",
    },
    discovery: {
      status: "native",
      detail: "read-only bounded OpenAPI discovery of relations, declared field types and declared primary keys for the request role; denied/disabled/empty metadata is explicit",
    },
  },
  bounds: {
    maxQueryLimit: { default: 100, maximum: 1_000 },
    maxQueryOffset: { default: 100_000, maximum: 10_000_000 },
    maxQueryPages: { default: 10_000, maximum: 1_000_000 },
    maxRequestBytes: { default: 1_048_576, maximum: 16_777_216 },
    maxResponseBytes: { default: 1_048_576, maximum: 16_777_216 },
    maxDiscoveryRelations: { default: 100, maximum: 10_000 },
    maxDiscoveryFieldsPerRelation: { default: 200, maximum: 10_000 },
    maxDiscoveryBytes: { default: 524_288, maximum: 16_777_216 },
    maxCursorBytes: { default: 8_192, maximum: 65_536 },
    maxSchemaDepth: { default: 4, maximum: 16 },
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
} as const satisfies PostgrestCapabilityDescriptor;

export type PostgrestReadCapabilities = typeof POSTGREST_READ_CAPABILITIES;
