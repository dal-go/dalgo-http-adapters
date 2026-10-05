/** Stable sanitized failures never retain provider bodies or query values. */
export type AnalyticalErrorCode = "invalid_input" | "malformed_wire" | "response_limit" | "unsupported_type" | "unsupported_value" | "local_stopped";

export class AnalyticalError extends Error {
  public constructor(public readonly code: AnalyticalErrorCode) {
    super(code);
    this.name = "AnalyticalError";
  }
}

export function fail(code: AnalyticalErrorCode): never {
  throw new AnalyticalError(code);
}

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_DEPTH = 32;

/** A JSON number token, preserved before any floating-point conversion. */
export class JsonNumber {
  public constructor(public readonly text: string) { Object.freeze(this); }
}

export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | { [key: string]: JsonValue };

export function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof JsonNumber);
}

/** JS direct strings must contain Unicode scalar values before UTF-8 encoding. */
export function assertUnicodeScalar(value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) fail("malformed_wire");
    if (code >= 0xd800 && code <= 0xdbff) {
      i += 1;
      const low = value.charCodeAt(i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) fail("malformed_wire");
    }
  }
}

export function decodeUtf8(raw: Uint8Array): string {
  try {
    // Preserve BOM so JSON syntax rejects it; never silently strip input bytes.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch { return fail("malformed_wire"); }
}

/** Callers must cap decompressed reads before allocating the input buffer. */
export function parseJSON(raw: Uint8Array, limit: number): JsonValue {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_RESPONSE_BYTES || raw.byteLength > limit) fail("response_limit");
  const text = decodeUtf8(raw);
  let at = 0;
  const whitespace = (): void => { while (" \t\r\n".includes(text[at] ?? "\0")) at += 1; };
  const string = (): string => {
    const start = at;
    at += 1;
    while (at < text.length) {
      const character = text[at];
      at += 1;
      if (character === "\\") { at += 1; continue; }
      if (character === '"') {
        let result: string;
        try { result = JSON.parse(text.slice(start, at)) as string; } catch { return fail("malformed_wire"); }
        assertUnicodeScalar(result);
        return result;
      }
    }
    return fail("malformed_wire");
  };
  const value = (depth: number): JsonValue => {
    if (depth > MAX_DEPTH) fail("response_limit");
    whitespace();
    const character = text[at];
    if (character === '"') return string();
    if (character === "{" || character === "[") {
      at += 1;
      whitespace();
      const object = character === "{";
      const close = object ? "}" : "]";
      const result: JsonValue[] | { [key: string]: JsonValue } = object ? Object.create(null) as { [key: string]: JsonValue } : [];
      if (text[at] === close) { at += 1; return result; }
      while (true) {
        if (object) {
          if (text[at] !== '"') fail("malformed_wire");
          const key = string();
          if (Object.hasOwn(result, key)) fail("malformed_wire");
          whitespace();
          if (text[at] !== ":") fail("malformed_wire");
          at += 1;
          (result as { [key: string]: JsonValue })[key] = value(depth + 1);
        } else { (result as JsonValue[]).push(value(depth + 1)); }
        whitespace();
        if (text[at] === close) { at += 1; return result; }
        if (text[at] !== ",") fail("malformed_wire");
        at += 1;
        whitespace();
      }
    }
    for (const [literal, result] of [["null", null], ["true", true], ["false", false]] as const) {
      if (text.startsWith(literal, at)) { at += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(at));
    if (match === null) return fail("malformed_wire");
    at += match[0].length;
    return new JsonNumber(match[0]);
  };
  const result = value(0);
  whitespace();
  if (at !== text.length) fail("malformed_wire");
  return result;
}
