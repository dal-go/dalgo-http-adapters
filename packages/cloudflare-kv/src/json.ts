import { CloudflareKvError, type KvJson } from "./types.js";
import { utf8 } from "./validation.js";

/** Bounded, duplicate-field and malformed-Unicode rejecting JSON parser. */
export function parseJson(text: string, check: () => void): KvJson {
  let offset = 0; let nodes = 0;
  const whitespace = (): void => { while (/[\x20\n\r\t]/u.test(text[offset] ?? "x")) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === "\\") { offset++; continue; }
      if (character === '"') {
        try { const value: unknown = JSON.parse(text.slice(start, offset)); return utf8(value, 1_048_576, true); }
        catch { throw new CloudflareKvError("protocol"); }
      }
    }
    throw new CloudflareKvError("protocol");
  };
  const read = (depth: number): KvJson => {
    check(); whitespace();
    if (depth > 32 || ++nodes > 65_536) throw new CloudflareKvError("bounds");
    if (text[offset] === '"') return string();
    if (text[offset] === "{") {
      offset++; whitespace(); const result = Object.create(null) as Record<string, KvJson>;
      if (text[offset] === "}") { offset++; return result; }
      for (;;) {
        check(); if (text[offset] !== '"') throw new CloudflareKvError("protocol");
        const name = string(); if (Object.hasOwn(result, name) || ++nodes > 65_536) throw new CloudflareKvError("protocol");
        whitespace(); if (text[offset++] !== ":") throw new CloudflareKvError("protocol");
        result[name] = read(depth + 1); whitespace();
        const next = text[offset++]; if (next === "}") return result;
        if (next !== ",") throw new CloudflareKvError("protocol"); whitespace();
      }
    }
    if (text[offset] === "[") {
      offset++; whitespace(); const result: KvJson[] = [];
      if (text[offset] === "]") { offset++; return result; }
      for (;;) {
        result.push(read(depth + 1)); whitespace(); const next = text[offset++];
        if (next === "]") return result;
        if (next !== ",") throw new CloudflareKvError("protocol"); whitespace();
      }
    }
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return value; }
    }
    const start = offset;
    while (offset < text.length && /[0-9.eE+-]/u.test(text[offset] ?? "")) { if (++offset - start > 128) throw new CloudflareKvError("protocol"); }
    const token = text.slice(start, offset);
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(token)) throw new CloudflareKvError("protocol");
    const number = Number(token);
    if (!Number.isFinite(number)) throw new CloudflareKvError("protocol");
    return number;
  };
  const value = read(0); whitespace(); if (offset !== text.length) throw new CloudflareKvError("protocol"); return value;
}
