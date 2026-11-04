import { raceAbort, QueryCancelledError, type AbortScope } from "@dalgo/adapter-runtime";
import { RedisReadError } from "./contracts.js";

export function cancellationError(scope: AbortScope): QueryCancelledError {
  return new QueryCancelledError(scope.callerAborted ? "caller" : "deadline");
}

/** A scope is mutable across awaits; keep the fresh check outside control-flow narrowing in callers. */
export function assertActive(scope: AbortScope): void {
  if (scope.signal.aborted) throw cancellationError(scope);
}

/** Read with a byte cap before decoding/parsing; cancellation never waits on reader cleanup. */
export async function readJson(body: ReadableStream<Uint8Array> | null, maximum: number, scope: AbortScope): Promise<unknown> {
  if (body === null) throw new RedisReadError("protocol");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const next = await raceAbort(reader.read(), scope.signal, () => cancellationError(scope));
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) throw new RedisReadError("limit");
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof RedisReadError || error instanceof QueryCancelledError) throw error;
    throw new RedisReadError("protocol");
  } finally {
    try { void reader.cancel().catch(() => undefined); } catch { /* Cleanup cannot replace the request error. */ }
    try { reader.releaseLock(); } catch { /* A hostile reader may retain an unresolved read after cancellation. */ }
  }
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
