import {
  QueryCancelledError,
  cancelQuietly,
  createAbortScope,
  isCancellableQueryExecutor,
  raceAbort,
  type AdapterReadCapabilities,
  type CancellableQueryExecutor,
} from "../src/index.js";

/**
 * Type-only browser fixture: it proves the runtime surface compiles against
 * DOM globals with `types: []` (no Node ambient types). It is not executed.
 */
export async function browserFixture(
  fetchImpl: typeof globalThis.fetch,
  capabilities: AdapterReadCapabilities,
  executor: unknown,
): Promise<readonly string[]> {
  const controller = new AbortController();
  const scope = createAbortScope(controller.signal, 1_000);
  const seen: string[] = [];
  try {
    const response = await raceAbort(
      fetchImpl("https://example.invalid/"),
      scope.signal,
      () => new QueryCancelledError(scope.deadlineExceeded ? "deadline" : "caller"),
    );
    seen.push(response.status.toString());
    const reader = response.body?.getReader();
    if (reader !== undefined) {
      try {
        const chunk = await raceAbort(
          reader.read(),
          scope.signal,
          () => new QueryCancelledError("caller"),
        );
        seen.push(chunk.done ? "done" : new TextDecoder().decode(chunk.value));
      } finally {
        if (scope.signal.aborted) cancelQuietly(reader);
        try {
          reader.releaseLock();
        } catch {
          // A cancelled stream can retain its lock.
        }
      }
    }
    seen.push(capabilities.query.filter.status);
    if (isCancellableQueryExecutor(executor)) {
      const cancellable: CancellableQueryExecutor = executor;
      seen.push(typeof cancellable.queryWithSignal);
    }
  } finally {
    scope.dispose();
  }
  return seen;
}
