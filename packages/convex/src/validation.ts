import { convexToJson, jsonToConvex, type JSONValue, type Value } from "convex/values";
import { ConvexReadError } from "./types.js";

export function fail(code: ConstructorParameters<typeof ConvexReadError>[0]): never { throw new ConvexReadError(code); }
export function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
export function unicode(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("invalid-input");
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail("invalid-input");
  }
}
export function name(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(value) || value === "constructor" || value === "prototype") fail("invalid-input");
}
export function argumentName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value) || ["__proto__", "constructor", "prototype", "paginationOpts"].includes(value)) fail("invalid-input");
}
export function functionPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)*:[A-Za-z][A-Za-z0-9_]*$/u.test(value)) fail("invalid-input");
}
/** Closed, own data descriptors only; never invoke a getter or iterator. */
export function fields(value: unknown, allowed?: readonly string[], nativeData = false): Record<string, unknown> {
  if (!plain(value)) fail("invalid-input");
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1024) fail("limit");
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string" || key === "__proto__" || (!nativeData && (key === "constructor" || key === "prototype")) || (allowed !== undefined && !allowed.includes(key))) fail("invalid-input");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("invalid-input");
    out[key] = descriptor.value as unknown;
  }
  return out;
}
export function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) fail("limit");
  if (Reflect.ownKeys(value).length !== value.length + 1) fail("invalid-input");
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail("invalid-input");
    result.push(descriptor.value as unknown);
  }
  return result;
}
export function positive(value: unknown, fallback: number, maximum: number): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > maximum) fail("invalid-input");
  return n;
}

/** Bounded native-value copy before serialization/callbacks; no JSON coercion. */
export function copyValue(value: unknown, maximum: number, check: () => void): Value {
  let nodes = 0, bytes = 0;
  const count = (n: number): void => { bytes += n; if (bytes > maximum) fail("limit"); };
  const copy = (input: unknown, depth: number): Value => {
    check();
    if (++nodes > 50_000 || depth > 16) fail("limit");
    if (input === null || typeof input === "boolean") { count(4); return input; }
    if (typeof input === "number") { count(16); return input; }
    if (typeof input === "bigint") {
      if (input < -9223372036854775808n || input > 9223372036854775807n) fail("invalid-input");
      count(16); return input;
    }
    if (typeof input === "string") {
      if (input.length > maximum - bytes) fail("limit");
      unicode(input); count(new TextEncoder().encode(input).byteLength + 2); return input;
    }
    if (input instanceof ArrayBuffer && Object.getPrototypeOf(input) === ArrayBuffer.prototype) {
      if (Reflect.ownKeys(input).length !== 0) fail("invalid-input");
      count(input.byteLength); return input.slice(0);
    }
    if (Array.isArray(input)) return array(input, 8192).map(entry => copy(entry, depth + 1));
    const own = fields(input, undefined, true);
    const result: Record<string, Value> = Object.create(null) as Record<string, Value>;
    for (const key of Object.keys(own).sort()) {
      if (key.length < 1 || key.length > 1024 || !/^[ -~]+$/u.test(key) || key.startsWith("$")) fail("invalid-input");
      count(key.length + 3);
      result[key] = copy(own[key], depth + 1);
    }
    return result;
  };
  return copy(value, 0);
}
export function encoded(value: Value): JSONValue {
  try { return convexToJson(value); } catch { return fail("invalid-input"); }
}

/** Closed duplicate-refusing parser, adapted from this repo's analytical wire reader. */
export function parseJSON(raw: Uint8Array): JSONValue {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); } catch { return fail("protocol"); }
  let at = 0, nodes = 0;
  const whitespace = (): void => { while (" \t\r\n".includes(text[at] ?? "\0")) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === "\\") { at++; continue; }
      if (char === '"') {
        let result: unknown;
        try { result = JSON.parse(text.slice(start, at)); } catch { return fail("protocol"); }
        if (typeof result !== "string") fail("protocol");
        unicode(result); return result;
      }
    }
    return fail("protocol");
  };
  const value = (depth: number): JSONValue => {
    if (++nodes > 100_000 || depth > 20) fail("limit");
    whitespace();
    const char = text[at];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      at++; whitespace();
      const object = char === "{", close = object ? "}" : "]";
      const result: JSONValue[] | Record<string, JSONValue> = object ? Object.create(null) as Record<string, JSONValue> : [];
      let entries = 0;
      if (text[at] === close) { at++; return result; }
      for (;;) {
        if (++entries > (object ? 1024 : 8192)) fail("limit");
        if (object) {
          if (text[at] !== '"') fail("protocol");
          const key = string();
          if (Object.hasOwn(result, key) || key === "__proto__") fail("protocol");
          whitespace(); if (text[at++] !== ":") fail("protocol");
          (result as Record<string, JSONValue>)[key] = value(depth + 1);
        } else (result as JSONValue[]).push(value(depth + 1));
        whitespace();
        if (text[at] === close) { at++; return result; }
        if (text[at++] !== ",") fail("protocol");
        whitespace();
      }
    }
    for (const [literal, result] of [["null", null], ["true", true], ["false", false]] as const) {
      if (text.startsWith(literal, at)) { at += literal.length; return result; }
    }
    const start = at;
    while (at < text.length && "0123456789eE+-.".includes(text[at] ?? "\0")) at++;
    const token = text.slice(start, at);
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(token)) fail("protocol");
    const result = Number(token);
    if (!Number.isFinite(result) || Object.is(result, -0)) fail("protocol");
    return result;
  };
  const result = value(0); whitespace(); if (at !== text.length) fail("protocol");
  return result;
}

/** Validate special tags before the official codec, including canonical base64. */
export function decodeValue(value: JSONValue, maximum: number, check: () => void): Value {
  const validate = (v: JSONValue): void => {
    check();
    if (Array.isArray(v)) { for (const entry of v) validate(entry); return; }
    if (!plain(v)) return;
    const keys = Object.keys(v);
    if (keys.some(key => key.startsWith("$"))) {
      const key = keys[0];
      if (keys.length !== 1 || key === undefined || !["$integer", "$float", "$bytes"].includes(key)) fail("protocol");
      const text = v[key];
      if (typeof text !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(text)) fail("protocol");
      let decoded: string;
      try { decoded = atob(text); } catch { return fail("protocol"); }
      if (btoa(decoded) !== text || ((key === "$integer" || key === "$float") && decoded.length !== 8)) fail("protocol");
    } else for (const entry of Object.values(v)) validate(entry);
  };
  validate(value);
  let decoded: Value;
  try { decoded = jsonToConvex(value); } catch { return fail("protocol"); }
  return copyValue(decoded, maximum, check);
}
