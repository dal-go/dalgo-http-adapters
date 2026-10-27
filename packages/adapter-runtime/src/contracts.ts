import type { QueryPage, StructuredQuery } from "@dalgo/core";

/**
 * Additive, adapter-level query entry point for callers that need to cancel
 * work. It deliberately does not change the core `QueryExecutor.query(query)`
 * contract: an adapter may implement both, and existing callers keep using
 * `query`.
 */
export interface CancellableQueryExecutor {
  /**
   * Executes one query page. The signal propagates through header acquisition,
   * the HTTP request and response-body consumption, and is combined with the
   * adapter's configured end-to-end deadline. A caller abort rejects promptly
   * with `QueryCancelledError` and must not return a late page.
   */
  queryWithSignal<T>(
    query: StructuredQuery<T>,
    signal: AbortSignal,
  ): Promise<QueryPage<T>>;
}

/** Why an adapter stopped a cancellable query. */
export type QueryCancellationReason = "caller" | "deadline";

/**
 * Redacted cancellation failure. The producer never copies `AbortSignal.reason`
 * or a transport error into the message or `cause`, because either can contain
 * a token, cookie or provider response. `reason` distinguishes a caller abort
 * from the adapter's own deadline.
 */
export class QueryCancelledError extends Error {
  public readonly reason: QueryCancellationReason;

  public constructor(reason: QueryCancellationReason) {
    super(reason === "caller" ? "query cancelled by caller" : "query deadline exceeded");
    this.name = "QueryCancelledError";
    this.reason = reason;
  }
}

export function isQueryCancelledError(value: unknown): value is QueryCancelledError {
  return value instanceof QueryCancelledError;
}

/**
 * Narrows a database to the optional cancellable surface without assuming the
 * core `QueryExecutor` interface was changed.
 */
export function isCancellableQueryExecutor<T>(
  value: T,
): value is T & CancellableQueryExecutor {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  return typeof (value as Record<string, unknown>).queryWithSignal === "function";
}
