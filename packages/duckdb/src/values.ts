import type { OrdinalValue } from "@dalgo/adapter-runtime";
import { DuckDBError } from "./errors.js";
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object"; }
/** No lossy fallback/coercion: unsupported native types are capability failures. */
export function nodeValue(value: unknown, nativeType: string): OrdinalValue {
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return { kind: "integer", value: String(value) };
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new DuckDBError("unsupported");
    return value;
  }
  if (object(value)) {
    if (nativeType.startsWith("DECIMAL(") && typeof value.value === "bigint" && typeof value.scale === "number") return { kind: "decimal", unscaled: String(value.value), scale: value.scale };
    if (nativeType === "DATE" && typeof value.days === "number" && Number.isSafeInteger(value.days) && Math.abs(value.days) < 2_147_483_647) return { kind: "date", daysSinceEpoch: String(value.days) };
    const fieldAndScale = nativeType === "TIMESTAMP_S" ? ["seconds", 0] as const
      : nativeType === "TIMESTAMP_MS" ? ["millis", 3] as const
      : nativeType === "TIMESTAMP_NS" ? ["nanos", 9] as const
      : nativeType === "TIMESTAMP" || nativeType === "TIMESTAMP WITH TIME ZONE" ? ["micros", 6] as const : undefined;
    if (fieldAndScale !== undefined) {
      const ticks = value[fieldAndScale[0]];
      if (typeof ticks === "bigint" && ticks > -((1n << 63n) - 1n) && ticks < (1n << 63n) - 1n) return { kind: "datetime", ticksSinceEpoch: String(ticks), scale: fieldAndScale[1], ...(nativeType === "TIMESTAMP WITH TIME ZONE" ? { timezone: "UTC" } : {}) };
    }
  }
  throw new DuckDBError("unsupported");
}
