import { createAbortScope, QueryCancelledError, raceAbort, type AbortScope } from "@dalgo/adapter-runtime";

/** One public-call deadline, cancellation and aggregate byte/work ownership. */
export class CouchDbOperation {
  readonly #scope: AbortScope;
  readonly #caller: AbortSignal | undefined;
  readonly #controller = new AbortController();
  readonly #expires: number;
  readonly #failure: () => Error;
  readonly #bytesError: () => Error;
  readonly #maxResponse: number;
  readonly #maxRequest: number;
  readonly #forward = (): void => { this.#controller.abort(); };
  readonly #delivery: (() => void)[] = [];
  readonly #cleanup: (() => void)[] = [];
  #response = 0;
  #request = 0;
  #failed = false;

  public constructor(caller: AbortSignal | undefined, timeoutMs: number, maxResponse: number, maxRequest: number, failure: () => Error, bytesError: () => Error) {
    this.#caller = caller;
    this.#expires = performance.now() + timeoutMs;
    this.#scope = createAbortScope(caller, timeoutMs);
    this.#maxResponse = maxResponse; this.#maxRequest = maxRequest;
    this.#failure = failure; this.#bytesError = bytesError;
    if (this.#scope.signal.aborted) this.#controller.abort();
    else this.#scope.signal.addEventListener("abort", this.#forward, { once: true });
  }
  public get signal(): AbortSignal { return this.#controller.signal; }
  public get stopped(): boolean { return this.#failed || this.#scope.signal.aborted || this.#caller?.aborted === true || performance.now() >= this.#expires; }
  public get remainingResponseBytes(): number { return this.#maxResponse - this.#response; }
  public checkCancellation(): void {
    if (this.#scope.signal.aborted || this.#caller?.aborted === true) throw new QueryCancelledError(this.#scope.deadlineExceeded ? "deadline" : "caller");
    if (performance.now() >= this.#expires) throw new QueryCancelledError("deadline");
  }
  public check(): void { this.checkCancellation(); if (this.#failed) throw this.#failure(); }
  public requestBytes(bytes: number): void {
    this.check();
    if (bytes > this.#maxRequest - this.#request) throw new RangeError("CouchDB request exceeds maxRequestBytes");
    this.#request += bytes;
  }
  public responseBytes(bytes: number): void {
    this.check();
    if (bytes > this.remainingResponseBytes) throw this.#bytesError();
    this.#response += bytes;
  }
  public call<T>(effect: () => T): T {
    this.check();
    try { const value = effect(); this.check(); return value; }
    catch { this.check(); throw this.#failure(); }
  }
  public async io<T>(effect: () => T | Promise<T>): Promise<T> {
    this.check();
    try {
      const value = await raceAbort(Promise.resolve(effect()), this.signal, () => new QueryCancelledError(this.#scope.deadlineExceeded ? "deadline" : "caller"));
      this.check(); return value;
    } catch { this.check(); throw this.#failure(); }
  }
  /** Internal cursor state only, committed after final caller/deadline checks. */
  public beforeDelivery(effect: () => void): void { this.#delivery.push(effect); }
  public onFailure(effect: () => void): void { this.#cleanup.push(effect); }
  public deliver(): void { this.check(); for (const effect of this.#delivery) effect(); }
  public fail(): void {
    if (this.#failed) return;
    this.#failed = true; this.#controller.abort();
    for (const effect of this.#cleanup) effect();
  }
  public dispose(): void { this.#scope.signal.removeEventListener("abort", this.#forward); this.#scope.dispose(); }
}
