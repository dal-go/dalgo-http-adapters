import { Key, type ExistingRecord, type StructuredQuery } from "@dalgo/core";
import { stringify } from "yaml";

const fail = (): never => { throw new TypeError("invalid native OpenVaultDB DTQL query"); };
function closed(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail();
  const value = raw as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))) fail();
  return value;
}
export interface NativeEquality { readonly field: string; readonly value: string }
export function nativeCalendarDate(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value) && Number(value.slice(0, 4)) >= 1
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function encodeNativeQuery<T>(query: StructuredQuery<T>): { body: string; limit: number; filters: readonly NativeEquality[] } {
  closed(query, ["source", "filters", "orders"], ["limit", "offset", "startAt", "startAfter", "endAt", "endBefore"]);
  closed(query.source, ["kind", "name"], ["parent", "codec"]);
  if (query.source.kind !== "collection" || query.source.name !== "daily" || query.source.parent !== undefined || query.source.codec !== undefined
    || !Array.isArray(query.orders) || query.orders.length !== 0 || (query.offset ?? 0) !== 0 || query.startAt !== undefined || query.startAfter !== undefined
    || query.endAt !== undefined || query.endBefore !== undefined || !Array.isArray(query.filters) || query.filters.length > 10) fail();
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail();
  const comparisons = query.filters.map(filter => {
    closed(filter, ["field", "operator", "value"]);
    if (!["time", "currency", "rate"].includes(filter.field) || filter.operator !== "==" || typeof filter.value !== "string"
      || new TextEncoder().encode(filter.value).byteLength > 128) fail();
    return { op: "==", left: { field: filter.field }, right: { value: filter.value } };
  });
  const body = stringify({ from: { name: "daily" }, limit,
    ...(comparisons.length === 0 ? {} : { where: comparisons.length === 1 ? comparisons[0] : { and: comparisons } }) }, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" });
  if (new TextEncoder().encode(body).byteLength > 8192) fail();
  return { body, limit, filters: comparisons.map(comparison => ({ field: comparison.left.field, value: comparison.right.value as string })) };
}
export function nativeRecords<T>(raw: unknown, limit: number, referenceDate: string, filters: readonly NativeEquality[]): readonly ExistingRecord<T>[] {
  const invalid = (): never => { throw new TypeError("invalid native OpenVaultDB DTQL records"); };
  if (!Array.isArray(raw) || raw.length > limit) invalid();
  const currencies = new Set<string>();
  return (raw as unknown[]).map(item => {
    let record: Record<string, unknown>, row: Record<string, unknown>;
    try { record = closed(item, ["key", "data"]); row = closed(record.data, ["time", "currency", "rate"]); } catch { return invalid(); }
    if (!nativeCalendarDate(row.time) || row.time !== referenceDate
      || typeof row.currency !== "string" || !/^[A-Z]{3}$/u.test(row.currency) || row.currency === "EUR" || currencies.has(row.currency)
      || typeof row.rate !== "string" || !/^(?:0|[0-9]+)(?:\.[0-9]+)?$/u.test(row.rate) || row.rate.length > 128
      || row.rate.replaceAll(/[0.]/gu, "") === "" || record.key !== `daily/${row.currency}`
      || filters.some(filter => row[filter.field] !== filter.value)) return invalid();
    currencies.add(row.currency);
    return { key: new Key("daily", row.currency), exists: true, data: { ...row } as T };
  });
}
