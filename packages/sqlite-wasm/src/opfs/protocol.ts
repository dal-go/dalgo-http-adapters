import type { SqliteBindValue } from "../driver.js";
import type { SqliteExportOptions } from "../export.js";
import { CanonicalFetchError, CanonicalIntegrityError, CorruptDatabaseError, DatasetStorageError, type CanonicalPin } from "./canonical.js";
import { DemoDbConfigError } from "./config-error.js";
import type { OpenOptions } from "./engine.js";
import { PoolUnavailableError, isPoolUnavailableReason } from "./pool.js";
import type { DemoDbProgressEvent } from "./progress.js";

/** A request from the leader tab to its dataset worker. `progress: true` asks for {@link WorkerProgress} messages. */
export type WorkerRequest = { readonly id: number } & (
  | { readonly op: "open"; readonly pin: CanonicalPin; readonly options?: OpenOptions; readonly progress?: boolean }
  | { readonly op: "exec"; readonly sql: string; readonly binds?: readonly SqliteBindValue[] }
  | { readonly op: "export"; readonly options?: SqliteExportOptions }
  | { readonly op: "reset"; readonly progress?: boolean }
  | { readonly op: "close" }
);

/** An error crossing a structured-clone boundary: its name, message and typed fields, never its stack. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  /** sqlite-wasm's extended result code. */
  readonly resultCode?: number;
  readonly code?: string;
  /** `PoolUnavailableError.reason`. */
  readonly reason?: string;
  readonly retriable?: boolean;
  /** `DatasetStorageError.operation`. */
  readonly operation?: string;
  /** `CanonicalFetchError.status`. */
  readonly status?: number;
  /** The `cause`'s name and message (one level). */
  readonly cause?: { readonly name: string; readonly message: string };
}

export type WorkerResponse = { readonly id: number } & (
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: SerializedError }
);

/** Progress of an `open` or `reset` request that asked for it; sent before its {@link WorkerResponse}. */
export interface WorkerProgress {
  readonly id: number;
  readonly progress: DemoDbProgressEvent;
}

/** Any message the dataset worker posts. */
export type WorkerMessage = WorkerResponse | WorkerProgress;

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const extra = error as {
    readonly resultCode?: unknown; readonly code?: unknown; readonly reason?: unknown; readonly retriable?: unknown;
    readonly operation?: unknown; readonly status?: unknown;
  };
  return {
    name: error.name,
    message: error.message,
    ...(typeof extra.resultCode === "number" ? { resultCode: extra.resultCode } : {}),
    ...(typeof extra.code === "string" ? { code: extra.code } : {}),
    ...(typeof extra.reason === "string" ? { reason: extra.reason } : {}),
    ...(typeof extra.retriable === "boolean" ? { retriable: extra.retriable } : {}),
    ...(typeof extra.operation === "string" ? { operation: extra.operation } : {}),
    ...(typeof extra.status === "number" ? { status: extra.status } : {}),
    ...(error.cause === undefined ? {} : { cause: { name: nameOf(error.cause), message: messageOf(error.cause) } }),
  };
}

type Reviver = (serialized: SerializedError, options: ErrorOptions | undefined) => Error | undefined;

/** The typed errors that are rebuilt as their own class on this side. */
const revivers = new Map<string, Reviver>([
  ["CanonicalFetchError", (s, options) => new CanonicalFetchError(s.message, s.status, options)],
  ["CanonicalIntegrityError", (s, options) => new CanonicalIntegrityError(s.message, options)],
  ["CorruptDatabaseError", (s, options) => new CorruptDatabaseError(s.message, options)],
  ["DatasetStorageError", (s, options) => (s.operation === "import" || s.operation === "open" ? new DatasetStorageError(s.operation, s.message, options) : undefined)],
  ["PoolUnavailableError", (s, options) => (isPoolUnavailableReason(s.reason) ? new PoolUnavailableError(s.reason, s.message, options) : undefined)],
  ["DemoDbConfigError", (s, options) => new DemoDbConfigError(s.message, options)],
  ["TypeError", (s, options) => new TypeError(s.message, options)],
]);

function causeOf(cause: { readonly name: string; readonly message: string }): Error {
  const error = new Error(cause.message);
  error.name = cause.name;
  return error;
}

/**
 * Rebuilds an error on this side of the boundary. The dataset errors
 * (`DatasetStorageError`, `PoolUnavailableError`, `CanonicalFetchError`,
 * `CanonicalIntegrityError`, `CorruptDatabaseError`, `DemoDbConfigError`)
 * and `TypeError` come back as instances of their class with their fields;
 * any other error is an `Error` with the serialized name and fields, so
 * `mapSqliteError` and `retriable` checks work. The cause, when there was
 * one, is an `Error` with its name and message.
 */
export function reviveError(serialized: SerializedError): Error {
  const options = serialized.cause === undefined ? undefined : { cause: causeOf(serialized.cause) };
  const typed = revivers.get(serialized.name)?.(serialized, options);
  const error = (typed ?? new Error(serialized.message, options)) as Error & Record<string, unknown>;
  if (typed !== undefined) {
    if (serialized.resultCode !== undefined) error.resultCode = serialized.resultCode;
    return error;
  }
  error.name = serialized.name;
  if (serialized.resultCode !== undefined) error.resultCode = serialized.resultCode;
  if (serialized.code !== undefined) error.code = serialized.code;
  if (serialized.reason !== undefined) error.reason = serialized.reason;
  if (serialized.retriable !== undefined) error.retriable = serialized.retriable;
  if (serialized.operation !== undefined) error.operation = serialized.operation;
  if (serialized.status !== undefined) error.status = serialized.status;
  return error;
}
