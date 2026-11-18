import type { Codec } from "@dalgo/core";
import type { NativeCosmosJsonNumber, NativeCosmosJsonObject } from "./native-json.js";

export type NativeCosmosErrorCode = "configuration" | "input" | "protocol" | "bounds" | "transport" | "authentication" | "cursor" | "session" | "closed" | "busy";
const errorCodes = new WeakMap<NativeCosmosError, NativeCosmosErrorCode>();
const validCodes: readonly NativeCosmosErrorCode[] = ["configuration", "input", "protocol", "bounds", "transport", "authentication", "cursor", "session", "closed", "busy"];
/** No payload, SQL, URL, ID, credential or original foreign error cause. */
export class NativeCosmosError extends Error {
  public constructor(public readonly code: NativeCosmosErrorCode) {
    const safe = validCodes.includes(code) ? code : "transport";
    super(`Native Cosmos read failed (${safe})`); this.code = safe; this.name = "NativeCosmosError"; errorCodes.set(this, safe);
  }
}
const credentialHeaders = new WeakMap<NativeCosmosCredential, string>();
export class NativeCosmosCredential {
  public constructor(header: string, marker: symbol) {
    if (marker !== credentialMarker) throw new NativeCosmosError("authentication");
    credentialHeaders.set(this, header); Object.freeze(this);
  }
  public toString(): string { return "Native Cosmos credential [redacted]"; }
}
const credentialMarker = Symbol("native Cosmos credential");
/** Unencoded broker-issued resource token; percent encoded exactly once. */
export function nativeCosmosResourceToken(raw: string): NativeCosmosCredential {
  if (typeof raw !== "string" || raw.length > 12_288 || !/^type=resource&ver=1\.0&sig=[A-Za-z0-9+/=_-]+$/u.test(raw)) throw new NativeCosmosError("authentication");
  return new NativeCosmosCredential(encodeURIComponent(raw), credentialMarker);
}
/** Raw AAD access token; the caller owns audience and RBAC qualification. */
export function nativeCosmosAadToken(raw: string): NativeCosmosCredential {
  if (typeof raw !== "string" || raw.length > 12_288 || !/^[A-Za-z0-9._~+/=-]+$/u.test(raw)) throw new NativeCosmosError("authentication");
  return new NativeCosmosCredential(`type=aad&ver=1.0&sig=${raw}`, credentialMarker);
}
export function nativeCredentialHeader(value: NativeCosmosCredential): string {
  const header = credentialHeaders.get(value);
  if (header === undefined) throw new NativeCosmosError("authentication");
  return header;
}
export interface NativeCosmosAuthorizationRequest {
  readonly method: "GET" | "POST";
  readonly resourceLink: string;
  readonly resourcePath: string;
  readonly resourceType: "docs";
  readonly date: string;
  readonly authScopeId: string;
  readonly signal: AbortSignal;
}
export type NativeCosmosAuthorizationProvider = (request: NativeCosmosAuthorizationRequest) => NativeCosmosCredential | Promise<NativeCosmosCredential>;
export interface NativeCosmosLimits {
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly maxKeys?: number;
  readonly maxRows?: number;
  readonly maxPages?: number;
  readonly maxRequests?: number;
  readonly pageSize?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** Shared logical storage quota for cursors AND observed session handles. */
  readonly maxHandles?: number;
  readonly maxCursorBytes?: number;
  readonly maxCursorNodes?: number;
  readonly cursorTtlMs?: number;
}
export interface NativeCosmosNoSqlOptions extends NativeCosmosLimits {
  readonly endpoint: string;
  readonly databaseId: string;
  readonly containerId: string;
  readonly partitionKeyField: string;
  /** Trusted principal partition, not a credential authority or account key. */
  readonly authScopeId: string;
  readonly authorization: NativeCosmosAuthorizationProvider;
  /** Fixed DALgo collection paths to explicit string partition values. */
  readonly collections?: Readonly<Record<string, { readonly partition: string }>>;
  readonly fetch?: typeof globalThis.fetch;
}
export interface NativeCosmosKey { readonly id: string; readonly partition: string }
export const nativeOpaqueHandle = Symbol("native Cosmos instance handle");
export interface NativeCosmosSession { readonly [nativeOpaqueHandle]: "session" }
export interface NativeCosmosCursor { readonly [nativeOpaqueHandle]: "cursor" }
export interface NativeCosmosReadOptions<T = NativeCosmosJsonObject> {
  readonly signal?: AbortSignal;
  readonly session?: NativeCosmosSession | undefined;
  readonly codec?: Codec<T>;
}
export interface NativeCosmosResponseMetadata {
  /** Missing is unknown, never an implied zero or prepaid RU limit. */
  readonly requestCharge?: NativeCosmosJsonNumber;
  readonly activityId?: string;
  readonly etag?: string;
  /** Opaque bounded observed token; does not itself enable Session consistency. */
  readonly session?: NativeCosmosSession;
}
export interface NativeCosmosDocument<T = NativeCosmosJsonObject> {
  readonly key: NativeCosmosKey;
  readonly data: T;
  readonly metadata: NativeCosmosResponseMetadata;
}
export interface NativeCosmosReadResult<T = NativeCosmosJsonObject> {
  readonly document: NativeCosmosDocument<T> | null;
  readonly metadata: NativeCosmosResponseMetadata;
}
export interface NativeCosmosBatchResult<T = NativeCosmosJsonObject> {
  readonly documents: readonly (NativeCosmosDocument<T> | null)[];
  readonly metadata: readonly NativeCosmosResponseMetadata[];
}
export interface NativeCosmosQuery {
  readonly sql: string;
  readonly parameters?: readonly { readonly name: string; readonly value: unknown }[];
  readonly partition: string;
  readonly limit?: number;
  readonly cursor?: NativeCosmosCursor | undefined;
}
export interface NativeCosmosPage<T = NativeCosmosJsonObject> {
  readonly documents: readonly NativeCosmosDocument<T>[];
  readonly metadata: readonly NativeCosmosResponseMetadata[];
  readonly nextCursor?: NativeCosmosCursor;
  readonly pages: number;
}
export class NativeCosmosHttpError extends Error {
  public constructor(public readonly status: number, public readonly metadata: NativeCosmosResponseMetadata, public readonly retryAfterMs?: number) {
    super(`Native Cosmos HTTP read failed (${String(status)})`); this.name = "NativeCosmosHttpError";
  }
}
interface SafeHttpFailure { readonly status: number; readonly metadata: NativeCosmosResponseMetadata; readonly retryAfterMs?: number }
const httpFailures = new WeakMap<NativeCosmosHttpError, SafeHttpFailure>();
/** Internal creation provenance; borrowed callbacks cannot forge HTTP metadata. */
export function nativeHttpFailure(status: number, metadata: NativeCosmosResponseMetadata, retryAfterMs?: number): NativeCosmosHttpError {
  const snapshot = Object.freeze({ ...metadata });
  const error = new NativeCosmosHttpError(status, snapshot, retryAfterMs);
  httpFailures.set(error, { status, metadata: snapshot, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  return error;
}
export function nativeSafeFailure(error: unknown): Error {
  try {
    if (error instanceof NativeCosmosError) return new NativeCosmosError(errorCodes.get(error) ?? "transport");
    if (error instanceof NativeCosmosHttpError) {
      const safe = httpFailures.get(error);
      if (safe !== undefined) return nativeHttpFailure(safe.status, safe.metadata, safe.retryAfterMs);
    }
  } catch { /* Even a foreign Proxy exception must not escape normalization. */ }
  return new NativeCosmosError("transport");
}
