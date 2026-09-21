import { UnsupportedError } from "@dalgo/core";

const queryKeys = new Set(["source", "filters", "orders", "limit", "offset", "startAt", "startAfter", "endAt", "endBefore"]);
const sourceKeys = new Set(["kind", "name", "parent", "codec"]);
const filterKeys = new Set(["field", "operator", "value"]);
const orderKeys = new Set(["field", "direction"]);

export function assertLeafQuery(value: unknown): void {
  const reject = (): never => { throw new UnsupportedError("recursive DTQL requires the core recursive executor"); };
  if (typeof value !== "object" || value === null) reject();
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some((key) => !queryKeys.has(key))) reject();
  const source = query.source;
  if (typeof source !== "object" || source === null) reject();
  const relation = source as Record<string, unknown>;
  if ((relation.kind !== "collection" && relation.kind !== "collection-group") || Object.keys(relation).some((key) => !sourceKeys.has(key))) reject();
  if (!Array.isArray(query.filters) || !Array.isArray(query.orders)) reject();
  const filters = query.filters as unknown[];
  const orders = query.orders as unknown[];
  if (filters.some((item) => typeof item !== "object" || item === null || Object.keys(item).some((key) => !filterKeys.has(key)))) reject();
  if (orders.some((item) => typeof item !== "object" || item === null || Object.keys(item).some((key) => !orderKeys.has(key)))) reject();
}
