export type SpannerScalarType = "STRING" | "BOOL" | "INT64" | "FLOAT64" | "TIMESTAMP" | "DATE" | "JSON";
export interface SpannerColumn { readonly column: string; readonly type: SpannerScalarType; readonly nullable?: boolean; }
/** A top-level DALgo collection's bounded schema projection. This adapter supports a single-column primary key. */
export interface SpannerTable { readonly table: string; readonly keyColumn: SpannerColumn; readonly columns: Readonly<Record<string, SpannerColumn>>; }
export type SpannerAccessTokenProvider = () => string | Promise<string>;
export type SpannerFetch = typeof globalThis.fetch;
export interface SpannerDatabaseOptions {
  readonly projectId: string;
  readonly instanceId: string;
  readonly databaseId: string;
  readonly tables: Readonly<Record<string, SpannerTable>>;
  /** Called for every request; return a short-lived OAuth access token. */
  readonly accessToken: SpannerAccessTokenProvider;
  readonly fetch?: SpannerFetch;
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly maxResponseBytes?: number;
}
