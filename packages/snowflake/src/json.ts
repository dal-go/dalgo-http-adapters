import { failure } from "./errors.js";
import type { Operation } from "./operation.js";

export function utf8(value: string): number { return new TextEncoder().encode(value).byteLength; }
function quotedSize(value: string): number {
  let size = 2;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) size += 2;
    else if (code < 32) size += 6;
    else if (code < 128) size++;
    else if (code < 2048) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw failure("Invalid Snowflake Unicode"); size += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw failure("Invalid Snowflake Unicode");
    else size += 3;
  }
  return size;
}
/** Descriptor-only input admission; every escaped occurrence is charged first. */
export function encode(value: unknown, maximum: number, op: Operation): string {
  let bytes = 0; let nodes = 0; const ancestors = new Set<object>(); const parts: string[] = [];
  const charge = (amount: number): void => { bytes += amount; if (bytes > maximum) throw failure("Snowflake request budget exceeded"); };
  const emit = (text: string): void => { charge(text.length); parts.push(text); };
  const string = (text: string): void => {
    if (text.length > maximum) throw failure("Snowflake request budget exceeded");
    charge(quotedSize(text)); parts.push(JSON.stringify(text));
  };
  const walk = (input: unknown, depth: number): void => {
    op.check(); if (++nodes > 65_536 || depth > 32) throw failure("Snowflake input work budget exceeded");
    if (input === null) { emit("null"); return; }
    if (typeof input === "boolean") { emit(input ? "true" : "false"); return; }
    if (typeof input === "string") { string(input); return; }
    if (typeof input === "number" && Number.isFinite(input) && (!Number.isInteger(input) || Number.isSafeInteger(input))) { emit(String(input)); return; }
    if (typeof input !== "object" || input === null || ancestors.has(input)) throw failure("Invalid Snowflake request value");
    const array = Array.isArray(input); const proto: unknown = Object.getPrototypeOf(input);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw failure("Invalid Snowflake request value");
    const descriptors = Object.getOwnPropertyDescriptors(input); const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 65_536 || keys.some(key => typeof key !== "string")) throw failure("Invalid Snowflake request value");
    ancestors.add(input);
    if (array) {
      const length: unknown = descriptors.length?.value;
      if (typeof length !== "number" || length > 65_536 || keys.length !== length + 1) throw failure("Invalid Snowflake request array");
      emit("[");
      for (let i = 0; i < length; i++) {
        const item = descriptors[String(i)];
        if (item === undefined || !Object.hasOwn(item, "value") || !item.enumerable) throw failure("Invalid Snowflake request array");
        if (i !== 0) emit(","); const entry: unknown = item.value; walk(entry, depth + 1);
      }
      emit("]");
    } else {
      emit("{"); let first = true;
      for (const name of Object.keys(descriptors)) {
        const item = descriptors[name];
        if (item === undefined || !Object.hasOwn(item, "value") || !item.enumerable) throw failure("Invalid Snowflake request object");
        if (!first) emit(","); first = false; string(name); emit(":"); const entry: unknown = item.value; walk(entry, depth + 1);
      }
      emit("}");
    }
    ancestors.delete(input); op.check();
  };
  walk(value, 0); op.check(); return parts.join("");
}
/** Bounded duplicate-aware JSON; SQL API v2 cells remain untouched strings/null. */
export function decode(text: string, op: Pick<Operation, "node" | "check">): unknown {
  let at = 0;
  const invalid = (): never => { throw failure("Invalid Snowflake JSON response"); };
  const space = (): void => { while (at < text.length && " \r\n\t".includes(text[at] ?? "!")) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const c = text[at++]; if (c === "\\") { at++; continue; }
      if (c === '"') {
        let result: unknown; try { result = JSON.parse(text.slice(start, at)); } catch { return invalid(); }
        if (typeof result !== "string") return invalid(); quotedSize(result); return result;
      }
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    op.node(); space(); if (depth > 32) return invalid(); const c = text[at];
    if (c === '"') return string();
    if (c === "[") {
      at++; space(); const result: unknown[] = []; if (text[at] === "]") { at++; return result; }
      for (;;) { result.push(value(depth + 1)); space(); if (text[at] === "]") { at++; return result; } if (text[at++] !== ",") return invalid(); }
    }
    if (c === "{") {
      at++; space(); const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (text[at] === "}") { at++; return result; }
      for (;;) {
        space(); if (text[at] !== '"') return invalid(); const name = string(); if (Object.hasOwn(result, name)) return invalid();
        space(); if (text[at++] !== ":") return invalid(); result[name] = value(depth + 1); space();
        if (text[at] === "}") { at++; return result; } if (text[at++] !== ",") return invalid();
      }
    }
    for (const [literal, parsed] of [["null", null], ["true", true], ["false", false]] as const) if (text.startsWith(literal, at)) { at += literal.length; return parsed; }
    const start = at; while (at < text.length && "-+0123456789.eE".includes(text[at] ?? "!")) { at++; if (at - start > 128) return invalid(); }
    const raw = text.slice(start, at); if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(raw)) return invalid();
    const result = Number(raw); if (!Number.isFinite(result) || Number.isInteger(result) && !Number.isSafeInteger(result)) return invalid(); return result;
  };
  const result = value(0); space(); if (at !== text.length) return invalid(); op.check(); return result;
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw failure("Invalid Snowflake response object");
  return value as Record<string, unknown>;
}
