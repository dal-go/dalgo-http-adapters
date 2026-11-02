import { QueryCancelledError, raceAbort } from "@dalgo/adapter-runtime";
import { failure, safeFailure } from "./errors.js";

export interface SnowflakeLimits {
  readonly timeoutMs?: number; readonly maxConcurrent?: number; readonly maxKeys?: number;
  readonly maxRequestBytes?: number; readonly maxResponseBytes?: number; readonly maxPageBytes?: number;
  readonly maxRequests?: number; readonly maxPartitions?: number; readonly maxColumns?: number; readonly maxNodes?: number;
}
export interface Limits {
  timeoutMs: number; maxConcurrent: number; maxKeys: number; maxRequestBytes: number;
  maxResponseBytes: number; maxPageBytes: number; maxRequests: number; maxPartitions: number; maxColumns: number; maxNodes: number;
}
export function integer(value: number, min: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < min || value > maximum) throw failure(`Invalid ${name}`);
  return value;
}
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const cancellations = new WeakMap<object, "caller" | "deadline">();
function cancelled(reason: "caller" | "deadline"): QueryCancelledError {
  const error = new QueryCancelledError(reason); cancellations.set(error, reason); return error;
}
export function signalAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (abortedGetter === undefined) throw failure("Invalid Snowflake caller signal");
  try { return Reflect.apply(abortedGetter, signal, []) === true; }
  catch { throw failure("Invalid Snowflake caller signal"); }
}
export class Manager {
  public readonly limits: Limits;
  #closed = false;
  readonly #active = new Set<Operation>();
  public constructor(options: SnowflakeLimits) {
    const n = (key: keyof SnowflakeLimits, fallback: number, max: number): number => integer(options[key] ?? fallback, 1, key, max);
    this.limits = { timeoutMs: n("timeoutMs", 60_000, 120_000), maxConcurrent: n("maxConcurrent", 4, 16), maxKeys: n("maxKeys", 100, 1000),
      maxRequestBytes: n("maxRequestBytes", 65_536, 1_048_576), maxResponseBytes: n("maxResponseBytes", 16_777_216, 33_554_432),
      maxPageBytes: n("maxPageBytes", 4_194_304, 16_777_216), maxRequests: n("maxRequests", 512, 2048),
      maxPartitions: n("maxPartitions", 128, 1024), maxColumns: n("maxColumns", 512, 4096), maxNodes: n("maxNodes", 65_536, 262_144) };
  }
  public get closed(): boolean { return this.#closed; }
  public close(): void { this.#closed = true; for (const op of this.#active) op.abort(); }
  public async run<T>(signal: AbortSignal | undefined, effect: (op: Operation) => Promise<T>): Promise<T> {
    if (signalAborted(signal)) throw cancelled("caller");
    if (this.#closed) throw failure("Snowflake adapter closed");
    if (this.#active.size >= this.limits.maxConcurrent) throw failure("Snowflake adapter busy");
    let op: Operation;
    try { op = new Operation(this, signal, () => { this.#active.delete(op); }); }
    catch (error: unknown) { throw safeFailure(error); }
    this.#active.add(op);
    try { op.check(); const value = await effect(op); op.prepareDelivery(); return value; }
    catch (error: unknown) { throw op.normalize(error); }
    finally { op.finish(); }
  }
}
export class Operation {
  public readonly expires: number;
  public requestBytes = 0; public responseBytes = 0; public requests = 0; public rows = 0; public nodes = 0;
  readonly #manager: Manager; readonly #caller: AbortSignal | undefined; readonly #release: () => void;
  readonly #controller = new AbortController(); readonly #race = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #listener = (): void => { this.abort(); };
  readonly #cleaned = new WeakSet<object>();
  #setupFailed = false; #disposed = false; #finished = false; #pending = 0; #released = false; #deadlineReached = false;
  public constructor(manager: Manager, caller: AbortSignal | undefined, release: () => void) {
    this.#manager = manager; this.#caller = caller; this.#release = release;
    this.expires = performance.now() + manager.limits.timeoutMs;
    this.#timer = setTimeout(() => { this.#deadlineReached = true; this.abort(); }, manager.limits.timeoutMs);
    if (caller !== undefined) {
      try { EventTarget.prototype.addEventListener.call(caller, "abort", this.#listener, { once: true }); }
      catch { this.#setupFailed = true; }
    }
  }
  public get signal(): AbortSignal { return this.#controller.signal; }
  public get limits(): Limits { return this.#manager.limits; }
  private fresh(): void {
    if (signalAborted(this.#caller)) throw cancelled("caller");
    let expired: boolean;
    try { expired = this.#deadlineReached || performance.now() >= this.expires; }
    catch { throw failure("Snowflake operation failed"); }
    if (expired) { this.abort(); throw cancelled("deadline"); }
    if (this.#manager.closed) throw failure("Snowflake adapter closed");
    if (this.#setupFailed) throw failure("Invalid Snowflake caller signal");
  }
  public check(): void { this.fresh(); if (signalAborted(this.signal)) throw failure("Snowflake operation stopped"); }
  public abort(): void { this.#controller.abort(); this.#race.abort(); }
  private settled(): void { this.#pending--; this.release(); }
  private release(): void { if (this.#finished && this.#pending === 0 && !this.#released) { this.#released = true; this.#release(); } }
  /** Retain physical work even when its caller stops waiting. Rejections are observed. */
  public retain<T>(effect: () => T | PromiseLike<T>): Promise<T> {
    this.#pending++;
    const pending = Promise.resolve().then(effect);
    const tracked = pending.then(value => { this.settled(); return value; }, (error: unknown) => { this.settled(); throw error; });
    void tracked.catch(() => undefined); return tracked;
  }
  public async io<T>(effect: () => T | PromiseLike<T>, late?: (value: T) => void): Promise<T> {
    this.check();
    const pending = this.retain(async () => {
      this.check(); const value = await effect();
      if (this.#finished || signalAborted(this.signal) || performance.now() >= this.expires) late?.(value);
      return value;
    });
    try { const value = await raceAbort(pending, this.#race.signal, () => failure("Snowflake operation stopped")); this.check(); return value; }
    catch { this.check(); throw failure("Snowflake request failed"); }
  }
  public call<T>(effect: () => T): T {
    this.check(); try { const result = effect(); this.check(); return result; }
    catch { this.check(); throw failure("Snowflake codec failed"); }
  }
  public cleanup(resource: { cancel(): unknown } | null): void {
    if (resource === null || this.#cleaned.has(resource)) return;
    this.#cleaned.add(resource); this.#pending++;
    // Initiate while the reader is still owned. Deferring the invocation until
    // a microtask would releaseLock first and cancel only a detached reader.
    try { void Promise.resolve(resource.cancel()).then(() => { this.settled(); }, () => { this.settled(); }); }
    catch { this.settled(); }
  }
  public request(bytes: number): void {
    this.admitRequest(bytes); this.requestBytes += bytes; this.requests++;
  }
  public admitRequest(bytes: number): void {
    this.check();
    if (this.requestBytes + bytes > this.limits.maxRequestBytes || this.requests + 1 > this.limits.maxRequests || this.responseBytes >= this.limits.maxResponseBytes) throw failure("Snowflake request budget exceeded");
  }
  public response(bytes: number): void {
    this.check(); this.responseBytes += bytes;
    if (this.responseBytes > this.limits.maxResponseBytes) throw failure("Snowflake response budget exceeded");
  }
  public node(): void { this.check(); if (++this.nodes > this.limits.maxNodes) throw failure("Snowflake result work budget exceeded"); }
  private dispose(): void {
    if (this.#disposed) return; this.#disposed = true; clearTimeout(this.#timer);
    if (this.#caller !== undefined) {
      try { EventTarget.prototype.removeEventListener.call(this.#caller, "abort", this.#listener); }
      catch { this.#setupFailed = true; }
    }
  }
  public prepareDelivery(): void { this.check(); this.dispose(); this.check(); }
  public normalize(error: unknown): Error {
    this.abort(); this.dispose();
    try { this.fresh(); } catch (fresh: unknown) {
      const reason = typeof fresh === "object" && fresh !== null ? cancellations.get(fresh) : undefined;
      if (reason !== undefined) return cancelled(reason);
      return safeFailure(fresh);
    }
    return safeFailure(error);
  }
  public finish(): void { this.dispose(); this.#finished = true; this.release(); }
}
