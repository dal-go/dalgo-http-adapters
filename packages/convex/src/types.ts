import type { Value } from "convex/values";

export type ConvexValue = Value;
export type ConvexDocument = Readonly<Record<string, Value>>;
export type ConvexArguments = Readonly<Record<string, Value>>;
export type ConvexErrorCode = "invalid-input" | "protocol" | "limit" | "denied" | "transport" | "cursor" | "busy" | "closed" | "not-implemented" | "pagination-split-required";

/** Fixed codes never retain provider messages, log lines, arguments or causes. */
export class ConvexReadError extends Error {
  public constructor(public readonly code: ConvexErrorCode) {
    super("Convex read: " + code);
    this.name = "ConvexReadError";
  }
}

export interface ConvexField {
  readonly name: string;
  readonly type: string;
  readonly nullable?: boolean;
}
export interface ConvexCollection {
  /** A deployed PUBLIC query function, e.g. dalgo:getTask, not a table API. */
  readonly getFunction: string;
  readonly idArgument?: string;
  readonly idField?: string;
  readonly staticArgs?: ConvexArguments;
  readonly fields?: readonly ConvexField[];
}
export interface ConvexQueryFunction {
  readonly path: string;
  readonly collection: string;
  /** Caller arguments permitted by this trusted function contract. */
  readonly arguments?: readonly string[];
  readonly staticArgs?: ConvexArguments;
}
export interface ConvexOptions {
  readonly endpoint: string;
  /** A user JWT, never a deployment/admin key. No admin-auth mode is provided. */
  readonly token?: string | ((signal: AbortSignal) => string | Promise<string>);
  /** Anonymous functions require an explicit decision; never an auth fallback. */
  readonly allowAnonymous?: boolean;
  readonly collections: Readonly<Record<string, ConvexCollection>>;
  readonly queries?: Readonly<Record<string, ConvexQueryFunction>>;
  readonly fetch?: typeof fetch;
  readonly allowInsecureLoopbackHttp?: boolean;
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly maxGetManyKeys?: number;
  readonly maxPages?: number;
  readonly maxResponseBytes?: number;
  readonly maxRequestBytes?: number;
  readonly maxTotalRequestBytes?: number;
  readonly maxWorkRows?: number;
  readonly maximumRowsRead?: number;
  readonly maximumBytesRead?: number;
  readonly maxConcurrent?: number;
  readonly maxCursors?: number;
  readonly cursorTtlMs?: number;
}
export interface ConvexPageOptions {
  readonly pageSize?: number;
  /** Instance-issued continuation; deliberately not portable after reopen. */
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}
export interface ConvexNativePage {
  readonly documents: readonly ConvexDocument[];
  readonly isDone: boolean;
  readonly nextCursor?: string;
}
export interface ConvexConfiguredMetadata {
  readonly provenance: "trusted-configuration";
  readonly dynamicDiscovery: false;
  readonly authorizationVerified: false;
  readonly collections: readonly {
    readonly collection: string;
    readonly idField: string;
    readonly fields: readonly ConvexField[];
  }[];
  readonly queries: readonly { readonly alias: string; readonly collection: string }[];
}
