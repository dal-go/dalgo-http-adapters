import { DOCUMENT_ID, UnsupportedError, type StructuredQuery } from "@dal-go/dalgo";
import { endAt, endBefore, equalTo, limitToFirst, orderByChild, orderByKey, query, startAfter, startAt, type DatabaseReference, type Query } from "firebase/database";

function scalar(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  throw new UnsupportedError("RTDB query values must be scalar");
}
function safeField(value: string): string { if (value.length === 0 || /[.#$[\]/]/.test(value)) throw new UnsupportedError("RTDB query fields must be one safe child field"); return value; }

export function compileRtdbQuery<T>(reference: DatabaseReference, value: StructuredQuery<T>): Query {
  if (value.source.kind !== "collection") throw new UnsupportedError("RTDB collection-group queries");
  if ((value.offset ?? 0) !== 0) throw new UnsupportedError("RTDB query offsets");
  if (value.orders.length > 1 || value.filters.length > 1) throw new UnsupportedError("RTDB queries with multiple orders or filters");
  const order = value.orders[0];
  const filter = value.filters[0];
  if (order?.direction === "desc") throw new UnsupportedError("RTDB descending queries");
  if (filter !== undefined && !["==", "<", "<=", ">", ">="].includes(filter.operator)) throw new UnsupportedError(`RTDB ${filter.operator} filters`);
  if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit <= 0)) throw new RangeError("RTDB query limit must be a positive safe integer");
  if (value.startAfter !== undefined && value.startAt !== undefined) throw new UnsupportedError("RTDB conflicting start cursors");
  if ((value.startAfter !== undefined || value.startAt !== undefined) && filter !== undefined) throw new UnsupportedError("RTDB filters combined with cursors");
  const queryField = order?.field ?? filter?.field;
  if (filter !== undefined && order !== undefined && filter.field !== order.field) throw new UnsupportedError("RTDB filter/order fields must match");
  const constraints = [];
  if (queryField !== undefined) constraints.push(queryField === DOCUMENT_ID ? orderByKey() : orderByChild(safeField(queryField))); else if (value.startAfter !== undefined || value.startAt !== undefined) constraints.push(orderByKey());
  if (filter?.operator === "==") constraints.push(equalTo(scalar(filter.value)));
  if (filter?.operator === ">" || filter?.operator === ">=") constraints.push(filter.operator === ">" ? startAfter(scalar(filter.value)) : startAt(scalar(filter.value)));
  if (filter?.operator === "<" || filter?.operator === "<=") constraints.push(filter.operator === "<" ? endBefore(scalar(filter.value)) : endAt(scalar(filter.value)));
  const cursor = value.startAfter ?? value.startAt;
  if (value.endAt !== undefined || value.endBefore !== undefined) throw new UnsupportedError("RTDB end cursors");
  if (cursor !== undefined) { if (cursor.values.length !== 1) throw new UnsupportedError("RTDB multi-value cursors"); const cursorValue = cursor.values[0]; constraints.push(value.startAfter === undefined ? startAt(scalar(cursorValue)) : startAfter(scalar(cursorValue))); }
  if (value.limit !== undefined) constraints.push(limitToFirst(value.limit));
  return query(reference, ...constraints);
}
