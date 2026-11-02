export type KvJson = null | boolean | number | string | readonly KvJson[] | { readonly [key: string]: KvJson };

export interface KvEntry {
  readonly key: string;
  readonly value: Uint8Array;
  /** Observed JSON metadata; absence and JSON null are preserved. */
  readonly metadata?: KvJson;
  readonly expiration?: number;
}
export interface KvKeyInfo { readonly name: string; readonly metadata?: KvJson; readonly expiration?: number }
export interface KvListRequest { readonly prefix: string; readonly limit?: number; readonly cursor?: string }
export interface KvListPage { readonly keys: readonly KvKeyInfo[]; readonly complete: boolean; readonly nextCursor?: string }

/** Structural borrowed binding; no provider package, Node globals or abort option. */
export interface WorkersKvNamespaceLike {
  getWithMetadata(key: string, options: { type: "stream"; cacheTtl?: number }): Promise<{ value: ReadableStream<Uint8Array> | null; metadata: unknown }>;
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<unknown>;
}
export interface KvLimits {
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly maxKeys?: number;
  readonly maxRows?: number;
  readonly maxPages?: number;
  readonly maxRequests?: number;
  readonly maxValueBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxRequestBytes?: number;
  readonly maxCursors?: number;
  readonly maxCursorBytes?: number;
  readonly maxCursorNodes?: number;
  readonly cursorTtlMs?: number;
}
export interface KvOptions extends KvLimits {
  /** Literal UTF8 prefixes. Empty grant needs allowNamespaceAccess explicitly. */
  readonly allowedPrefixes: readonly string[];
  readonly allowNamespaceAccess?: boolean;
  readonly cacheTtl?: number;
}
export type KvErrorCode = "configuration" | "input" | "permission" | "authentication" | "bounds" | "protocol" | "transport" | "http" | "closed" | "busy";
/** Redacted: no provider payload, key, endpoint, credential or original cause. */
export class CloudflareKvError extends Error {
  public constructor(public readonly code: KvErrorCode, public readonly status?: number) {
    super(`Cloudflare KV read failed (${code})`);
    this.name = "CloudflareKvError";
  }
}
export interface KvReader {
  get(key: string, signal?: AbortSignal): Promise<KvEntry | null>;
  getMany(keys: readonly string[], signal?: AbortSignal): Promise<readonly (KvEntry | null)[]>;
  list(request: KvListRequest, signal?: AbortSignal): Promise<KvListPage>;
}
