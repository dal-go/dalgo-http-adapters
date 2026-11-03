import { UnsupportedError } from "@dalgo/core";
export type AthenaErrorCode = "configuration" | "input" | "bounds" | "protocol" | "transport" | "permission" | "busy" | "cursor" | "closed";
export class AthenaError extends Error {
  public constructor(public readonly code: AthenaErrorCode, public readonly status?: number) { super(`Athena read failed (${code})`); this.name = "AthenaError"; }
}
const owned = new WeakMap<object, { code: AthenaErrorCode; status?: number }>();
export function fail(code: AthenaErrorCode, status?: number): AthenaError {
  const error = new AthenaError(code, status); owned.set(error, { code, ...(status === undefined ? {} : { status }) }); return error;
}
export function safe(error: unknown): Error {
  if (error !== null && typeof error === "object") { const value = owned.get(error); if (value !== undefined) return fail(value.code, value.status); }
  return fail("transport");
}
export function unsupported(): UnsupportedError { return new UnsupportedError("Athena adapter query capability is not implemented"); }
