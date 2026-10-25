import { assertUnicodeScalar, decodeUtf8, fail, isObject, MAX_RESPONSE_BYTES, parseJSON } from "./wire.js";

export interface AnalyticalField { readonly name?: string; readonly type: string; readonly mode?: string }
export interface AnalyticalCell { readonly type: string; readonly value: string | boolean | null }

const integer = /^-?(0|[1-9][0-9]*)$/u;
const decimal = /^-?[0-9]+(\.[0-9]+)?$/u;
const float = /^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/u;
const clock = /^([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,6})?$/u;
const supported = new Set("INT64 NUMERIC BIGNUMERIC FLOAT64 BOOL STRING BYTES DATE TIME DATETIME TIMESTAMP JSON".split(" "));
const encoder = new TextEncoder();

/** RegExp $ can match before a trailing newline in JS; require every code unit. */
function matches(expression: RegExp, value: string): boolean {
  const match = expression.exec(value);
  return match !== null && match[0].length === value.length;
}

function validDate(value: string): boolean {
  if (!matches(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u, value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}

function validClock(value: string): boolean {
  if (!matches(clock, value)) return false;
  return Number(value.slice(0, 2)) < 24 && Number(value.slice(3, 5)) < 60 && Number(value.slice(6, 8)) < 60;
}

function validBase64(value: string): boolean {
  if (!matches(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u, value)) return false;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (value.endsWith("==")) return (alphabet.indexOf(value.at(-3) ?? "") & 15) === 0;
  if (value.endsWith("=")) return (alphabet.indexOf(value.at(-2) ?? "") & 3) === 0;
  return true;
}

/** Preserve SQL NULL, exact decimal strings, JSON text and keyless row order.
 * TIMESTAMP values use signed epoch microseconds in the foundation contract.
 */
export function normalizeScalar(field: AnalyticalField, value: unknown): AnalyticalCell {
  if (typeof field.type !== "string") fail("invalid_input");
  let type = field.type.toUpperCase();
  type = ({ INTEGER: "INT64", FLOAT: "FLOAT64", BOOLEAN: "BOOL" } as Record<string, string>)[type] ?? type;
  if (!supported.has(type) || ![undefined, "", "NULLABLE", "REQUIRED"].includes(field.mode)) fail("unsupported_type");
  if (value === null) {
    if (field.mode === "REQUIRED") fail("malformed_wire");
    return { type, value: null };
  }
  if (typeof value !== "string") fail("malformed_wire");
  assertUnicodeScalar(value);
  if (encoder.encode(value).byteLength > 1024 * 1024) fail("response_limit");
  let normalized: string | boolean = value;
  switch (type) {
    case "INT64":
    case "TIMESTAMP": {
      if (!matches(integer, value)) fail("unsupported_value");
      const number = BigInt(value);
      if (number < -9223372036854775808n || number > 9223372036854775807n) fail("unsupported_value");
      if (type === "TIMESTAMP" && (number < -62135596800000000n || number > 253402300799999999n)) fail("unsupported_value");
      normalized = number.toString();
      break;
    }
    case "NUMERIC":
    case "BIGNUMERIC": {
      if (!matches(decimal, value)) fail("unsupported_value");
      const negative = value.startsWith("-");
      const parts = (negative ? value.slice(1) : value).split(".");
      const whole = (parts[0] ?? "").replace(/^0+/u, "") || "0";
      const fraction = parts[1] ?? "";
      const scale = fraction.length;
      if (scale > (type === "NUMERIC" ? 9 : 38) || (whole === "0" ? 0 : whole.length) > (type === "NUMERIC" ? 29 : 39)) fail("unsupported_value");
      if (type === "BIGNUMERIC") {
        const scaled = BigInt(whole + fraction) * 10n ** BigInt(38 - scale);
        if (scaled > (1n << 255n) - (negative ? 0n : 1n)) fail("unsupported_value");
      }
      const trimmed = fraction.replace(/0+$/u, "");
      normalized = whole + (trimmed === "" ? "" : `.${trimmed}`);
      if (negative && normalized !== "0") normalized = `-${normalized}`;
      break;
    }
    case "FLOAT64": {
      if (!matches(float, value)) fail("unsupported_value");
      const number = Number(value);
      if (!Number.isFinite(number)) fail("unsupported_value");
      normalized = number.toString(); // ECMAScript NumberToString includes -0 -> 0.
      break;
    }
    case "BOOL":
      if (value !== "true" && value !== "false") fail("unsupported_value");
      normalized = value === "true";
      break;
    case "BYTES":
      if (!validBase64(value)) fail("unsupported_value");
      break;
    case "DATE":
      if (!validDate(value)) fail("unsupported_value");
      break;
    case "TIME":
      if (!validClock(value)) fail("unsupported_value");
      break;
    case "DATETIME": {
      let parts = value.split("T");
      if (parts.length !== 2) parts = value.split(" ");
      if (parts.length !== 2 || !validDate(parts[0] ?? "") || !validClock(parts[1] ?? "")) fail("unsupported_value");
      normalized = `${parts[0]}T${parts[1]}`;
      break;
    }
    case "JSON":
      parseJSON(encoder.encode(value), 1024 * 1024);
      break;
  }
  return { type, value: normalized };
}

/** Fatal UTF-8 boundary for scalar bytes; never normalize replacement decoding. */
export function normalizeScalarBytes(field: AnalyticalField, raw: Uint8Array): AnalyticalCell {
  return normalizeScalar(field, decodeUtf8(raw));
}

/** Schema eligibility/precision metadata is a separate gate, not inferred here. */
export function decodeRows(raw: Uint8Array, fields: readonly AnalyticalField[], limit = MAX_RESPONSE_BYTES): readonly (readonly AnalyticalCell[])[] {
  if (fields.length < 1 || fields.length > 128) fail("invalid_input");
  const value = parseJSON(raw, limit);
  if (!Array.isArray(value)) fail("malformed_wire");
  if (value.length > 1000) fail("response_limit");
  return value.map((row) => {
    if (!isObject(row) || Object.keys(row).length !== 1 || !Array.isArray(row.f) || row.f.length !== fields.length) fail("malformed_wire");
    return row.f.map((cell, index) => {
      if (!isObject(cell) || Object.keys(cell).length !== 1 || !Object.hasOwn(cell, "v")) fail("malformed_wire");
      return normalizeScalar(fields[index] as AnalyticalField, cell.v);
    });
  });
}
