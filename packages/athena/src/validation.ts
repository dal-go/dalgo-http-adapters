import { fail } from "./errors.js";
import { encode, object } from "./json.js";
import type { Operation } from "./operation.js";
export function text(value: unknown, maximum = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) throw fail("input");
  for (let i = 0; i < value.length; i++) { const c = value.charCodeAt(i); if (c >= 0xd800 && c <= 0xdbff) { const n = value.charCodeAt(++i); if (!(n >= 0xdc00 && n <= 0xdfff)) throw fail("input"); } else if (c >= 0xdc00 && c <= 0xdfff) throw fail("input"); }
  return value;
}
export function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") throw fail("input");
  const d = Object.getOwnPropertyDescriptor(value, key); if (d === undefined) return undefined;
  if (!Object.hasOwn(d, "value") || !d.enumerable) throw fail("input"); return d.value as unknown;
}
export function only(value: unknown, names: readonly string[]): Record<string, unknown> {
  const record = object(value); const p: unknown = Object.getPrototypeOf(record);
  if (p !== Object.prototype && p !== null) throw fail("input");
  for (const key of Reflect.ownKeys(record)) { if (typeof key !== "string" || !names.includes(key)) throw fail("input"); field(record, key); }
  return record;
}
export function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) throw fail("input");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw fail("input");
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) { const d = descriptors[String(i)]; if (d === undefined || !Object.hasOwn(d, "value") || !d.enumerable) throw fail("input"); result.push(d.value as unknown); } return result;
}
export function snapshot(value: unknown, op: Operation): unknown { return JSON.parse(encode(value, op.limits.maxRequestBytes, op)) as unknown; }
export async function hash(value: string, op: Operation): Promise<string> {
  const digest = await op.io(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}
export function opaque(): string { return crypto.randomUUID() + crypto.randomUUID(); }
