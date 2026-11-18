import type { OrdinalValue } from "@dalgo/adapter-runtime";
import { DuckDBError } from "./errors.js";
export interface ArrowValueType { readonly typeId: number; readonly scale?: number; readonly bitWidth?: number; readonly isSigned?: boolean; }
export type ArrowFieldMetadata = ReadonlyMap<string, string>;
function bool8(type: ArrowValueType, metadata?: ArrowFieldMetadata): boolean {
  const extension = metadata?.get("ARROW:extension:name");
  if (extension === undefined) return false;
  if (extension !== "arrow.bool8" || type.typeId !== 2 || type.bitWidth !== 8 || type.isSigned !== true
    || ![undefined, ""].includes(metadata?.get("ARROW:extension:metadata"))) throw new DuckDBError("unsupported");
  return true;
}
/** Preserve the logical extension rather than advertising its Int8 storage. */
export function arrowNativeType(type: ArrowValueType & { toString(): string }, metadata?: ArrowFieldMetadata): string {
  return bool8(type, metadata) ? `arrow.bool8<${type.toString()}>` : type.toString();
}
/** Exact Arrow scalar decoding. Temporal/nested/binary types are refused for now. */
export function arrowValue(value: unknown, type: ArrowValueType, metadata?: ArrowFieldMetadata): OrdinalValue {
  if (bool8(type, metadata)) {
    if (value === null) return null;
    // Support the canonical 0/1 subset only; never reinterpret negative
    // integers, noncanonical storage or general JavaScript truthiness.
    if (value === 0) return false;
    if (value === 1) return true;
    throw new DuckDBError("unsupported");
  }
  if (value === null) return null;
  // Arrow type IDs: Int=2, Float=3, Utf8=5, Bool=6, Decimal=7, LargeUtf8=20.
  if (type.typeId === 2 && type.bitWidth === 64 && typeof value === "bigint") return { kind: "integer", value: String(value) };
  if ((type.typeId === 2 || type.typeId === 3) && typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new DuckDBError("unsupported");
    return value;
  }
  if ((type.typeId === 5 || type.typeId === 20) && typeof value === "string") return value;
  if (type.typeId === 6 && typeof value === "boolean") return value;
  if (type.typeId === 7 && value instanceof Uint32Array && value.length === 4 && Number.isSafeInteger(type.scale)) {
    let integer = 0n;
    for (let i = 3; i >= 0; i--) integer = (integer << 32n) | BigInt(value[i] ?? 0);
    if (((value[3] ?? 0) & 0x80000000) !== 0) integer -= 1n << 128n;
    return { kind: "decimal", unscaled: String(integer), scale: type.scale ?? 0 };
  }
  throw new DuckDBError("unsupported");
}
