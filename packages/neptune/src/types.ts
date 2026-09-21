export interface NeptuneCollectionOptions {
  /** Approved Neptune node label for this top-level DALgo collection. */
  readonly label: string;
  /** Prefix for Neptune's globally unique `~id`; defaults to `${collection}:`. */
  readonly idPrefix?: string;
}

export type NeptuneHeaders = Readonly<Record<string, string>>;
export type NeptuneHeadersProvider = NeptuneHeaders | (() => NeptuneHeaders | Promise<NeptuneHeaders>);

export interface NeptuneDatabaseOptions {
  /** Neptune DB cluster HTTPS origin, normally `https://cluster:8182`. */
  readonly baseUrl: string | URL;
  /** Collection allowlist and its DALgo-key to Neptune-node mappings. */
  readonly collections: Readonly<Record<string, NeptuneCollectionOptions>>;
  /** Called per request for additional static or rotating request headers. */
  readonly headers?: NeptuneHeadersProvider;
  /** Absolute request deadline; defaults to 30 seconds and is bounded to 60 seconds. */
  readonly timeoutMs?: number;
  /** A custom fetch may SigV4-sign the final URL, headers, and form body. */
  readonly fetch?: typeof fetch;
}

export interface ResolvedCollection {
  readonly collection: string;
  readonly label: string;
  readonly idPrefix: string;
}

export interface NeptuneNode {
  readonly id: string;
  readonly labels: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}

export class NeptuneQueryError extends Error {
  public readonly code: string | undefined;

  public constructor(code: string | undefined) {
    super(code === undefined ? "Neptune openCypher request failed" : `Neptune openCypher request failed (${code})`);
    this.name = "NeptuneQueryError";
    this.code = code;
  }
}
