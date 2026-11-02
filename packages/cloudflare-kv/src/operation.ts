import { QueryCancelledError, createAbortScope, raceAbort } from "@dalgo/adapter-runtime";
import { UnsupportedError } from "@dalgo/core";
import { CloudflareKvError, type KvLimits } from "./types.js";
import { positive } from "./validation.js";

export interface Limits {
  readonly timeoutMs: number; readonly maxConcurrent: number; readonly maxKeys: number;
  readonly maxRows: number; readonly maxPages: number; readonly maxRequests: number;
  readonly maxValueBytes: number; readonly maxResponseBytes: number; readonly maxRequestBytes: number;
  readonly maxCursors: number; readonly maxCursorBytes: number; readonly maxCursorNodes: number; readonly cursorTtlMs: number;
}
export function limits(input: KvLimits): Limits {
  return {
    timeoutMs: positive(input.timeoutMs, 30_000, 120_000), maxConcurrent: positive(input.maxConcurrent, 4, 16),
    maxKeys: positive(input.maxKeys, 100, 1000), maxRows: positive(input.maxRows, 1000, 10_000),
    maxPages: positive(input.maxPages, 100, 1000), maxRequests: positive(input.maxRequests, 100, 1000),
    maxValueBytes: positive(input.maxValueBytes, 4_194_304, 26_214_400), maxResponseBytes: positive(input.maxResponseBytes, 16_777_216, 33_554_432),
    maxRequestBytes: positive(input.maxRequestBytes, 65_536, 1_048_576), maxCursors: positive(input.maxCursors, 128, 1000),
    maxCursorBytes: positive(input.maxCursorBytes, 16_777_216, 16_777_216), maxCursorNodes: positive(input.maxCursorNodes, 65_536, 65_536),
    cursorTtlMs: positive(input.cursorTtlMs, 300_000, 600_000),
  };
}
export interface Budget { bytes: number; rows: number; requests: number; pages: number; failed: boolean }
export function budget(): Budget { return { bytes: 0, rows: 0, requests: 0, pages: 0, failed: false }; }

function chunkView(value: unknown): { backing: ArrayBuffer; size: number; offset: number } {
  if (!ArrayBuffer.isView(value) || !(value instanceof Uint8Array)) throw new CloudflareKvError("protocol");
  const prototype: unknown = Object.getPrototypeOf(Uint8Array.prototype);
  if (prototype === null || typeof prototype !== "object") throw new CloudflareKvError("protocol");
  const lengthDescriptor = Object.getOwnPropertyDescriptor(prototype, "byteLength");
  const offsetDescriptor = Object.getOwnPropertyDescriptor(prototype, "byteOffset");
  const bufferDescriptor = Object.getOwnPropertyDescriptor(prototype, "buffer");
  if (typeof lengthDescriptor?.get !== "function" || typeof offsetDescriptor?.get !== "function" || typeof bufferDescriptor?.get !== "function") throw new CloudflareKvError("protocol");
  const size: unknown = lengthDescriptor.get.call(value);
  const offset: unknown = offsetDescriptor.get.call(value);
  const backing: unknown = bufferDescriptor.get.call(value);
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || !(backing instanceof ArrayBuffer)) throw new CloudflareKvError("protocol");
  return { backing, size, offset };
}

/** Admission remains occupied while ignored foreign promises/cleanup still run. */
export class Manager {
  public readonly limits: Limits;
  readonly #active = new Set<Operation>();
  #closed = false;
  public constructor(input: KvLimits) { this.limits = limits(input); }
  public get closed(): boolean { return this.#closed; }
  public begin(signal?: AbortSignal, parent?: Operation): Operation {
    if (this.#closed) throw new CloudflareKvError("closed");
    if (this.#active.size >= this.limits.maxConcurrent) throw new CloudflareKvError("busy");
    const operation = new Operation(this, signal, () => { this.#active.delete(operation); }, parent);
    this.#active.add(operation);
    try { operation.check(); return operation; }
    catch (error) { try { throw operation.failure(error); } finally { operation.finish(); } }
  }
  public close(): void { this.#closed = true; for (const operation of this.#active) operation.abort(); }
}

export class Operation {
  public budget: Budget = budget();
  readonly #manager: Manager;
  readonly #controller = new AbortController();
  // Foreign code receives scope.signal. Keep our race/reader listener methods
  // on a separate native signal which that code cannot replace or instrument.
  readonly #raceController = new AbortController();
  readonly #scope;
  readonly #caller: AbortSignal | undefined;
  readonly #onCaller: () => void;
  readonly #onScope: () => void;
  readonly #deadline: number;
  readonly #release: () => void;
  readonly #parent: Operation | undefined;
  readonly #cleaned = new WeakSet();
  readonly #after = new Set<() => void>();
  #attached = false;
  #disposed = false;
  #cleanupFailed = false;
  #setupFailed = false;
  #pending = 0;
  #finished = false;
  #released = false;
  public constructor(manager: Manager, caller: AbortSignal | undefined, release: () => void, parent?: Operation) {
    this.#manager = manager; this.#caller = caller; this.#release = release; this.#parent = parent;
    this.#deadline = performance.now() + manager.limits.timeoutMs;
    this.#onCaller = () => { this.#controller.abort(); };
    this.#onScope = () => { this.#raceController.abort(); };
    this.#scope = createAbortScope(this.#controller.signal, manager.limits.timeoutMs);
    this.#scope.signal.addEventListener("abort", this.#onScope, { once: true });
    if (caller?.aborted === true) this.#controller.abort();
    else if (caller !== undefined) {
      this.#attached = true;
      try { caller.addEventListener("abort", this.#onCaller, { once: true }); }
      catch { this.#setupFailed = true; }
    }
  }
  public get signal(): AbortSignal { return this.#scope.signal; }
  public get limits(): Limits { return this.#manager.limits; }
  public checkCancellation(): void {
    this.#parent?.checkCancellation();
    if (this.#caller?.aborted === true) throw new QueryCancelledError("caller");
    if (performance.now() >= this.#deadline || this.#scope.deadlineExceeded) { this.#controller.abort(); throw new QueryCancelledError("deadline"); }
    if (this.#manager.closed) throw new CloudflareKvError("closed");
  }
  public check(): void {
    this.checkCancellation();
    if (this.#setupFailed) throw new CloudflareKvError("transport");
    if (this.signal.aborted || this.#finished) throw new CloudflareKvError("closed");
  }
  public abort(): void { this.#controller.abort(); this.#raceController.abort(); }
  public afterSettled(callback: () => void): void { this.#after.add(callback); }
  private release(): void {
    if (!this.#finished || this.#pending !== 0 || this.#released) return;
    this.#released = true; this.#release();
    for (const callback of this.#after) { try { callback(); } catch { /* Owned bookkeeping must never replace a delivered failure. */ } }
    this.#after.clear();
  }
  private settled(): void { this.#pending--; this.release(); }
  public async foreign<T>(callback: () => T | PromiseLike<T>, late?: (value: T) => void): Promise<T> {
    this.check(); if (this.#disposed) throw new CloudflareKvError("closed"); this.#pending++;
    const pending = Promise.resolve().then(() => { this.check(); return callback(); });
    // Both branches own settlement even if the caller stops waiting. Late
    // resources are claimed before decrementing the retained lease.
    const tracked = pending.then((value) => {
      try { if (this.#finished || this.signal.aborted || performance.now() >= this.#deadline) late?.(value); }
      finally { this.settled(); }
      return value;
    }, (error: unknown) => { this.settled(); throw error; });
    const value = await raceAbort(tracked, this.#raceController.signal, () => { try { this.check(); } catch (error) { return error instanceof Error ? error : new CloudflareKvError("transport"); } return new CloudflareKvError("closed"); });
    this.check(); return value;
  }
  public cleanup(resource: { cancel(): unknown } | null | undefined): void {
    if (resource === null || resource === undefined || this.#cleaned.has(resource)) return;
    this.#cleaned.add(resource); this.#pending++;
    try { void Promise.resolve(resource.cancel()).then(() => { this.settled(); }, () => { this.settled(); }); }
    catch { this.settled(); }
  }
  public charge(bytes: number): void {
    this.check(); this.budget.bytes += bytes;
    if (this.budget.failed || !Number.isSafeInteger(bytes) || bytes < 0 || this.budget.bytes > this.limits.maxResponseBytes) this.exhaust();
  }
  public exhaust(): never { this.budget.failed = true; throw new CloudflareKvError("bounds"); }
  public request(): void { this.check(); if (this.budget.failed || this.budget.bytes >= this.limits.maxResponseBytes || ++this.budget.requests > this.limits.maxRequests) throw new CloudflareKvError("bounds"); }
  public rows(amount: number): void { this.check(); this.budget.rows += amount; if (this.budget.rows > this.limits.maxRows) throw new CloudflareKvError("bounds"); }
  public async bytes(stream: ReadableStream<Uint8Array> | null, maximum: number): Promise<Uint8Array> {
    if (stream === null) throw new CloudflareKvError("protocol");
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    const abort = (): void => { this.cleanup(reader ?? stream); };
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      reader = stream.getReader();
      this.#raceController.signal.addEventListener("abort", abort, { once: true });
      this.check();
      for (;;) {
        const owned = reader;
        const part = await this.foreign(() => owned.read());
        this.check();
        if (part.done) { complete = true; break; }
        // Capture bytes with intrinsic native accessors, without a payload
        // iterator, shadowed byteLength or subclass species constructor.
        const { backing, size, offset } = chunkView(part.value);
        this.charge(size);
        if (size > maximum - total) this.exhaust();
        total += size;
        chunks.push(new Uint8Array(new Uint8Array(backing, offset, size)));
      }
    } finally {
      this.removeOwned(this.#raceController.signal, abort);
      if (!complete) this.cleanup(reader ?? stream);
      if (reader !== undefined) { try { reader.releaseLock(); } catch { if (complete) this.#cleanupFailed = true; } }
    }
    this.check(); const result = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    this.check(); return result;
  }
  private removeOwned(signal: AbortSignal, callback: () => void): void {
    try { signal.removeEventListener("abort", callback); }
    catch {
      this.#cleanupFailed = true;
      // Preserve native removal even if a delegating override throws, without
      // invoking it twice or removing any application-owned listener.
      try { EventTarget.prototype.removeEventListener.call(signal, "abort", callback); } catch { /* Owned timer/lease disposal must continue. */ }
    }
  }
  private disposeOwned(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#attached && this.#caller !== undefined) {
      this.#attached = false;
      this.removeOwned(this.#caller, this.#onCaller);
    }
    this.removeOwned(this.#scope.signal, this.#onScope);
    try { this.#scope.dispose(); } catch { this.#cleanupFailed = true; }
  }
  /** All caller-owned cleanup callbacks run before the final success/ACK. */
  public prepareDelivery(): void {
    this.disposeOwned(); this.#parent?.prepareDelivery(); this.check();
    if (this.#cleanupFailed) throw new CloudflareKvError("transport");
  }
  /** Preserve the original safe failure, then prefer fresh cancellation/Close. */
  public failure(original: unknown): Error {
    this.abort(); this.disposeOwned(); const failure = safe(original); this.checkCancellation(); return failure;
  }
  public finish(): void {
    this.disposeOwned(); this.#finished = true; this.release();
  }
}

export function safe(error: unknown): Error {
  // Even a callback throwing a public error class must not smuggle a mutated
  // message/cause or arbitrary runtime code through the redaction boundary.
  try {
    if (error instanceof QueryCancelledError) return new QueryCancelledError(error.reason === "caller" ? "caller" : "deadline");
    if (error instanceof UnsupportedError) return new UnsupportedError("Cloudflare KV capability");
    if (error instanceof CloudflareKvError) {
      const codes = ["configuration", "input", "permission", "authentication", "bounds", "protocol", "transport", "http", "closed", "busy"] as const;
      const candidate: unknown = error.code;
      const code = codes.find((item) => item === candidate) ?? "transport";
      const status: unknown = error.status;
      return new CloudflareKvError(code, typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined);
    }
  } catch { /* Callback-owned error accessors are also untrusted. */ }
  return new CloudflareKvError("transport");
}
