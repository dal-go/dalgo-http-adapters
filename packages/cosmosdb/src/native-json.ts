import { NativeCosmosError } from "./native-types.js";

const numberText = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
const numbers = new WeakMap<NativeCosmosJsonNumber, string>();

/** Exact JSON numeric lexeme. No implicit JS-number or JSON-number coercion. */
export class NativeCosmosJsonNumber {
  public readonly lexeme: string;
  public constructor(lexeme: string) {
    if (typeof lexeme !== "string" || lexeme.length > 128 || !numberText.test(lexeme)) throw new NativeCosmosError("input");
    this.lexeme = lexeme;
    numbers.set(this, lexeme);
    Object.freeze(this);
  }
  public toString(): string { return this.lexeme; }
}
export function nativeCosmosNumber(lexeme: string): NativeCosmosJsonNumber { return new NativeCosmosJsonNumber(lexeme); }
export type NativeCosmosJson = null | boolean | string | NativeCosmosJsonNumber | readonly NativeCosmosJson[] | NativeCosmosJsonObject;
export interface NativeCosmosJsonObject { readonly [key: string]: NativeCosmosJson }

/** UTF-8 size of a valid Unicode string, including its JSON quotes/escapes. */
function stringSize(text: string): number {
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) bytes += 2;
    else if (c < 32) bytes += 6;
    else if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new NativeCosmosError("input");
      bytes += 4;
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new NativeCosmosError("input");
    else bytes += 3;
  }
  return bytes;
}

/** Closed input walk. Charge every wire occurrence BEFORE allocating encoding. */
export function encodeNativeCosmosJson(input: unknown, maximum = 1_048_576, check: () => void = () => undefined): string {
  let bytes = 0; let nodes = 0;
  const ancestors = new Set<object>();
  const parts: string[] = [];
  const charge = (amount: number): void => { bytes += amount; if (bytes > maximum) throw new NativeCosmosError("bounds"); };
  const emit = (value: string): void => { charge(value.length); parts.push(value); };
  const string = (value: string): void => {
    const size = stringSize(value);
    if (size > 1_048_576) throw new NativeCosmosError("bounds");
    charge(size); parts.push(JSON.stringify(value));
  };
  const walk = (value: unknown, depth: number): void => {
    check(); if (++nodes > 65_536 || depth > 32) throw new NativeCosmosError("bounds");
    if (value === null) { emit("null"); return; }
    if (typeof value === "boolean") { emit(value ? "true" : "false"); return; }
    if (typeof value === "string") { string(value); return; }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw new NativeCosmosError("input");
      emit(Object.is(value, -0) ? "-0" : String(value)); return;
    }
    if (typeof value !== "object") throw new NativeCosmosError("input");
    const numeric = value instanceof NativeCosmosJsonNumber ? numbers.get(value) : undefined;
    if (numeric !== undefined) { emit(numeric); return; }
    if (ancestors.has(value)) throw new NativeCosmosError("input");
    const prototype: unknown = Object.getPrototypeOf(value);
    const array = Array.isArray(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new NativeCosmosError("input");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== "string")) throw new NativeCosmosError("input");
    ancestors.add(value);
    if (array) {
      const length: unknown = descriptors.length?.value;
      if (typeof length !== "number" || length > 65_536 || keys.length !== length + 1) throw new NativeCosmosError("input");
      emit("[");
      for (let i = 0; i < length; i++) {
        const descriptor = descriptors[String(i)];
        if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new NativeCosmosError("input");
        if (i !== 0) emit(",");
        const entry: unknown = descriptor.value; walk(entry, depth + 1);
      }
      emit("]");
    } else {
      emit("{"); let first = true;
      for (const name of Object.keys(descriptors)) {
        const descriptor = descriptors[name];
        if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new NativeCosmosError("input");
        if (!first) emit(","); first = false; string(name); emit(":");
        const entry: unknown = descriptor.value; walk(entry, depth + 1);
      }
      emit("}");
    }
    ancestors.delete(value); check();
  };
  walk(input, 0); check();
  return parts.join("");
}

/** One bounded JSON value; all numbers retain their exact native lexeme. */
export function decodeNativeCosmosJson(text: string, check: () => void = () => undefined): NativeCosmosJson {
  let at = 0; let nodes = 0;
  const bad = (): never => { throw new NativeCosmosError("protocol"); };
  const whitespace = (): void => { while (at < text.length && " \n\r\t".includes(text[at] ?? "!")) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === "\\") { at++; continue; }
      if (c === '"') {
        let value: unknown;
        try { value = JSON.parse(text.slice(start, at)); } catch { return bad(); }
        if (typeof value !== "string") return bad();
        try { if (stringSize(value) > 1_048_576) throw new NativeCosmosError("bounds"); } catch { return bad(); }
        return value;
      }
    }
    return bad();
  };
  const value = (depth: number): NativeCosmosJson => {
    check(); whitespace(); if (++nodes > 65_536 || depth > 32) return bad();
    const c = text[at];
    if (c === '"') return string();
    if (c === "[") {
      at++; whitespace(); const result: NativeCosmosJson[] = [];
      if (text[at] === "]") { at++; return result; }
      for (;;) {
        result.push(value(depth + 1)); whitespace();
        if (text[at] === "]") { at++; return result; }
        if (text[at++] !== ",") return bad();
      }
    }
    if (c === "{") {
      at++; whitespace(); const result: Record<string, NativeCosmosJson> = Object.create(null) as Record<string, NativeCosmosJson>;
      if (text[at] === "}") { at++; return result; }
      for (;;) {
        whitespace(); if (text[at] !== '"') return bad(); const name = string();
        if (Object.hasOwn(result, name)) return bad(); whitespace(); if (text[at++] !== ":") return bad();
        result[name] = value(depth + 1); whitespace();
        if (text[at] === "}") { at++; return result; }
        if (text[at++] !== ",") return bad();
      }
    }
    for (const [literal, result] of [["null", null], ["true", true], ["false", false]] as const) {
      if (text.startsWith(literal, at)) { at += literal.length; return result; }
    }
    const start = at;
    while (at < text.length && "-+0123456789.eE".includes(text[at] ?? "!")) { at++; if (at - start > 128) return bad(); }
    const numeric = text.slice(start, at);
    if (!numberText.test(numeric)) return bad();
    return nativeCosmosNumber(numeric);
  };
  const result = value(0); whitespace(); if (at !== text.length) return bad(); check(); return result;
}
