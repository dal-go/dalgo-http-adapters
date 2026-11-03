import type { StructuredQuery } from "@dalgo/core";
export type AthenaAction = "GetWorkGroup" | "StartQueryExecution" | "GetQueryExecution" | "GetQueryResults" | "StopQueryExecution";
/** Attested by trusted integration, never request JSON or token presence. */
export interface AthenaAuthority { readonly principal: string; readonly generation: string }
export interface AthenaTransport {
  authorize(signal: AbortSignal): AthenaAuthority | Promise<AthenaAuthority>;
  /** Bind bounded private signing state to the client-owned closed copy.
   * The original object is never retained in a journal. Any private state
   * retained per admitted authority must fit 65,536 logical bytes/64 nodes. */
  captureAuthority?(original: AthenaAuthority, admitted: AthenaAuthority): void | Promise<void>;
  /** Borrowed transport: exactly one request; no redirect/retry or principal fallback. */
  request(action: AthenaAction, body: string, authority: AthenaAuthority, signal: AbortSignal): Response | Promise<Response>;
}
export interface AthenaTable { readonly table: string; readonly columns: Readonly<Record<string, string>>; readonly idColumn?: string }
export interface AthenaSource {
  readonly sourceId: string; readonly region: string; readonly workGroup: string; readonly catalog: string; readonly database: string;
  readonly outputLocation: string; readonly expectedBucketOwner: string; readonly maxScanBytes: string;
  readonly encryption: { readonly option: "SSE_S3" | "SSE_KMS"; readonly kmsKey?: string };
  readonly tables: Readonly<Record<string, AthenaTable>>;
}
export interface AthenaLimits {
  readonly timeoutMs?: number; readonly maxConcurrent?: number; readonly maxRows?: number; readonly maxPages?: number;
  readonly maxRequests?: number; readonly maxPolls?: number; readonly pollIntervalMs?: number;
  readonly maxRequestBytes?: number; readonly maxInputBytes?: number; readonly maxPageBytes?: number; readonly maxResponseBytes?: number;
  readonly maxPageNodes?: number; readonly maxNodes?: number; readonly maxColumns?: number;
  readonly maxCursors?: number; readonly maxCursorBytes?: number; readonly maxCursorNodes?: number; readonly cursorTtlMs?: number;
}
export interface AthenaOptions extends AthenaLimits { readonly source: AthenaSource; readonly transport: AthenaTransport }
export interface AthenaColumn {
  readonly name: string; readonly type: string; readonly label?: string; readonly catalog?: string; readonly schema?: string;
  readonly table?: string; readonly precision?: number; readonly scale?: number; readonly nullable?: string; readonly caseSensitive?: boolean;
}
export interface AthenaCounters { requests: number; requestBytes: number; bytes: number; nodes: number; pages: number; fetchedRows: number; rows: number; attempts: number }
export interface AthenaReceipt {
  readonly sourceId: string; readonly queryId: string; readonly state: "SUCCEEDED"; readonly complete: boolean;
  readonly counters: Readonly<AthenaCounters>; readonly dataScannedBytes?: string;
}
declare const cursorBrand: unique symbol;
export type AthenaCursor = string & { readonly [cursorBrand]: true };
export interface AthenaNativePage {
  readonly columns: readonly AthenaColumn[]; readonly rows: readonly (readonly (string | null)[])[];
  readonly ordinalStart: number; readonly hasMore: boolean; readonly nextCursor?: AthenaCursor; readonly receipt: AthenaReceipt;
}
export interface AthenaReadOptions { readonly signal?: AbortSignal; readonly pageSize?: number; readonly offset?: number; readonly projection?: readonly string[] }
export interface AthenaReader {
  queryPage(query: StructuredQuery<unknown>, options?: AthenaReadOptions): Promise<AthenaNativePage>;
  nextPage(cursor: AthenaCursor, signal?: AbortSignal): Promise<AthenaNativePage>;
}
