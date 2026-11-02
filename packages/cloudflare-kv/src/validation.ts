import { CloudflareKvError, type KvJson, type KvOptions } from "./types.js";

export const encoder = new TextEncoder();
export function positive(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new CloudflareKvError("configuration");
  return result;
}
export function utf8(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || value.length > maximum) throw new CloudflareKvError("input");
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new CloudflareKvError("input");
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new CloudflareKvError("input");
  }
  if (encoder.encode(value).byteLength > maximum) throw new CloudflareKvError("bounds");
  return value;
}
export function nativeKey(value: unknown): string {
  const key = utf8(value, 512);
  if (key === "." || key === "..") throw new CloudflareKvError("input");
  return key;
}
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CloudflareKvError("protocol");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new CloudflareKvError("protocol");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const names = Reflect.ownKeys(value);
  if (names.length > 65_536) throw new CloudflareKvError("bounds");
  for (const name of names) {
    if (typeof name !== "string") throw new CloudflareKvError("protocol");
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new CloudflareKvError("protocol");
    result[name] = descriptor.value as unknown;
  }
  return result;
}
export function only(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = record(value);
  if (Object.keys(result).some((key) => !keys.includes(key))) throw new CloudflareKvError("input");
  return result;
}
export function copiedArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) throw new CloudflareKvError("bounds");
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (descriptor === undefined || !("value" in descriptor)) throw new CloudflareKvError("protocol");
    result.push(descriptor.value as unknown);
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) throw new CloudflareKvError("protocol");
  return result;
}
export function stringSize(value: string, maximum = 1_048_576, check: () => void = () => undefined): number {
  // Actual UTF8 plus JSON.stringify escaping, without invoking a payload hook.
  utf8(value, 1_048_576, true);
  let result = 2;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    result += code < 32 ? ("\b\f\n\r\t".includes(character) ? 2 : 6) : character === '"' || character === "\\" ? 2 : code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (result > maximum) throw new CloudflareKvError("bounds");
    check();
  }
  return result;
}
/** Closed JSON copy and per-occurrence escaped-byte admission before stringify. */
export function jsonCopy(value: unknown, maximum: number, check: () => void): { value: KvJson; bytes: number } {
  let bytes = 0;
  let nodes = 0;
  const charge = (amount: number): void => { check(); bytes += amount; if (bytes > maximum) throw new CloudflareKvError("bounds"); };
  const visit = (input: unknown, depth: number): KvJson => {
    check();
    if (++nodes > 65_536 || depth > 32) throw new CloudflareKvError("bounds");
    if (input === null) { charge(4); return null; }
    if (typeof input === "boolean") { charge(input ? 4 : 5); return input; }
    if (typeof input === "number") { if (!Number.isFinite(input)) throw new CloudflareKvError("protocol"); charge(JSON.stringify(input).length); return input; }
    if (typeof input === "string") { charge(stringSize(input, maximum - bytes, check)); return input; }
    if (Array.isArray(input)) {
      if (input.length > Math.min(65_536, maximum - bytes)) throw new CloudflareKvError("bounds");
      charge(2 + Math.max(0, input.length - 1));
      return copiedArray(input, 65_536).map((item) => visit(item, depth + 1));
    }
    const fields = record(input);
    const names = Object.keys(fields);
    charge(2 + Math.max(0, names.length - 1));
    const result = Object.create(null) as Record<string, KvJson>;
    for (const name of names) { charge(stringSize(name, maximum - bytes, check) + 1); result[name] = visit(fields[name], depth + 1); }
    return result;
  };
  return { value: visit(value, 0), bytes };
}
export function jsonWire(value: unknown, maximum: number, check: () => void): string {
  const copied = jsonCopy(value, maximum, check);
  const text = JSON.stringify(copied.value);
  if (encoder.encode(text).byteLength > maximum) throw new CloudflareKvError("bounds");
  check(); return text;
}
export function prefixes(options: KvOptions): readonly string[] {
  const values = copiedArray(options.allowedPrefixes, 32).map((value) => utf8(value, 512, true));
  if (values.length === 0 || new Set(values).size !== values.length || (values.includes("") && options.allowNamespaceAccess !== true)) throw new CloudflareKvError("configuration");
  return values;
}
export function permitted(value: string, allowed: readonly string[]): void {
  if (!allowed.some((prefix) => value.startsWith(prefix))) throw new CloudflareKvError("permission");
}
export function compareUtf8(a: string, b: string): number {
  const x = encoder.encode(a); const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) { const n = (x[i] ?? 0) - (y[i] ?? 0); if (n !== 0) return n; }
  return x.length - y.length;
}
export function keyInfo(value: unknown, check: () => void): { name: string; metadata?: KvJson; expiration?: number } {
  const item = only(value, ["name", "metadata", "expiration"]);
  const name = nativeKey(item.name);
  const expiration = item.expiration;
  if (expiration !== undefined && (typeof expiration !== "number" || !Number.isSafeInteger(expiration) || expiration < 0)) throw new CloudflareKvError("protocol");
  return { name, ...(expiration === undefined ? {} : { expiration }), ...(!Object.hasOwn(item, "metadata") ? {} : { metadata: jsonCopy(item.metadata, 1024, check).value }) };
}
export function base64(bytes: Uint8Array): string { let text = ""; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); }
export function unbase64(value: unknown, maximum: number): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new CloudflareKvError("protocol");
  const text = atob(value); const result = Uint8Array.from(text, (c) => c.charCodeAt(0));
  if (result.byteLength > maximum || base64(result) !== value) throw new CloudflareKvError("bounds");
  return result;
}
