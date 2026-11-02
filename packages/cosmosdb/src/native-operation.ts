import { QueryCancelledError, raceAbort } from "@dalgo/adapter-runtime";
import { NativeCosmosError, nativeSafeFailure, type NativeCosmosLimits } from "./native-types.js";

const abortedDescriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");
/** Genuine native state, regardless of caller/provider-owned shadow properties. */
function nativeAborted(signal: AbortSignal): boolean {
  if (abortedDescriptor?.get === undefined) throw new NativeCosmosError("transport");
  const value: unknown = abortedDescriptor.get.call(signal);
  if (typeof value !== "boolean") throw new NativeCosmosError("transport");
  return value;
}
function safeFreshFailure(error: unknown): Error {
  try {
    if (error instanceof QueryCancelledError) return new QueryCancelledError(error.reason === "deadline" ? "deadline" : "caller");
  } catch { return new NativeCosmosError("transport"); }
  return nativeSafeFailure(error);
}

export interface NativeLimits {
  readonly timeoutMs: number; readonly maxConcurrent: number; readonly maxKeys: number;
  readonly maxRows: number; readonly maxPages: number; readonly maxRequests: number; readonly pageSize: number;
  readonly maxRequestBytes: number; readonly maxResponseBytes: number;
  readonly maxHandles: number; readonly maxCursorBytes: number; readonly maxCursorNodes: number; readonly cursorTtlMs: number;
}
function integer(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new NativeCosmosError("configuration");
  return result;
}
export function nativeLimits(input: NativeCosmosLimits): NativeLimits {
  return {
    timeoutMs: integer(input.timeoutMs, 30_000, 120_000), maxConcurrent: integer(input.maxConcurrent, 4, 16),
    maxKeys: integer(input.maxKeys, 100, 1000), maxRows: integer(input.maxRows, 1000, 10_000),
    maxPages: integer(input.maxPages, 100, 1000), maxRequests: integer(input.maxRequests, 100, 1000), pageSize: integer(input.pageSize, 100, 1000),
    maxRequestBytes: integer(input.maxRequestBytes, 65_536, 1_048_576), maxResponseBytes: integer(input.maxResponseBytes, 1_048_576, 16_777_216),
    maxHandles: integer(input.maxHandles, 1000, 1000), maxCursorBytes: integer(input.maxCursorBytes, 16_777_216, 16_777_216),
    maxCursorNodes: integer(input.maxCursorNodes, 65_536, 65_536), cursorTtlMs: integer(input.cursorTtlMs, 300_000, 600_000),
  };
}
export interface NativeBudget { requestBytes: number; responseBytes: number; rows: number; pages: number; requests: number; failed: boolean }
export function nativeBudget(): NativeBudget { return { requestBytes: 0, responseBytes: 0, rows: 0, pages: 0, requests: 0, failed: false }; }

/** No queue: ignored credentials/fetch/read/cancel retain their physical slot. */
export class NativeManager {
  public readonly limits: NativeLimits;
  readonly #active = new Set<NativeOperation>();
  #closed = false;
  public constructor(input: NativeCosmosLimits) { this.limits = nativeLimits(input); }
  public get closed(): boolean { return this.#closed; }
  public begin(caller?: AbortSignal): NativeOperation {
    if (this.#closed) throw new NativeCosmosError("closed");
    if (this.#active.size >= this.limits.maxConcurrent) throw new NativeCosmosError("busy");
    const op = new NativeOperation(this, caller, () => { this.#active.delete(op); });
    this.#active.add(op);
    try { op.check(); return op; }
    catch (error) { const failure = op.failure(error); op.finish(); throw failure; }
  }
  public close(): void { this.#closed = true; for (const op of this.#active) op.abort(); }
}

export class NativeOperation {
  public budget = nativeBudget();
  #expires: number;
  readonly #manager: NativeManager;
  readonly #caller: AbortSignal | undefined;
  readonly #controller = new AbortController();
  readonly #race = new AbortController();
  #timer: ReturnType<typeof setTimeout>;
  readonly #release: () => void;
  readonly #onCaller = (): void => { this.abort(); };
  readonly #cleaned = new WeakSet();
  readonly #settledCallbacks = new Set<() => void>();
  #pending = 0;
  #finished = false;
  #disposed = false;
  #released = false;
  #setupFailed = false;
  #deadlineReached = false;
  public constructor(manager: NativeManager, caller: AbortSignal | undefined, release: () => void) {
    this.#manager = manager; this.#caller = caller; this.#release = release;
    this.#expires = performance.now() + manager.limits.timeoutMs;
    this.#timer = setTimeout(() => { this.#deadlineReached = true; this.abort(); }, manager.limits.timeoutMs);
    // Native listener methods avoid provider instrumentation of our bookkeeping.
    if (caller !== undefined) {
      try { EventTarget.prototype.addEventListener.call(caller, "abort", this.#onCaller, { once: true }); }
      catch { this.#setupFailed = true; }
    }
  }
  public get signal(): AbortSignal { return this.#controller.signal; }
  public get expires(): number { return this.#expires; }
  public restrictDeadline(expires: number): void {
    this.#expires = Math.min(this.#expires, expires); this.check(); clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#deadlineReached = true; this.abort(); }, Math.max(0, this.#expires - performance.now()));
  }
  public get limits(): NativeLimits { return this.#manager.limits; }
  private fresh(): void {
    try {
      if (this.#caller !== undefined && nativeAborted(this.#caller)) throw new QueryCancelledError("caller");
      if (this.#deadlineReached || performance.now() >= this.expires) { this.abort(); throw new QueryCancelledError("deadline"); }
      if (this.#manager.closed) throw new NativeCosmosError("closed");
      if (this.#setupFailed) throw new NativeCosmosError("transport");
    } catch (error: unknown) { throw safeFreshFailure(error); }
  }
  public check(): void {
    this.fresh();
    if (nativeAborted(this.signal) || this.#finished) throw new NativeCosmosError("closed");
  }
  public abort(): void { this.#controller.abort(); this.#race.abort(); }
  private release(): void {
    if (!this.#finished || this.#pending !== 0 || this.#released) return;
    this.#released = true; this.#release();
    for (const callback of this.#settledCallbacks) callback();
    this.#settledCallbacks.clear();
  }
  public afterSettled(callback: () => void): void { this.#settledCallbacks.add(callback); }
  private settled(): void { this.#pending--; this.release(); }
  public async io<T>(effect: () => T | PromiseLike<T>, late?: (value: T) => void): Promise<T> {
    this.check(); this.#pending++;
    const pending = Promise.resolve().then(() => { this.check(); return effect(); });
    const tracked = pending.then(value => {
      try { if (this.#finished || nativeAborted(this.signal) || performance.now() >= this.expires) late?.(value); }
      finally { this.settled(); }
      return value;
    }, (error: unknown) => { this.settled(); throw error; });
    try {
      const value = await raceAbort(tracked, this.#race.signal, () => {
        try { this.check(); } catch (error) { return safeFreshFailure(error); }
        return new NativeCosmosError("closed");
      });
      this.check(); return value;
    } catch { this.check(); throw new NativeCosmosError("transport"); }
  }
  public call<T>(effect: () => T): T {
    this.check();
    try { const result = effect(); this.check(); return result; }
    catch { this.check(); throw new NativeCosmosError("transport"); }
  }
  public cleanup(resource: { cancel(): unknown } | null): void {
    if (resource === null || this.#cleaned.has(resource)) return;
    this.#cleaned.add(resource); this.#pending++;
    try { void Promise.resolve(resource.cancel()).then(() => { this.settled(); }, () => { this.settled(); }); }
    catch { this.settled(); }
  }
  public request(bytes: number): void {
    this.check(); const b = this.budget;
    b.requests++; b.requestBytes += bytes;
    if (b.failed || b.responseBytes >= this.limits.maxResponseBytes || b.requests > this.limits.maxRequests || b.requestBytes > this.limits.maxRequestBytes) this.exhaust();
  }
  public response(bytes: number): void {
    this.check(); this.budget.responseBytes += bytes;
    if (this.budget.failed || this.budget.responseBytes > this.limits.maxResponseBytes) this.exhaust();
  }
  public rows(amount: number): void { this.check(); this.budget.rows += amount; if (this.budget.rows > this.limits.maxRows) this.exhaust(); }
  public exhaust(): never { this.budget.failed = true; throw new NativeCosmosError("bounds"); }
  private dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#timer);
    if (this.#caller !== undefined) EventTarget.prototype.removeEventListener.call(this.#caller, "abort", this.#onCaller);
  }
  /** Everything fallible/foreign finishes before the caller performs cursor ACK. */
  public prepareDelivery(): void { this.check(); this.dispose(); this.check(); }
  public failure(error: unknown): Error {
    this.abort();
    try { this.dispose(); this.fresh(); }
    catch (fresh: unknown) { return safeFreshFailure(fresh); }
    const safe = nativeSafeFailure(error);
    try { this.fresh(); } catch (fresh: unknown) { return safeFreshFailure(fresh); }
    return safe;
  }
  /** Callback-free after prepareDelivery on success. */
  public finish(): void { this.dispose(); this.#finished = true; this.release(); }
}
