import { UnsupportedError } from "@dalgo/core";

/** Public errors contain no URL, SQL, payload, token or foreign cause. */
export class SnowflakeError extends Error {
  public constructor(message: string, public readonly status?: number) {
    super(message); this.name = "SnowflakeError";
  }
}
const failures = new WeakMap<object, { message: string; status?: number; unsupported: boolean }>();
export function failure(message: string, status?: number): SnowflakeError {
  const error = new SnowflakeError(message, status);
  failures.set(error, { message, ...(status === undefined ? {} : { status }), unsupported: false }); return error;
}
export function unsupported(message: string): UnsupportedError {
  const error = new UnsupportedError(message); failures.set(error, { message, unsupported: true }); return error;
}
export function safeFailure(error: unknown): Error {
  if (typeof error === "object" && error !== null) {
    const known = failures.get(error);
    if (known !== undefined) return known.unsupported ? unsupported(known.message) : failure(known.message, known.status);
  }
  return failure("Snowflake operation failed");
}
