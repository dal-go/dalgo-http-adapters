import type { DynamoDbReadOperation } from "./read-operation.js";
import { NativeDynamoDbError, type NativeDynamoDbValue, type NativeDynamoDbItem, type NativeDynamoDbKey, type NativeDynamoDbKeyAttribute, type NativeDynamoDbKeyValue } from "./native-types.js";

const encoder = new TextEncoder();
export function invalid(): never { throw new NativeDynamoDbError("invalid-response"); }
export function requestError(): never { throw new NativeDynamoDbError("request"); }
export function objectEntries(value: unknown, maximum = 1000): [string, unknown][] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximum) throw new NativeDynamoDbError("limit");
  return keys.map((key) => {
    if (typeof key !== "string") return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return invalid();
    return [key, descriptor.value as unknown];
  });
}
export function objectMap(value: unknown, maximum = 1000): Record<string, unknown> { return Object.fromEntries(objectEntries(value, maximum)); }
export function ordinaryArray(value: unknown, maximum = 1000): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return invalid();
  if (Reflect.ownKeys(value).length !== value.length + 1) return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return invalid();
    result.push(descriptor.value as unknown);
  }
  return result;
}
export function text(value: unknown, maximum = 65_535, nonempty = false): string {
  if (typeof value !== "string" || value.length > maximum || (nonempty && value.length === 0)) return invalid();
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff) return invalid();
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return invalid();
    }
  }
  if (encoder.encode(value).byteLength > maximum) return invalid();
  return value;
}
interface Decimal { readonly coefficient: bigint; readonly scale: number; }
function decimal(value: string): Decimal {
  if (value.length > 128) return invalid();
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u.exec(value);
  if (match === null) return invalid();
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 4096) return invalid();
  let digits = ((match[2] ?? "") + fraction).replace(/^0+/u, "");
  if (digits.length === 0) return { coefficient: 0n, scale: 0 };
  let scale = exponent - fraction.length;
  const trimmed = digits.replace(/0+$/u, "");
  scale += digits.length - trimmed.length; digits = trimmed;
  const order = digits.length + scale - 1;
  if (digits.length > 38 || order < -130 || order > 125) return invalid();
  return { coefficient: BigInt((match[1] === "-" ? "-" : "") + digits), scale };
}
export function numberIdentity(value: string): string { const d = decimal(value); return `${d.coefficient.toString()}e${String(d.scale)}`; }
function bytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) return invalid();
  // The shared accountant has already checked canonical binary prototypes,
  // backing storage and absence of shadowed accessors before this copy.
  const result = new Uint8Array(value.byteLength); result.set(value); return result;
}
function binaryIdentity(value: Uint8Array): string { let result = ""; for (const byte of value) result += byte.toString(16).padStart(2, "0"); return result; }
function distinct<T>(values: T[], identity: (value: T) => string): T[] {
  if (values.length === 0) return invalid();
  const seen = new Set<string>();
  for (const value of values) { const key = identity(value); if (seen.has(key)) return invalid(); seen.add(key); }
  return values;
}
function cloneValue(value: unknown, depth: number): NativeDynamoDbValue {
  if (depth > 32) throw new NativeDynamoDbError("limit");
  const entries = objectEntries(value, 1); const entry = entries[0];
  if (entries.length !== 1 || entry === undefined) return invalid();
  const [tag, raw] = entry;
  switch (tag) {
    case "S": return { S: text(raw, 4_000_000) };
    case "N": { const n = text(raw, 128); decimal(n); return { N: n }; }
    case "B": return { B: bytes(raw) };
    case "BOOL": if (typeof raw === "boolean") return { BOOL: raw }; return invalid();
    case "NULL": if (raw === true) return { NULL: true }; return invalid();
    case "SS": return { SS: distinct(ordinaryArray(raw, 100_000).map((v) => text(v, 4_000_000)), (v) => v) };
    case "NS": return { NS: distinct(ordinaryArray(raw, 100_000).map((v) => text(v, 128)), numberIdentity) };
    case "BS": return { BS: distinct(ordinaryArray(raw, 100_000).map(bytes), binaryIdentity) };
    case "L": return { L: ordinaryArray(raw, 100_000).map((v) => cloneValue(v, depth + 1)) };
    case "M": return { M: Object.fromEntries(objectEntries(raw).map(([name, v]) => [text(name, 65_535, true), cloneValue(v, depth + 1)])) };
    default: return invalid();
  }
}
export function cloneItem(op: DynamoDbReadOperation, value: unknown): NativeDynamoDbItem {
  op.account(value);
  const result = Object.fromEntries(objectEntries(value).map(([name, raw]) => [text(name, 65_535, true), cloneValue(raw, 0)]));
  op.check(); return result;
}
export function keyValue(op: DynamoDbReadOperation, value: unknown, attribute: NativeDynamoDbKeyAttribute, partition: boolean): NativeDynamoDbKeyValue {
  op.account(value);
  const cloned = cloneValue(value, 0);
  if (!(attribute.type in cloned)) return invalid();
  if ("S" in cloned) { text(cloned.S, partition ? 2048 : 1024, true); return cloned; }
  if ("N" in cloned) return cloned;
  if ("B" in cloned && cloned.B.byteLength > 0 && cloned.B.byteLength <= (partition ? 2048 : 1024)) return cloned;
  return invalid();
}
export function cloneKey(op: DynamoDbReadOperation, value: unknown, attributes: readonly NativeDynamoDbKeyAttribute[], partitionNames: ReadonlySet<string> = new Set([attributes[0]?.name ?? ""])): NativeDynamoDbKey {
  const entries = objectEntries(value, 4);
  if (entries.length !== attributes.length) return invalid();
  const values = Object.fromEntries(entries);
  return Object.fromEntries(attributes.map((attribute) => [attribute.name, keyValue(op, values[attribute.name], attribute, partitionNames.has(attribute.name))]));
}
export function identity(value: NativeDynamoDbKeyValue): string {
  if ("S" in value) return "S" + JSON.stringify(value.S);
  if ("N" in value) return "N" + numberIdentity(value.N);
  return "B" + binaryIdentity(value.B);
}
export function keyIdentity(key: NativeDynamoDbKey): string { return JSON.stringify(Object.keys(key).sort().map((name) => [name, identity(key[name] ?? invalid())])); }
export function compare(left: NativeDynamoDbKeyValue, right: NativeDynamoDbKeyValue): number {
  if ("N" in left && "N" in right) {
    const a = decimal(left.N); const b = decimal(right.N); const scale = Math.min(a.scale, b.scale);
    const x = a.coefficient * 10n ** BigInt(a.scale - scale); const y = b.coefficient * 10n ** BigInt(b.scale - scale);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const a = "S" in left ? encoder.encode(left.S) : "B" in left ? left.B : invalid();
  const b = "S" in right && "S" in left ? encoder.encode(right.S) : "B" in right && "B" in left ? right.B : invalid();
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) { const difference = (a[i] ?? 0) - (b[i] ?? 0); if (difference !== 0) return difference; }
  return a.length - b.length;
}
