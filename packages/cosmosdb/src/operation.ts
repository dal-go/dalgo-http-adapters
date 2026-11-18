import { createAbortScope, QueryCancelledError, raceAbort, type AbortScope } from "@dalgo/adapter-runtime";

/** Redacted failure from authorization, fetch, or response-body transport. */
export class CosmosTransportError extends Error {
  public constructor() { super("Cosmos request failed"); this.name = "CosmosTransportError"; }
}

/** One caller/deadline scope and aggregate JSON/body budgets per public call. */
export class CosmosOperation {
  readonly #scope: AbortScope;
  readonly #caller: AbortSignal | undefined;
  readonly #controller = new AbortController();
  readonly #expires: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #onAbort = (): void => { this.#controller.abort(); };
  #requestBytes = 0;
  #responseBytes = 0;
  #failed = false;

  public constructor(caller: AbortSignal | undefined, timeoutMs: number, maxRequestBytes: number, maxResponseBytes: number) {
    this.#caller = caller;
    this.#expires = performance.now() + timeoutMs;
    this.#scope = createAbortScope(caller, timeoutMs);
    this.#maxRequestBytes = maxRequestBytes;
    this.#maxResponseBytes = maxResponseBytes;
    if (this.#scope.signal.aborted) this.#controller.abort();
    else this.#scope.signal.addEventListener("abort", this.#onAbort, { once: true });
  }

  public get signal(): AbortSignal { return this.#controller.signal; }
  public get remainingResponseBytes(): number { return this.#maxResponseBytes - this.#responseBytes; }
  public get stopped(): boolean { return this.#failed || this.#scope.signal.aborted || this.#caller?.aborted === true || performance.now() >= this.#expires; }

  public check(): void {
    this.checkCancellation();
    if (this.#failed) throw new CosmosTransportError();
  }
  /** Preserve caller/deadline priority without replacing the first batch error. */
  public checkCancellation(): void {
    // Preserve an already observed caller/deadline before checking elapsed time.
    if (this.#scope.signal.aborted || this.#caller?.aborted === true) throw this.cancelled();
    if (performance.now() >= this.#expires) throw new QueryCancelledError("deadline");
  }
  private cancelled(): QueryCancelledError { return new QueryCancelledError(this.#scope.deadlineExceeded ? "deadline" : "caller"); }
  public requestBytes(bytes: number): void {
    this.check();
    if (bytes > this.#maxRequestBytes - this.#requestBytes) throw new RangeError("Cosmos request exceeds maxRequestBytes");
    this.#requestBytes += bytes;
  }
  public responseBytes(bytes: number): void {
    this.check();
    if (bytes > this.remainingResponseBytes) throw new RangeError("Cosmos response exceeds maxResponseBytes");
    this.#responseBytes += bytes;
  }
  public call<T>(effect: () => T): T {
    this.check();
    try { const value = effect(); this.check(); return value; }
    catch { this.check(); throw new CosmosTransportError(); }
  }
  public async io<T>(effect: () => T | Promise<T>): Promise<T> {
    this.check();
    try {
      const value = await raceAbort(Promise.resolve(effect()), this.signal, () => this.cancelled());
      this.check();
      return value;
    } catch {
      this.check();
      throw new CosmosTransportError();
    }
  }
  /** Abort started siblings after failure; never mutate/destroy borrowed fetch. */
  public fail(): void { this.#failed = true; this.#controller.abort(); }
  public dispose(): void {
    this.#scope.signal.removeEventListener("abort", this.#onAbort);
    this.#scope.dispose();
  }
}
