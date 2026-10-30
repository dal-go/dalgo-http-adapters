import type { OrdinalParameter, OrdinalValue } from "@dalgo/adapter-runtime";
import { ClickHouseNativeError } from "./native-errors.js";

export function hasAsciiControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function nativeIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/u.test(value)) throw new ClickHouseNativeError("permission");
  return `\`${value}\``;
}

function escaped(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'").replace(/\0/gu, "\\0").replace(/\t/gu, "\\t").replace(/\n/gu, "\\n").replace(/\r/gu, "\\r");
}

function integerValue(value: OrdinalValue, signed: boolean, bits: number): string {
  const text = typeof value === "object" && value !== null && value.kind === "integer" ? value.value
    : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(text) || text === "-0" || text.length > 80) throw new ClickHouseNativeError("unsupported");
  const number = BigInt(text);
  const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const maximum = (1n << BigInt(signed ? bits - 1 : bits)) - 1n;
  if (number < minimum || number > maximum) throw new ClickHouseNativeError("bounds");
  return text;
}

function decimalValue(value: OrdinalValue, precision: number, scale: number): string {
  if (typeof value !== "object" || value?.kind !== "decimal" || value.scale !== scale
    || !/^-?(?:0|[1-9][0-9]*)$/u.test(value.unscaled) || value.unscaled.length > 78) throw new ClickHouseNativeError("unsupported");
  const negative = value.unscaled.startsWith("-");
  const absolute = negative ? value.unscaled.slice(1) : value.unscaled;
  if (absolute.length > precision || value.unscaled === "-0") throw new ClickHouseNativeError("bounds");
  if (scale === 0) return value.unscaled;
  const padded = absolute.padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

/** Provider serialization only: no interpolation into SQL and no SQL rewriting. */
function parameterValue(type: string, value: OrdinalValue, budget: { bytes: number; values: number }, nested = false, depth = 0): string {
  budget.values -= 1;
  if (budget.values < 0) throw new ClickHouseNativeError("bounds");
  if (depth > 16 || type.length > 4096) throw new ClickHouseNativeError("unsupported");
  const nullable = /^Nullable\((.*)\)$/u.exec(type);
  if (nullable !== null) return value === null ? spend(nested ? "NULL" : "\\N", budget) : parameterValue(nullable[1] ?? "", value, budget, nested, depth + 1);
  const array = /^Array\((.*)\)$/u.exec(type);
  if (array !== null) {
    if (typeof value !== "object" || value?.kind !== "array" || value.values.length > 100_000) throw new ClickHouseNativeError("unsupported");
    spend(" ".repeat(value.values.length + 2), budget);
    return `[${value.values.map((item) => parameterValue(array[1] ?? "", item, budget, true, depth + 1)).join(",")}]`;
  }
  if (type === "String" && typeof value === "string") {
    if (value.length > budget.bytes) throw new ClickHouseNativeError("bounds");
    return spend(nested ? `'${escaped(value)}'` : escaped(value), budget);
  }
  const integer = /^(U?Int)(8|16|32|64|128|256)$/u.exec(type);
  if (integer !== null) return spend(integerValue(value, integer[1] === "Int", Number(integer[2])), budget);
  if (type === "Bool" && typeof value === "boolean") return spend(value ? "1" : "0", budget);
  if ((type === "Float32" || type === "Float64") && typeof value === "number" && Number.isFinite(value)) return spend(Object.is(value, -0) ? "-0" : String(value), budget);
  const decimal = /^Decimal\(\s*([0-9]{1,2})\s*,\s*([0-9]{1,2})\s*\)$/u.exec(type);
  if (decimal !== null) {
    const precision = Number(decimal[1]);
    const scale = Number(decimal[2]);
    if (precision >= 1 && precision <= 76 && scale <= precision) return spend(decimalValue(value, precision, scale), budget);
  }
  // Explicit text bindings preserve local wall time and fractional seconds. The
  // server parses the declared timezone; never pass through JavaScript Date.
  if (/^(?:Date|Date32|DateTime(?:\('[A-Za-z0-9_+\-/]+'\))?|DateTime64\([0-9](?:,\s*'[A-Za-z0-9_+\-/]+')?\))$/u.test(type)
    && typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)?$/u.test(value)) {
    return spend(nested ? `'${value}'` : value, budget);
  }
  throw new ClickHouseNativeError("unsupported");
}

function spend(value: string, budget: { bytes: number }): string {
  budget.bytes -= new TextEncoder().encode(value).byteLength;
  if (budget.bytes < 0) throw new ClickHouseNativeError("bounds");
  return value;
}

/** Validate the complete type even for NULL or an empty array. */
function validParameterType(type: string, depth = 0): void {
  if (type.length > 4096 || depth > 16) throw new ClickHouseNativeError("unsupported");
  const wrapper = /^(?:Array|Nullable)\((.*)\)$/u.exec(type);
  if (wrapper !== null) { validParameterType(wrapper[1] ?? "", depth + 1); return; }
  if (/^(?:String|Bool|U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|Date|Date32|DateTime(?:\('[A-Za-z0-9_+\-/]+'\))?|DateTime64\([0-9](?:,\s*'[A-Za-z0-9_+\-/]+')?\))$/u.test(type)) return;
  const decimal = /^Decimal\(\s*([0-9]{1,2})\s*,\s*([0-9]{1,2})\s*\)$/u.exec(type);
  if (decimal !== null && Number(decimal[1]) >= 1 && Number(decimal[1]) <= 76 && Number(decimal[2]) <= Number(decimal[1])) return;
  throw new ClickHouseNativeError("unsupported");
}

export function nativeParameters(parameters: readonly OrdinalParameter[], maximumBytes = 1_048_576): readonly { readonly name: string; readonly value: string }[] {
  if (parameters.length > 256) throw new ClickHouseNativeError("bounds");
  const names = new Set<string>();
  const budget = { bytes: maximumBytes, values: 100_000 };
  return parameters.map((parameter) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(parameter.name) || names.has(parameter.name)) throw new ClickHouseNativeError("permission");
    names.add(parameter.name);
    validParameterType(parameter.nativeType);
    spend(parameter.name + parameter.nativeType, budget);
    return { name: parameter.name, value: parameterValue(parameter.nativeType, parameter.value, budget) };
  });
}
