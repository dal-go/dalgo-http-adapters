import type { SqliteBindValue } from "../driver.js";
import type { CanonicalPin } from "./canonical.js";

/** A request from the leader tab to its dataset worker. */
export type WorkerRequest = { readonly id: number } & (
  | { readonly op: "open"; readonly pin: CanonicalPin }
  | { readonly op: "exec"; readonly sql: string; readonly binds?: readonly SqliteBindValue[] }
  | { readonly op: "reset" }
  | { readonly op: "close" }
);

/** An error crossing a structured-clone boundary, with the fields error mapping reads. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  /** sqlite-wasm's extended result code. */
  readonly resultCode?: number;
  readonly code?: string;
  readonly reason?: string;
  readonly retriable?: boolean;
}

export type WorkerResponse = { readonly id: number } & (
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: SerializedError }
);

export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const extra = error as { readonly resultCode?: unknown; readonly code?: unknown; readonly reason?: unknown; readonly retriable?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof extra.resultCode === "number" ? { resultCode: extra.resultCode } : {}),
    ...(typeof extra.code === "string" ? { code: extra.code } : {}),
    ...(typeof extra.reason === "string" ? { reason: extra.reason } : {}),
    ...(typeof extra.retriable === "boolean" ? { retriable: extra.retriable } : {}),
  };
}

/** Rebuilds an error so `mapSqliteError` and `retriable` checks work on this side. */
export function reviveError(serialized: SerializedError): Error {
  const error = new Error(serialized.message) as Error & Record<string, unknown>;
  error.name = serialized.name;
  if (serialized.resultCode !== undefined) error.resultCode = serialized.resultCode;
  if (serialized.code !== undefined) error.code = serialized.code;
  if (serialized.reason !== undefined) error.reason = serialized.reason;
  if (serialized.retriable !== undefined) error.retriable = serialized.retriable;
  return error;
}
