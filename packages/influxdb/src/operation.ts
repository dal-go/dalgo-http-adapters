import { UnsupportedError } from "@dalgo/core";
import { createAbortScope, QueryCancelledError, raceAbort, type AbortScope } from "@dalgo/adapter-runtime";

/** A redacted failure from the caller-supplied token, fetch or body transport. */
export class InfluxDB3TransportError extends Error {
  public constructor() { super("InfluxDB 3 request failed"); this.name = "InfluxDB3TransportError"; }
}

/** One deadline and aggregate response budget, including all getMany requests. */
export class InfluxDB3Operation {
  readonly #scope: AbortScope;
  readonly #caller: AbortSignal | undefined;
  readonly #maxBytes: number;
  readonly #expires: number;
  #bytes = 0;
  #closed = false;

  public constructor(signal: AbortSignal | undefined, timeoutMs: number, maxBytes: number) {
    this.#caller = signal;
    this.#expires = performance.now() + timeoutMs;
    this.#scope = createAbortScope(signal, timeoutMs);
    this.#maxBytes = maxBytes;
  }

  public get signal(): AbortSignal { return this.#scope.signal; }
  public get stopped(): boolean { return this.#closed || this.signal.aborted || performance.now() >= this.#expires; }
  public get remainingBytes(): number { return this.#maxBytes - this.#bytes; }

  public check(): void {
    // Check the original signal even after dispose removed its listener. Cleanup
    // callbacks may synchronously abort it before the final delivery check.
    if (this.signal.aborted || this.#caller?.aborted === true) throw this.cancelled();
    // Synchronous token/codec work can cross the deadline before the event loop
    // services its timer. Preserve an already-observed caller abort above.
    if (performance.now() >= this.#expires) throw new QueryCancelledError("deadline");
  }

  private cancelled(): QueryCancelledError {
    return new QueryCancelledError(this.#scope.deadlineExceeded ? "deadline" : "caller");
  }

  public consume(bytes: number): void {
    this.check();
    if (bytes > this.remainingBytes) throw new UnsupportedError("InfluxDB 3 response exceeds maxResponseBytes");
    this.#bytes += bytes;
  }

  public async io<T>(effect: () => T | Promise<T>): Promise<T> {
    this.check();
    try {
      const value = await raceAbort(Promise.resolve(effect()), this.signal, () => this.cancelled());
      this.check();
      return value;
    } catch {
      this.check();
      // Never forward provider errors, signal reasons, tokens, URLs or causes.
      throw new InfluxDB3TransportError();
    }
  }

  public dispose(): void {
    this.#closed = true;
    this.#scope.dispose();
  }
}
