import type {
  AdapterReadCapabilities,
  NumericCapabilityBound,
  QueryCapabilityBounds,
} from "@dalgo/adapter-runtime";

/** Typesense-specific safety bounds in addition to the shared capability shape. */
export interface TypesenseQueryBounds extends QueryCapabilityBounds {
  readonly maxGetManyKeys: NumericCapabilityBound;
  readonly maxGetManyBytes: NumericCapabilityBound;
  readonly maxRowsPerPage: NumericCapabilityBound;
  readonly maxQueryPages: NumericCapabilityBound;
  readonly maxQueryOffset: NumericCapabilityBound;
  readonly maxTotalBytes: NumericCapabilityBound;
  readonly maxRowBytes: NumericCapabilityBound;
  readonly maxFilterBytes: NumericCapabilityBound;
  readonly maxColumns: NumericCapabilityBound;
  readonly maxSortFields: NumericCapabilityBound;
  readonly maxFacetFields: NumericCapabilityBound;
  readonly maxFacetValues: NumericCapabilityBound;
  readonly maxCursorBytes: NumericCapabilityBound;
  readonly maxIssuedCursors: NumericCapabilityBound;
}

export interface TypesenseCapabilityDescriptor extends Omit<AdapterReadCapabilities, "bounds"> {
  readonly bounds: TypesenseQueryBounds;
}

/**
 * Honest capabilities of the read-only native Typesense adapter.
 *
 * Structured filters admit only positive `==`, `in` and numeric ranges. Native
 * negative filters remain available only through the separately typed native
 * search, because the exact verifier cannot repair a native negative candidate
 * that omits an eligible row. `native` means a typed, bounded Typesense search
 * (q/query_by/filter_by/sort_by/facet_by), never a raw URL or admin escape.
 */
export const TYPESENSE_READ_CAPABILITIES = {
  adapter: "@dal-go/dalgo2typesense",
  storage: "native-rows",
  read: {
    get: true,
    getMany: true,
    maxGetManyKeys: { default: 100, maximum: 250 },
    maxParallelReads: { default: 1, maximum: 1 },
  },
  query: {
    projection: {
      status: "native",
      detail: "explicit unique top-level fields via include_fields; the native id and predicate helper fields are fetched but omitted unless explicitly requested",
    },
    filter: {
      status: "native",
      detail: "positive scalar ==, numeric <, <=, >, >= on schema-declared scalar numeric fields, and homogeneous scalar in lists; flat filters AND where, with bounded AND/OR groups; every native candidate is exactly verified before exposure and negative operators are refused before I/O",
    },
    sort: {
      status: "native",
      detail: "explicit simple fields and asc/desc by sort_by, up to the Typesense limit; no id sort is invented and offset pagination is not mutation-stable; an unfiltered limit above maxRowsPerPage is served by bounded physical paging or refused before I/O",
    },
    pagination: {
      status: "native",
      detail: "adapter-issued opaque single-use cursors bound to the endpoint, collection, exact admitted predicate AST (original operator and literal class, not only the widened native filter), page size, credential scope and configuration; a lease is taken only after all planning bounds pass and committed only after a successful page; each filtered page verifies the whole candidate prefix from zero; offset continuation is documented as non-snapshot-stable",
    },
    joins: { status: "unsupported" },
    aggregation: { status: "unsupported" },
    grouping: { status: "unsupported" },
    subquery: { status: "unsupported" },
    fulltext: {
      status: "native",
      detail: "only through the typed native search path, which keeps Typesense typo/prefix/drop-token semantics; the uint64 text_match ranking is exposed as an exact decimal string, never a rounded JavaScript number",
    },
    timeseries: { status: "unsupported" },
    native: {
      status: "native",
      detail: "typed q/query_by/filter_by/sort_by/facet_by/limit/offset search with bounded faceting; no arbitrary URL, options bag, management endpoint, multi-search, join or RPC surface",
    },
    discovery: {
      status: "native",
      detail: "read-only collection schema via GET /collections/{name} with the same per-request header callback; a pure documents:search credential is denied explicitly and there is no separate metadata option or admin fallback; the official empty default_sorting_field sentinel is accepted",
    },
  },
  bounds: {
    maxQueryLimit: { default: 100, maximum: 10_000 },
    maxRequestBytes: { default: 1_048_576, maximum: 16_777_216 },
    maxResponseBytes: { default: 1_048_576, maximum: 16_777_216 },
    maxGetManyKeys: { default: 100, maximum: 250 },
    maxGetManyBytes: { default: 1_048_576, maximum: 16_777_216 },
    maxRowsPerPage: { default: 100, maximum: 250 },
    maxQueryPages: { default: 20, maximum: 100 },
    maxQueryOffset: { default: 10_000, maximum: 1_000_000 },
    maxTotalBytes: { default: 16_777_216, maximum: 67_108_864 },
    maxRowBytes: { default: 1_048_576, maximum: 67_108_864 },
    maxFilterBytes: { default: 8_192, maximum: 65_536 },
    maxColumns: { default: 100, maximum: 250 },
    maxSortFields: { default: 3, maximum: 3 },
    maxFacetFields: { default: 5, maximum: 10 },
    maxFacetValues: { default: 100, maximum: 250 },
    maxCursorBytes: { default: 8_192, maximum: 65_536 },
    maxIssuedCursors: { default: 1_000, maximum: 10_000 },
    filterOperators: ["==", "<", "<=", ">", ">=", "in"],
    orderDirections: ["asc", "desc"],
  },
} as const satisfies TypesenseCapabilityDescriptor;

export type TypesenseReadCapabilities = typeof TYPESENSE_READ_CAPABILITIES;

/** Actual configured bounds are reported by the instance `capabilities` getter. */
export interface TypesenseConfiguredBounds {
  readonly maxGetManyKeys: number;
  readonly maxGetManyBytes: number;
  readonly maxParallelReads: number;
  readonly maxQueryLimit: number;
  readonly maxRowsPerPage: number;
  readonly maxQueryPages: number;
  readonly maxQueryOffset: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxTotalBytes: number;
  readonly maxRowBytes: number;
  readonly maxFilterBytes: number;
  readonly maxColumns: number;
  readonly maxSortFields: number;
  readonly maxFacetFields: number;
  readonly maxFacetValues: number;
  readonly maxCursorBytes: number;
  readonly maxIssuedCursors: number;
}
