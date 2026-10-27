import { UnsupportedError } from "@dalgo/core";

import { postgrestFieldKey } from "./fields.js";
import { isUnsafeNativeNumber, parseLosslessJson } from "./json.js";

/** Stable, adapter-owned cursor identity. A cursor from another adapter is foreign. */
export const POSTGREST_CURSOR_ADAPTER = "@dal-go/dalgo2postgrest";
export const POSTGREST_CURSOR_VERSION = 1;

export type PostgrestCursorValue = string | number | boolean | null;
export type PostgrestOrderDirection = "asc" | "desc";

export interface PostgrestCursorOrder {
  /** Physical PostgREST column, already mapped from a DALgo field. */
  readonly field: string;
  readonly direction: PostgrestOrderDirection;
}

/**
 * The immutable part of a cursor. Every value that can change the meaning of a
 * continuation is bound here so a cursor from another endpoint, relation, role
 * scope, filter, order, projection or page size is refused instead of silently
 * returning a different result set.
 */
export interface PostgrestCursorBinding {
  readonly endpoint: string;
  readonly collection: string;
  readonly relation: string;
  readonly schema?: string;
  readonly idColumn: string;
  readonly select: "*";
  readonly filters: readonly (readonly [string, string])[];
  readonly orders: readonly PostgrestCursorOrder[];
  readonly limit: number;
  readonly identityScope?: string;
}

export type PostgrestCursorErrorReason = "malformed" | "foreign" | "changed-query";

/**
 * A refused cursor. It extends `UnsupportedError` so callers that already guard
 * deliberate adapter refusals keep working. The message never contains row
 * values, headers, tokens or a transport error.
 */
export class PostgrestCursorError extends UnsupportedError {
  public readonly reason: PostgrestCursorErrorReason;

  public constructor(reason: PostgrestCursorErrorReason) {
    super(`PostgREST query cursor (${reason})`);
    this.reason = reason;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function cursorValue(value: unknown): PostgrestCursorValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0) || isUnsafeNativeNumber(value)) {
      throw new TypeError("PostgREST query cursor numbers must be finite, lossless and not -0");
    }
    return value;
  }
  throw new UnsupportedError("PostgREST query cursor values");
}

function scalar(value: PostgrestCursorValue): string {
  if (value === null) return "null";
  // Keyset terms live inside the `or=(...)` expression, a PostgREST list
  // context, so a string operand must be quoted and escaped there.
  if (typeof value === "string") return `"${value.replaceAll(/(["\\])/gu, "\\$1")}"`;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0) || isUnsafeNativeNumber(value)) {
      throw new TypeError("PostgREST query cursor numbers must be finite, lossless and not -0");
    }
    return String(value);
  }
  return String(value);
}

function equality(order: PostgrestCursorOrder, value: PostgrestCursorValue): string {
  const field = postgrestFieldKey(order.field);
  return value === null ? `${field}.is.null` : `${field}.eq.${scalar(value)}`;
}

function encodedTextLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new PostgrestCursorError("malformed");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  let binary: string;
  try {
    binary = atob(`${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`);
  } catch {
    throw new PostgrestCursorError("malformed");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PostgrestCursorError("malformed");
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBinding(left: PostgrestCursorBinding, right: PostgrestCursorBinding): boolean {
  return left.endpoint === right.endpoint
    && left.collection === right.collection
    && left.relation === right.relation
    && left.schema === right.schema
    && left.idColumn === right.idColumn
    && left.select === right.select
    && left.limit === right.limit
    && left.identityScope === right.identityScope
    && left.filters.length === right.filters.length
    && left.filters.every((filter, index) => {
      const other = right.filters[index];
      return other !== undefined && filter[0] === other[0] && filter[1] === other[1];
    })
    && left.orders.length === right.orders.length
    && left.orders.every((order, index) => {
      const other = right.orders[index];
      return other !== undefined && order.field === other.field && order.direction === other.direction;
    });
}

function parseOrders(value: unknown): readonly PostgrestCursorOrder[] {
  if (!Array.isArray(value) || value.length === 0) throw new PostgrestCursorError("malformed");
  return value.map((order): PostgrestCursorOrder => {
    if (!isPlainObject(order) || typeof order.field !== "string" || (order.direction !== "asc" && order.direction !== "desc")) {
      throw new PostgrestCursorError("malformed");
    }
    return { field: order.field, direction: order.direction };
  });
}

function parseFilters(value: unknown): readonly (readonly [string, string])[] {
  if (!Array.isArray(value)) throw new PostgrestCursorError("malformed");
  return value.map((filter): readonly [string, string] => {
    if (!Array.isArray(filter) || filter.length !== 2 || typeof filter[0] !== "string" || typeof filter[1] !== "string") {
      throw new PostgrestCursorError("malformed");
    }
    return [filter[0], filter[1]];
  });
}

function parseValues(value: unknown, expected: number): readonly PostgrestCursorValue[] {
  if (!Array.isArray(value) || value.length !== expected) throw new PostgrestCursorError("malformed");
  return value.map((item): PostgrestCursorValue => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0) && !isUnsafeNativeNumber(item)) return item;
    throw new PostgrestCursorError("malformed");
  });
}

/**
 * Encodes the next-page position as one opaque base64url token. The token is
 * integrity-checked by comparing its complete binding with the current query;
 * it is not a capability and must never be treated as an authorization token.
 */
export function encodePostgrestCursor(
  binding: PostgrestCursorBinding,
  page: number,
  values: readonly unknown[],
  maxBytes: number,
): string {
  if (!Number.isSafeInteger(page) || page < 2) throw new TypeError("PostgREST query cursor page must be at least 2");
  const encodedValues = values.map(cursorValue);
  if (encodedValues.length !== binding.orders.length) throw new TypeError("PostgREST query cursor value count does not match its order");
  const payload = {
    adapter: POSTGREST_CURSOR_ADAPTER,
    version: POSTGREST_CURSOR_VERSION,
    ...binding,
    page,
    values: encodedValues,
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  if (encodedTextLength(encoded) > maxBytes) throw new RangeError("PostgREST query cursor exceeds maxCursorBytes");
  return encoded;
}

export interface DecodedPostgrestCursor {
  readonly page: number;
  readonly values: readonly PostgrestCursorValue[];
}

/** Decodes a cursor and proves it belongs to the exact current query. */
export function decodePostgrestCursor(
  cursor: string,
  binding: PostgrestCursorBinding,
  maxBytes: number,
): DecodedPostgrestCursor {
  if (encodedTextLength(cursor) > maxBytes) throw new PostgrestCursorError("malformed");
  let value: unknown;
  try {
    value = parseLosslessJson(base64UrlDecode(cursor));
  } catch (error) {
    if (error instanceof PostgrestCursorError) throw error;
    throw new PostgrestCursorError("malformed");
  }
  if (!isPlainObject(value) || value.adapter !== POSTGREST_CURSOR_ADAPTER) throw new PostgrestCursorError("foreign");
  if (value.version !== POSTGREST_CURSOR_VERSION) throw new PostgrestCursorError("foreign");
  if (typeof value.endpoint !== "string"
    || typeof value.collection !== "string"
    || typeof value.relation !== "string"
    || (value.schema !== undefined && typeof value.schema !== "string")
    || typeof value.idColumn !== "string"
    || value.select !== "*"
    || !Number.isSafeInteger(value.limit)
    || (value.identityScope !== undefined && typeof value.identityScope !== "string")
    || !Number.isSafeInteger(value.page)
    || (value.page as number) < 2) {
    throw new PostgrestCursorError("malformed");
  }
  const parsedBinding: PostgrestCursorBinding = {
    endpoint: value.endpoint,
    collection: value.collection,
    relation: value.relation,
    ...(value.schema === undefined ? {} : { schema: value.schema }),
    idColumn: value.idColumn,
    select: "*",
    filters: parseFilters(value.filters),
    orders: parseOrders(value.orders),
    limit: value.limit as number,
    ...(value.identityScope === undefined ? {} : { identityScope: value.identityScope }),
  };
  if (!sameStrings([parsedBinding.relation], [binding.relation])
    || parsedBinding.collection !== binding.collection
    || parsedBinding.endpoint !== binding.endpoint) {
    throw new PostgrestCursorError("foreign");
  }
  if (!sameBinding(parsedBinding, binding)) throw new PostgrestCursorError("changed-query");
  return {
    page: value.page as number,
    values: parseValues(value.values, binding.orders.length),
  };
}

/**
 * Builds the PostgREST `or` expression for keyset continuation after one row.
 *
 * PostgREST/PostgreSQL defaults are used: `asc` sorts nulls last and `desc`
 * sorts nulls first. The caller must append the configured primary key as a
 * final non-null tie-breaker; this function relies on that final key to make a
 * continuation expressible even when a user order column is null.
 */
export function postgrestKeysetFilter(
  orders: readonly PostgrestCursorOrder[],
  values: readonly PostgrestCursorValue[],
): string {
  if (orders.length === 0 || values.length !== orders.length) {
    throw new PostgrestCursorError("malformed");
  }
  const terms: string[] = [];
  for (let index = 0; index < orders.length; index += 1) {
    const order = orders[index];
    const value = values[index];
    if (order === undefined || value === undefined) throw new PostgrestCursorError("malformed");
    const field = postgrestFieldKey(order.field);
    const prefix = orders.slice(0, index).map((item, prefixIndex) => {
      const prefixValue = values[prefixIndex];
      if (prefixValue === undefined) throw new PostgrestCursorError("malformed");
      return equality(item, prefixValue);
    });
    const nullsLast = order.direction === "asc";
    const after: string[] = [];
    if (value === null) {
      if (!nullsLast) after.push(`${field}.not.is.null`);
    } else {
      after.push(`${field}.${order.direction === "asc" ? "gt" : "lt"}.${scalar(value)}`);
      // The final order key is the non-null primary-key tie-breaker, so a
      // null branch would only add a term that can never match.
      if (nullsLast && index < orders.length - 1) after.push(`${field}.is.null`);
    }
    for (const condition of after) {
      const term = [...prefix, condition];
      terms.push(term.length === 1 ? condition : `and(${term.join(",")})`);
    }
  }
  if (terms.length === 0) throw new PostgrestCursorError("malformed");
  return `(${terms.join(",")})`;
}
