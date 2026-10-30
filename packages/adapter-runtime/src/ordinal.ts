import type { ParsedTugQLQuery, QueryColumn } from "@dalgo/core";

/** Exact, JSON-safe values for SQL results that have no record identity. */
export type OrdinalValue =
  | null | string | number | boolean
  | { readonly kind: "integer"; readonly value: string }
  | { readonly kind: "decimal"; readonly unscaled: string; readonly scale: number }
  | { readonly kind: "date"; readonly daysSinceEpoch: string }
  | { readonly kind: "datetime"; readonly ticksSinceEpoch: string; readonly scale: number; readonly timezone?: string }
  | { readonly kind: "array"; readonly values: readonly OrdinalValue[] }
  /** Entry pairs preserve non-string keys, order and duplicate keys. */
  | { readonly kind: "map"; readonly entries: readonly (readonly [OrdinalValue, OrdinalValue])[] };

export interface OrdinalColumn {
  /** Labels can repeat. Column position, not name, identifies a result cell. */
  readonly name: string;
  readonly nativeType: string;
}

export interface OrdinalQueryResult {
  readonly columns: readonly OrdinalColumn[];
  /** Every row has exactly columns.length cells. No synthetic record key. */
  readonly rows: readonly (readonly OrdinalValue[])[];
}

export interface OrdinalParameter {
  readonly name: string;
  /** Provider type, such as UInt64 or Decimal(38, 9). Never inferred from JS numbers. */
  readonly nativeType: string;
  readonly value: OrdinalValue;
}

export interface OrdinalNativeQuery {
  readonly kind: "native";
  /** Sent unchanged. Authorization is enforced by server credentials and policy. */
  readonly sql: string;
  readonly parameters?: readonly OrdinalParameter[];
}

export interface OrdinalStructuredQuery {
  readonly kind: "structured";
  /** The released DALgo query/condition model, not a parallel adapter DSL. */
  readonly query: ParsedTugQLQuery<Record<string, unknown>>;
  /** Explicit projections for legacy StructuredQuery, which has no columns. */
  readonly columns?: readonly QueryColumn[];
  readonly parameters?: readonly OrdinalParameter[];
}

export type OrdinalQuery = OrdinalNativeQuery | OrdinalStructuredQuery;

/**
 * Optional adapter capability, independent of core Database/ExistingRecord.
 * Signals cover credentials, transport and decoding. Server cancellation is a
 * provider capability and must be proved separately from browser abort.
 */
export interface OrdinalQueryExecutor {
  queryOrdinal(query: OrdinalQuery, signal?: AbortSignal): Promise<OrdinalQueryResult>;
}

export function isOrdinalQueryExecutor<T>(value: T): value is T & OrdinalQueryExecutor {
  return value !== null && (typeof value === "object" || typeof value === "function")
    && typeof (value as Record<string, unknown>).queryOrdinal === "function";
}
