import { QueryCancelledError, raceAbort } from "@dalgo/adapter-runtime";
import { fail, safe } from "./errors.js";
import type { AthenaCounters, AthenaLimits } from "./types.js";

export interface Limits {
  timeoutMs: number; maxConcurrent: number; maxRows: number; maxPages: number; maxRequests: number; maxPolls: number; pollIntervalMs: number;
  maxRequestBytes: number; maxInputBytes: number; maxPageBytes: number; maxResponseBytes: number; maxPageNodes: number; maxNodes: number; maxColumns: number;
  maxCursors: number; maxCursorBytes: number; maxCursorNodes: number; cursorTtlMs: number;
}
export function integer(value: unknown, min: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > maximum) throw fail("input"); return value;
}
export function limits(input: AthenaLimits): Limits {
  const n = (key: keyof AthenaLimits, fallback: number, max: number, min = 1): number => integer(input[key] ?? fallback, min, max);
  const result: Limits = {
    timeoutMs: n("timeoutMs", 30_000, 120_000), maxConcurrent: n("maxConcurrent", 4, 16), maxRows: n("maxRows", 10_000, 100_000),
    maxPages: n("maxPages", 100, 1000), maxRequests: n("maxRequests", 512, 2048), maxPolls: n("maxPolls", 100, 1000), pollIntervalMs: n("pollIntervalMs", 100, 1000, 0),
    maxRequestBytes: n("maxRequestBytes", 65_536, 262_144), maxInputBytes: n("maxInputBytes", 1_048_576, 4_194_304), maxPageBytes: n("maxPageBytes", 4_194_304, 8_388_608),
    maxResponseBytes: n("maxResponseBytes", 33_554_432, 33_554_432), maxPageNodes: n("maxPageNodes", 8192, 32_768),
    maxNodes: n("maxNodes", 65_536, 262_144), maxColumns: n("maxColumns", 256, 512), maxCursors: n("maxCursors", 128, 1000),
    maxCursorBytes: n("maxCursorBytes", 16_777_216, 16_777_216), maxCursorNodes: n("maxCursorNodes", 65_536, 65_536),
    cursorTtlMs: n("cursorTtlMs", 120_000, 120_000)
  };
  if (result.maxPageBytes + result.maxPageNodes * 16 + result.maxRequestBytes + 4096 > result.maxCursorBytes || result.maxPageNodes + 256 > result.maxCursorNodes) throw fail("configuration");
  return result;
}
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const add = EventTarget.prototype.addEventListener;
const remove = EventTarget.prototype.removeEventListener;
const cancelReasons = new WeakMap<object, "caller" | "deadline">();
export function cancelled(reason: "caller" | "deadline"): QueryCancelledError {
  const error = new QueryCancelledError(reason); cancelReasons.set(error, reason); return error;
}
export function signalAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  try { if (aborted === undefined) throw fail("input"); return Reflect.apply(aborted, signal, []) === true; } catch { throw fail("input"); }
}
export function now(): number { try { const result = performance.now(); if (!Number.isFinite(result)) throw fail("transport"); return result; } catch { throw fail("transport"); } }
export function counters(): AthenaCounters { return { requests: 0, requestBytes: 0, bytes: 0, nodes: 0, pages: 0, fetchedRows: 0, rows: 0, attempts: 0 }; }
export class Manager {
  public readonly limits: Limits;
  readonly #active = new Set<Operation>(); #closed = false;
  public constructor(options: AthenaLimits) { this.limits = limits(options); }
  public get closed(): boolean { return this.#closed; }
  public begin(signal?: AbortSignal, expires?: number): Operation {
    if (signalAborted(signal)) throw cancelled("caller");
    if (this.#closed) throw fail("closed"); if (this.#active.size >= this.limits.maxConcurrent) throw fail("busy");
    const op = new Operation(this, signal, () => { this.#active.delete(op); }, expires);
    this.#active.add(op);
    try { op.check(); return op; } catch (error) { try { throw op.failure(error); } finally { op.finish(); } }
  }
  public close(): void { this.#closed = true; for (const op of this.#active) op.abort(); }
}
/** Retains admission through physical settlement, including late body cleanup. */
export class Operation {
  public readonly started: number; public readonly expires: number; public budget: AthenaCounters = counters();
  readonly #manager: Manager; readonly #caller: AbortSignal | undefined; readonly #release: () => void; readonly #parent: Operation | undefined;
  readonly #control: boolean; readonly #controller = new AbortController(); readonly #race = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>; readonly #onCaller = (): void => { this.abort(); };
  readonly #cleaned = new WeakSet<object>(); readonly #after = new Set<() => void>();
  #finished = false; #disposed = false; #pending = 0; #released = false; #setupFailed = false; #deadlineReached = false; #pageNodes = 0;
  public constructor(manager: Manager, caller: AbortSignal | undefined, release: () => void, expires?: number, parent?: Operation, control = false) {
    this.#manager = manager; this.#caller = caller; this.#release = release; this.#parent = parent; this.#control = control;
    this.started = now(); this.expires = Math.min(this.started + (control ? 2000 : manager.limits.timeoutMs), control ? Infinity : this.started + manager.limits.cursorTtlMs, expires ?? Infinity);
    this.#timer = setTimeout(() => { this.#deadlineReached = true; this.abort(); }, Math.max(0, this.expires - now()));
    if (caller !== undefined) { try { Reflect.apply(add, caller, ["abort", this.#onCaller, { once: true }]); } catch { this.#setupFailed = true; } }
  }
  public get signal(): AbortSignal { return this.#controller.signal; }
  public get limits(): Limits { return this.#manager.limits; }
  public afterSettled(callback: () => void): void { this.#after.add(callback); }
  private fresh(expiry = this.expires): void {
    let time: number; try { time = now(); } catch (error) { if (signalAborted(this.#caller)) throw cancelled("caller"); throw error; }
    if (signalAborted(this.#caller)) throw cancelled("caller");
    if (this.#deadlineReached || time >= Math.min(this.expires, expiry)) { this.abort(); throw cancelled("deadline"); }
    if (!this.#control && this.#manager.closed) throw fail("closed");
    if (this.#setupFailed) throw fail("transport");
  }
  public check(expiry = this.expires): void {
    this.fresh(expiry);
    if (signalAborted(this.signal)) throw fail("closed");
  }
  public abort(): void { this.#controller.abort(); this.#race.abort(); }
  private start(): void { this.#pending++; this.#parent?.start(); }
  private settled(): void { this.#pending--; this.#parent?.settled(); this.release(); }
  private release(): void {
    if (this.#released || !this.#finished || this.#pending !== 0) return;
    this.#released = true; this.#release();
    for (const callback of this.#after) { try { callback(); } catch { /* Owned bookkeeping never changes a delivered outcome. */ } }
    this.#after.clear();
  }
  public retain<T>(effect: () => T | PromiseLike<T>): Promise<T> {
    this.start();
    const result = Promise.resolve().then(effect).then(value => { this.settled(); return value; }, (error: unknown) => { this.settled(); throw error; });
    void result.catch(() => undefined); return result;
  }
  public async io<T>(effect: () => T | PromiseLike<T>, late?: (value: T) => void): Promise<T> {
    this.check();
    const promise = this.retain(async () => {
      this.check(); const value = await effect();
      let stopped = this.#finished; try { this.check(); } catch { stopped = true; }
      if (stopped) late?.(value); return value;
    });
    try { const value = await raceAbort(promise, this.#race.signal, () => fail("closed")); this.check(); return value; }
    catch (error) { this.check(); throw safe(error); }
  }
  public call<T>(effect: () => T): T { this.check(); try { const value = effect(); this.check(); return value; } catch (error) { this.check(); throw safe(error); } }
  public cleanup(resource: { cancel(): unknown } | null | undefined): void {
    if (resource === null || resource === undefined || this.#cleaned.has(resource)) return;
    this.#cleaned.add(resource); this.start();
    try { void Promise.resolve(resource.cancel()).then(() => { this.settled(); }, () => { this.settled(); }); }
    catch { this.settled(); }
  }
  public control(): Operation { return new Operation(this.#manager, undefined, () => undefined, undefined, this, true); }
  public async bytes(body: ReadableStream<Uint8Array> | null, maximum = this.limits.maxPageBytes): Promise<Uint8Array> {
    if (body === null) throw fail("protocol");
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined; let complete = false; let total = 0; const chunks: Uint8Array[] = [];
    const onAbort = (): void => { this.cleanup(reader ?? body); };
    try {
      reader = body.getReader(); Reflect.apply(add, this.#race.signal, ["abort", onAbort, { once: true }]); this.check();
      for (;;) {
        const owned = reader; const value = await this.io(() => owned.read());
        if (value.done) { complete = true; break; }
        if (!(value.value instanceof Uint8Array)) throw fail("protocol");
        const prototype: object = Object.getPrototypeOf(Uint8Array.prototype) as object;
        const length = Object.getOwnPropertyDescriptor(prototype, "byteLength")?.get;
        const buffer = Object.getOwnPropertyDescriptor(prototype, "buffer")?.get;
        const offset = Object.getOwnPropertyDescriptor(prototype, "byteOffset")?.get;
        if (length === undefined || buffer === undefined || offset === undefined) throw fail("protocol");
        const size: unknown = Reflect.apply(length, value.value, []), backing: unknown = Reflect.apply(buffer, value.value, []), start: unknown = Reflect.apply(offset, value.value, []);
        if (typeof size !== "number" || !(backing instanceof ArrayBuffer) || typeof start !== "number") throw fail("protocol");
        this.budget.bytes += size; total += size;
        if (total > maximum || this.budget.bytes > this.limits.maxResponseBytes || chunks.length >= this.limits.maxPageNodes) throw fail("bounds");
        chunks.push(new Uint8Array(new Uint8Array(backing, start, size)));
      }
    } finally {
      Reflect.apply(remove, this.#race.signal, ["abort", onAbort]);
      if (!complete) this.cleanup(reader ?? body);
      if (reader !== undefined) { try { reader.releaseLock(); } catch { this.#setupFailed = true; } }
    }
    this.check(); const result = new Uint8Array(total); let at = 0; for (const chunk of chunks) { result.set(chunk, at); at += chunk.byteLength; } this.check(); return result;
  }
  public request(bytes = 0): void { this.check(); this.budget.requestBytes += bytes; if (bytes > this.limits.maxRequestBytes || this.budget.requestBytes > this.limits.maxInputBytes || ++this.budget.requests > this.limits.maxRequests) throw fail("bounds"); }
  public newDocument(): void { this.#pageNodes = 0; }
  public node(): void { this.check(); if (++this.#pageNodes > this.limits.maxPageNodes || ++this.budget.nodes > this.limits.maxNodes) throw fail("bounds"); }
  private dispose(): void {
    if (this.#disposed) return; this.#disposed = true; clearTimeout(this.#timer);
    if (this.#caller !== undefined) { try { Reflect.apply(remove, this.#caller, ["abort", this.#onCaller]); } catch { this.#setupFailed = true; } }
  }
  public prepareDelivery(): void { this.dispose(); this.check(); }
  public failure(original: unknown): Error {
    this.dispose(); this.abort();
    // Abort listeners are caller-owned and can cancel/expire this operation.
    // Classify after their synchronous cleanup, ignoring only our own abort.
    let fresh: unknown; try { this.fresh(); } catch (error) { fresh = error; }
    const candidate = fresh ?? original;
    if (candidate !== null && typeof candidate === "object") { const reason = cancelReasons.get(candidate); if (reason !== undefined) return cancelled(reason); }
    return safe(candidate);
  }
  public finish(): void { this.dispose(); this.#finished = true; this.release(); }
}
