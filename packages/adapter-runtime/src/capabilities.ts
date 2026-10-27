import type { OrderDirection, QueryOperator } from "@dalgo/core";

/**
 * How an adapter actually implements one capability. Consumers must read the
 * descriptor for the adapter they are using and must not infer capabilities
 * from an engine or product name.
 *
 * - `native`: the provider executes it.
 * - `bounded-client`: the adapter computes it with bounded local work.
 * - `configured`: it works only against explicitly configured resources.
 * - `unsupported`: the adapter refuses it before any provider request.
 */
export type CapabilityStatus =
  | "native"
  | "bounded-client"
  | "configured"
  | "unsupported";

export interface QueryFeatureCapability {
  readonly status: CapabilityStatus;
  /** Human-readable boundary. It must not contain data or credentials. */
  readonly detail?: string;
}

/** A constructor default and the hard maximum enforced by the adapter. */
export interface NumericCapabilityBound {
  readonly default: number;
  readonly maximum: number;
}

export interface ReadCapabilities {
  readonly get: boolean;
  readonly getMany: boolean;
  readonly maxGetManyKeys: NumericCapabilityBound;
  readonly maxParallelReads: NumericCapabilityBound;
}

/**
 * One capability row per feature the delivery plan requires. An absent
 * sub-feature is never implied: `unsupported` is explicit.
 */
export interface ReadQueryCapabilities {
  readonly projection: QueryFeatureCapability;
  readonly filter: QueryFeatureCapability;
  readonly sort: QueryFeatureCapability;
  readonly pagination: QueryFeatureCapability;
  readonly joins: QueryFeatureCapability;
  readonly aggregation: QueryFeatureCapability;
  readonly grouping: QueryFeatureCapability;
  readonly subquery: QueryFeatureCapability;
  readonly fulltext: QueryFeatureCapability;
  readonly timeseries: QueryFeatureCapability;
  /** Raw provider query language or command escape hatch. */
  readonly native: QueryFeatureCapability;
  /** Schema, index or resource discovery. */
  readonly discovery: QueryFeatureCapability;
}

export interface QueryCapabilityBounds {
  readonly maxQueryLimit: NumericCapabilityBound;
  readonly maxRequestBytes: NumericCapabilityBound;
  readonly maxResponseBytes: NumericCapabilityBound;
  readonly filterOperators: readonly QueryOperator[];
  readonly orderDirections: readonly OrderDirection[];
}

/**
 * `managed-envelope` means DALgo owns an envelope around records (for example
 * `__dalgo_*` properties plus `data`). `native-rows` means the adapter reads
 * existing provider records without rewriting them.
 */
export type AdapterStorageLayout = "managed-envelope" | "native-rows";

export interface AdapterReadCapabilities {
  readonly adapter: string;
  readonly storage: AdapterStorageLayout;
  readonly read: ReadCapabilities;
  readonly query: ReadQueryCapabilities;
  readonly bounds: QueryCapabilityBounds;
}
