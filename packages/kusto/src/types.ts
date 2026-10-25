export type KustoAccessTokenProvider = () => string | Promise<string>;
export type KustoFetch = typeof globalThis.fetch;
export type KustoParameterType = "string" | "long" | "real" | "bool" | "datetime" | "timespan" | "guid" | "dynamic";
export interface KustoParameter { readonly type: KustoParameterType; readonly value: string | number | boolean | null; }
export interface KustoTable { readonly table: string; readonly keyColumn: string; readonly columns: Readonly<Record<string, string>>; }
export interface KustoDatabaseOptions {
  /** Cluster origin, e.g. https://example.eastus.kusto.windows.net. */ readonly clusterUrl: string;
  readonly database: string;
  /** Re-evaluated per request. Return a short-lived Entra bearer token. */ readonly accessToken: KustoAccessTokenProvider;
  readonly tables: Readonly<Record<string, KustoTable>>;
  readonly fetch?: KustoFetch;
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly maxResponseBytes?: number;
}
