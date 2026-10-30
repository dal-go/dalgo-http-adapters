import type { OrdinalQueryResult, OrdinalValue } from "@dalgo/adapter-runtime";
import { ClickHouseNativeError } from "./native-errors.js";

type Decoder = (reader: Reader, depth: number) => OrdinalValue;
export interface BinaryLimits { readonly maxRows: number; readonly maxColumns: number; readonly maxValues: number; readonly maxDepth: number; }
const malformed = (): ClickHouseNativeError => new ClickHouseNativeError("response");
const unsupported = (): ClickHouseNativeError => new ClickHouseNativeError("unsupported");

class Reader {
  public offset = 0;
  public values = 0;
  readonly #view: DataView;
  public constructor(public readonly bytes: Uint8Array, public readonly limits: BinaryLimits) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  public take(size: number): Uint8Array {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.bytes.length - this.offset) throw malformed();
    const value = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
  public byte(): number { const value = this.take(1)[0]; if (value === undefined) throw malformed(); return value; }
  public length(maximum: number): number {
    let result = 0n;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.byte();
      result |= BigInt(byte & 0x7f) << BigInt(index * 7);
      if (byte < 0x80) {
        if (result > BigInt(maximum)) throw new ClickHouseNativeError("bounds");
        return Number(result);
      }
    }
    throw malformed();
  }
  public text(): string {
    const bytes = this.take(this.length(this.bytes.length));
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw unsupported(); }
  }
  public integer(size: number, signed: boolean): string {
    const bytes = this.take(size);
    let value = 0n;
    for (let index = size - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index] ?? 0);
    if (signed && (bytes[size - 1] ?? 0) >= 128) value -= 1n << BigInt(size * 8);
    return value.toString();
  }
  public float(size: number): number {
    const offset = this.offset;
    this.take(size);
    const value = size === 4 ? this.#view.getFloat32(offset, true) : this.#view.getFloat64(offset, true);
    if (!Number.isFinite(value)) throw unsupported();
    return value;
  }
  public count(depth: number): void {
    this.values += 1;
    if (depth > this.limits.maxDepth || this.values > this.limits.maxValues) throw new ClickHouseNativeError("bounds");
  }
}

function splitArguments(value: string): readonly string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch === "'" && value[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth < 0) throw unsupported();
    if (ch === "," && depth === 0) { result.push(value.slice(start, index).trim()); start = index + 1; }
  }
  if (quoted || depth !== 0) throw unsupported();
  result.push(value.slice(start).trim());
  return result;
}

function timezone(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^'[A-Za-z0-9_+\-/]+'$/u.test(value)) throw unsupported();
  return value.slice(1, -1);
}

function decoder(type: string, maximumDepth: number, depth = 0): Decoder {
  if (depth > maximumDepth || type.length > 4096) throw unsupported();
  let decode: Decoder;
  const integer = /^(U?Int)(8|16|32|64|128|256)$/u.exec(type);
  const compound = /^([A-Za-z0-9]+)\((.*)\)$/u.exec(type);
  if (integer !== null) {
    const size = Number(integer[2]) / 8;
    decode = (reader) => ({ kind: "integer", value: reader.integer(size, integer[1] === "Int") });
  } else if (type === "String") decode = (reader) => reader.text();
  else if (type === "Bool") decode = (reader) => { const value = reader.byte(); if (value > 1) throw malformed(); return value === 1; };
  else if (type === "Float32" || type === "Float64") decode = (reader) => reader.float(type === "Float32" ? 4 : 8);
  else if (type === "Date" || type === "Date32") decode = (reader) => ({ kind: "date", daysSinceEpoch: reader.integer(type === "Date" ? 2 : 4, type === "Date32") });
  else if (type === "DateTime") decode = (reader) => ({ kind: "datetime", ticksSinceEpoch: reader.integer(4, false), scale: 0 });
  else if (compound !== null) {
    const name = compound[1];
    const args = splitArguments(compound[2] ?? "");
    const first = args[0] ?? "";
    if ((name === "Nullable" || name === "LowCardinality" || name === "Array") && args.length === 1) {
      const child = decoder(first, maximumDepth, depth + 1);
      if (name === "LowCardinality") decode = (reader, level) => child(reader, level + 1);
      else if (name === "Nullable") decode = (reader, level) => { const flag = reader.byte(); if (flag > 1) throw malformed(); return flag === 1 ? null : child(reader, level + 1); };
      else decode = (reader, level) => {
        const count = reader.length(reader.limits.maxValues - reader.values);
        return { kind: "array", values: Array.from({ length: count }, () => child(reader, level + 1)) };
      };
    } else if (name === "Map" && args.length === 2) {
      const key = decoder(first, maximumDepth, depth + 1);
      const value = decoder(args[1] ?? "", maximumDepth, depth + 1);
      decode = (reader, level) => {
        const count = reader.length(Math.floor((reader.limits.maxValues - reader.values) / 2));
        return { kind: "map", entries: Array.from({ length: count }, () => [key(reader, level + 1), value(reader, level + 1)] as const) };
      };
    } else if ((name === "Decimal" || /^Decimal(?:32|64|128|256)$/u.test(name ?? "")) && args.every((arg) => /^\d+$/u.test(arg))) {
      const precision = name === "Decimal" ? Number(first) : ({ Decimal32: 9, Decimal64: 18, Decimal128: 38, Decimal256: 76 } as Record<string, number>)[name ?? ""] ?? 0;
      const scale = Number(name === "Decimal" ? args[1] : first);
      if ((name === "Decimal" ? args.length !== 2 : args.length !== 1) || precision < 1 || precision > 76 || !Number.isInteger(scale) || scale < 0 || scale > precision) throw unsupported();
      const size = precision <= 9 ? 4 : precision <= 18 ? 8 : precision <= 38 ? 16 : 32;
      decode = (reader) => ({ kind: "decimal", unscaled: reader.integer(size, true), scale });
    } else if (name === "DateTime64" && (args.length === 1 || args.length === 2) && /^[0-9]$/u.test(first)) {
      const scale = Number(first);
      const zone = timezone(args[1]);
      decode = (reader) => ({ kind: "datetime", ticksSinceEpoch: reader.integer(8, true), scale, ...(zone === undefined ? {} : { timezone: zone }) });
    } else if (name === "DateTime" && args.length === 1) {
      const zone = timezone(first);
      decode = (reader) => ({ kind: "datetime", ticksSinceEpoch: reader.integer(4, false), scale: 0, ...(zone === undefined ? {} : { timezone: zone }) });
    } else throw unsupported();
  } else throw unsupported();
  return (reader, level) => { reader.count(level); return decode(reader, level); };
}

/** Fully validates the header even for zero rows. All failures discard the entire result. */
export function decodeClickHouseRowBinary(bytes: Uint8Array, limits: BinaryLimits, signal?: AbortSignal): OrdinalQueryResult {
  const reader = new Reader(bytes, limits);
  const count = reader.length(limits.maxColumns);
  if (count === 0) throw malformed();
  const names = Array.from({ length: count }, () => reader.text());
  const types = Array.from({ length: count }, () => reader.text());
  const columns = names.map((name, index) => ({ name, nativeType: types[index] ?? "" }));
  const decoders = types.map((type) => decoder(type, limits.maxDepth));
  const rows: OrdinalValue[][] = [];
  while (reader.offset < bytes.length) {
    if (signal?.aborted === true) throw new ClickHouseNativeError("response");
    if (rows.length >= limits.maxRows) throw new ClickHouseNativeError("bounds");
    rows.push(decoders.map((decode) => decode(reader, 0)));
  }
  return { columns, rows };
}
