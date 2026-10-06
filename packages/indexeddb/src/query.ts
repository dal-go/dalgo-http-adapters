import {
  DOCUMENT_ID,
  Key,
  type ExistingRecord,
  type FieldPath,
  type QueryCursor,
  type QueryFilter,
  type QueryOrder,
  type QueryPage,
  type QuerySource,
  type StructuredQuery,
} from "@dalgo/core";
import { collectionPath, deserializeKey, type SerializedKeyPart } from "./path.js";
import { assertLeafQuery } from "./guard.js";

export interface StoredRecord {
  readonly path: string;
  readonly collectionPath: string;
  readonly collectionName: string;
  readonly id: string | number;
  readonly keyParts: readonly SerializedKeyPart[];
  readonly data: unknown;
}

export interface QueryStore {
  index(name: "collectionPath" | "collectionName"): IDBIndex;
}

/** Adapter-specific hints for exact numeric wire tokens and cancellable scans. */
export interface IndexedDbQueryHints {
  readonly numericFields?: readonly string[];
  readonly signal?: AbortSignal;
}

const queryHints = Symbol("indexedDbQueryHints");
type HintedQuery<T> = StructuredQuery<T> & { readonly [queryHints]?: IndexedDbQueryHints };

export function withIndexedDbQueryHints<T>(query: StructuredQuery<T>, hints: IndexedDbQueryHints): StructuredQuery<T> {
  if (hints.numericFields?.some((field) => !field || field === DOCUMENT_ID)) {
    throw new TypeError("numeric field hints must name data fields");
  }
  const hinted: HintedQuery<T> = { ...query, [queryHints]: hints };
  return hinted;
}

function exactNumeric(value: unknown): { coefficient: bigint; scale: number } {
  if (typeof value !== "string" && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new TypeError("an exact numeric field requires a decimal string or safe integer");
  }
  const text = String(value);
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new TypeError("invalid exact numeric token");
  const exponent = Number(match[5] ?? 0);
  const fraction = match[3] ?? match[4] ?? "";
  const scale = fraction.length - exponent;
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 1000 || text.length > 1100) {
    throw new RangeError("exact numeric token exceeds the IndexedDB comparison bound");
  }
  const coefficient = BigInt(`${match[1] === "-" ? "-" : ""}${match[2] ?? "0"}${fraction}`);
  return { coefficient, scale };
}

function compareExactNumeric(left: unknown, right: unknown): number {
  const a = exactNumeric(left);
  const b = exactNumeric(right);
  const scale = Math.max(a.scale, b.scale);
  const scaledA = a.coefficient * 10n ** BigInt(scale - a.scale);
  const scaledB = b.coefficient * 10n ** BigInt(scale - b.scale);
  return scaledA < scaledB ? -1 : scaledA > scaledB ? 1 : 0;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function fieldValue(data: unknown, field: string): unknown {
  let value = data;
  for (const part of field.split(".")) {
    if (!isObject(value)) return undefined;
    value = value[part];
  }
  return value;
}

function comparable(value: unknown): readonly [number, string | number | bigint] {
  if (value === undefined) return [0, ""];
  if (value === null) return [1, ""];
  if (value instanceof Date) return [2, value.getTime()];
  if (typeof value === "number") return [3, value];
  if (typeof value === "bigint") return [4, value];
  if (typeof value === "string") return [5, value];
  if (typeof value === "boolean") return [6, value ? 1 : 0];
  const serialized = JSON.stringify(value) as string | undefined;
  return [7, serialized ?? Object.prototype.toString.call(value)];
}

function compareValues(left: unknown, right: unknown): number {
  if (deepEqual(left, right)) return 0;
  const [leftRank, leftValue] = comparable(left);
  const [rightRank, rightValue] = comparable(right);
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  if (leftValue < rightValue) return -1;
  return 1;
}

function documentIdValue(record: StoredRecord, source: QuerySource<unknown>): string | number {
  return source.kind === "collection" ? record.id : record.path;
}

function normalizeDocumentId(value: unknown, source: QuerySource<unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeDocumentId(item, source));
  }
  if (value instanceof Key) {
    if (source.kind === "collection") {
      const expected = collectionPath(source);
      if (value.collectionPath !== expected) {
        throw new TypeError(`document key belongs to ${value.collectionPath}, expected ${expected}`);
      }
      return value.id;
    }
    if (value.collection !== source.name) {
      throw new TypeError(`document key belongs to ${value.collection}, expected ${source.name}`);
    }
    return value.path;
  }
  return value;
}

function recordField<T>(record: StoredRecord, field: FieldPath<T>, source: QuerySource<T>): unknown {
  return field === DOCUMENT_ID ? documentIdValue(record, source) : fieldValue(record.data, field);
}

function arrayOperand(value: unknown, operator: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${operator} requires an array operand`);
  return value;
}

function matchesFilter<T>(record: StoredRecord, filter: QueryFilter<T>, source: QuerySource<T>, numericFields: ReadonlySet<string>): boolean {
  const actual = recordField(record, filter.field, source);
  const expected = filter.field === DOCUMENT_ID
    ? normalizeDocumentId(filter.value, source)
    : filter.value;
  const numeric = numericFields.has(filter.field) && actual !== null && actual !== undefined;
  const equal = (value: unknown) => numeric && value != null ? compareExactNumeric(actual, value) === 0 : deepEqual(actual, value);
  const compare = (value: unknown) => numeric && value != null ? compareExactNumeric(actual, value) : compareValues(actual, value);
  if (numericFields.has(filter.field) && ["<", "<=", ">", ">="].includes(filter.operator) &&
      (actual == null || expected == null)) return false;
  switch (filter.operator) {
    case "==": return equal(expected);
    case "!=": return !equal(expected);
    case "<": return compare(expected) < 0;
    case "<=": return compare(expected) <= 0;
    case ">": return compare(expected) > 0;
    case ">=": return compare(expected) >= 0;
    case "in": return arrayOperand(expected, "in").some(equal);
    case "not-in": return !arrayOperand(expected, "not-in").some(equal);
    case "array-contains": return Array.isArray(actual) && actual.some((value) => deepEqual(value, expected));
    case "array-contains-any": {
      const candidates = arrayOperand(expected, "array-contains-any");
      return Array.isArray(actual)
        && actual.some((value) => candidates.some((candidate) => deepEqual(value, candidate)));
    }
  }
}

export function queryOrders<T>(query: StructuredQuery<T>): readonly QueryOrder<T>[] {
  if (query.orders.some(({ field }) => field === DOCUMENT_ID)) return query.orders;
  return [
    ...query.orders,
    { field: DOCUMENT_ID, direction: query.orders.at(-1)?.direction ?? "asc" },
  ];
}

function tuple<T>(record: StoredRecord, orders: readonly QueryOrder<T>[], source: QuerySource<T>): readonly unknown[] {
  return orders.map(({ field }) => recordField(record, field, source));
}

function normalizeCursor<T>(cursor: QueryCursor, orders: readonly QueryOrder<T>[], source: QuerySource<T>): readonly unknown[] {
  if (cursor.values.length !== orders.length) {
    throw new TypeError(
      `cursor has ${cursor.values.length.toString()} values but the query has ${orders.length.toString()} order fields`,
    );
  }
  return cursor.values.map((value, index) => (
    orders[index]?.field === DOCUMENT_ID ? normalizeDocumentId(value, source) : value
  ));
}

function compareTuples<T>(left: readonly unknown[], right: readonly unknown[], orders: readonly QueryOrder<T>[], numeric: ReadonlySet<string>): number {
  for (let index = 0; index < orders.length; index += 1) {
    const order = orders[index];
    if (!order) throw new RangeError("missing IndexedDB query order");
    const comparison = numeric.has(order.field) && left[index] != null && right[index] != null
      ? compareExactNumeric(left[index], right[index]) : compareValues(left[index], right[index]);
    if (comparison !== 0) return order.direction === "desc" ? -comparison : comparison;
  }
  return 0;
}

function scanIndex(index: IDBIndex, sourceValue: string, signal: AbortSignal | undefined, visit: (record: StoredRecord) => void): Promise<void> {
  const abortError = () => signal?.reason instanceof Error ? signal.reason : new DOMException("Query aborted", "AbortError");
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const request = index.openCursor(sourceValue);
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error instanceof Error ? error : new Error("IndexedDB cursor query failed"));
    };
    const abort = () => { finish(abortError()); };
    signal?.addEventListener("abort", abort, { once: true });
    request.addEventListener("error", () => { finish(request.error ?? new Error("IndexedDB cursor failed")); }, { once: true });
    request.addEventListener("success", () => {
      if (settled) return;
      const cursor = request.result;
      if (!cursor) { finish(); return; }
      try {
        visit(cursor.value as StoredRecord);
        cursor.continue();
      } catch (error) { finish(error); }
    });
  });
}

export async function executeQuery<T>(store: QueryStore, query: StructuredQuery<T>): Promise<QueryPage<T>> {
  assertLeafQuery(query);
  const sourceValue = query.source.kind === "collection" ? collectionPath(query.source) : query.source.name;
  const indexName = query.source.kind === "collection" ? "collectionPath" : "collectionName";
  const orders = queryOrders(query);
  const hints = (query as HintedQuery<T>)[queryHints];
  const numeric = new Set(hints?.numericFields ?? []);
  const compareRecords = (left: StoredRecord, right: StoredRecord) =>
    compareTuples(tuple(left, orders, query.source), tuple(right, orders, query.source), orders, numeric);
  const bounds = [
    query.startAt && { values: normalizeCursor(query.startAt, orders, query.source), accept: (value: number) => value >= 0 },
    query.startAfter && { values: normalizeCursor(query.startAfter, orders, query.source), accept: (value: number) => value > 0 },
    query.endAt && { values: normalizeCursor(query.endAt, orders, query.source), accept: (value: number) => value <= 0 },
    query.endBefore && { values: normalizeCursor(query.endBefore, orders, query.source), accept: (value: number) => value < 0 },
  ].filter((bound): bound is { values: readonly unknown[]; accept: (value: number) => boolean } => Boolean(bound));
  const offset = query.offset ?? 0;
  const capacity = query.limit === undefined ? Infinity : offset + query.limit;
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 0)) ||
      (capacity !== Infinity && !Number.isSafeInteger(capacity))) {
    throw new RangeError("IndexedDB query offset and limit must be nonnegative safe integers");
  }
  const records: StoredRecord[] = [];
  if (capacity !== 0) await scanIndex(store.index(indexName), sourceValue, hints?.signal, (record) => {
    if (!query.filters.every((filter) => matchesFilter(record, filter, query.source, numeric))) return;
    const values = tuple(record, orders, query.source);
    if (!bounds.every((bound) => bound.accept(compareTuples(values, bound.values, orders, numeric)))) return;
    if (capacity === Infinity) { records.push(record); return; }
    let low = 0;
    let high = records.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const candidate = records[middle];
      if (!candidate) throw new RangeError("missing IndexedDB query candidate");
      if (compareRecords(candidate, record) <= 0) low = middle + 1;
      else high = middle;
    }
    if (records.length === capacity && low === records.length) return;
    records.splice(low, 0, record);
    if (records.length > capacity) records.pop();
  });
  if (capacity === Infinity) records.sort(compareRecords);
  const pageRecords = records.slice(offset, query.limit === undefined ? undefined : offset + query.limit);
  const codec = query.source.codec;
  const output = pageRecords.map((record): ExistingRecord<T> => ({
    key: deserializeKey(record.keyParts),
    exists: true,
    data: codec === undefined ? record.data as T : codec.decode(record.data),
    metadata: { source: "indexeddb" },
  }));
  const last = pageRecords.at(-1);
  const nextCursor = query.limit !== undefined && pageRecords.length === query.limit && last !== undefined
    ? { values: tuple(last, orders, query.source) }
    : undefined;
  return { records: output, ...(nextCursor === undefined ? {} : { nextCursor }) };
}
