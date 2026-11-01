import { NumberValue } from "@aws-sdk/lib-dynamodb";
import { createAbortScope, QueryCancelledError, raceAbort, type AbortScope } from "@dalgo/adapter-runtime";

const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype) as object;
function nativeGetter(prototype: object, key: string): (value: object) => unknown {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  const getter: unknown = descriptor === undefined ? undefined : Reflect.get(descriptor, "get");
  if (typeof getter !== "function") throw new TypeError("required native binary accessor is unavailable");
  return (value: object): unknown => Reflect.apply(getter, value, []);
}
const typedArrayByteLength = nativeGetter(typedArrayPrototype, "byteLength");
const typedArrayLength = nativeGetter(typedArrayPrototype, "length");
const typedArrayBuffer = nativeGetter(typedArrayPrototype, "buffer");
const arrayBufferByteLength = nativeGetter(ArrayBuffer.prototype, "byteLength");
const dataViewByteLength = nativeGetter(DataView.prototype, "byteLength");
const dataViewBuffer = nativeGetter(DataView.prototype, "buffer");
const setValuesMethod: unknown = Object.getOwnPropertyDescriptor(Set.prototype, "values")?.value;
function setValues(value: Set<unknown>): IterableIterator<unknown> {
  if (typeof setValuesMethod !== "function") throw new DynamoDbReadError("invalid-response");
  // Captured native factory + closed Set receiver establishes the iterator
  // contract; no method or iterator is read from the payload instance.
  return Reflect.apply(setValuesMethod, value, []) as IterableIterator<unknown>;
}
// Optional trusted platform feature detection, never a Node import/polyfill.
// Browser realms without Buffer still accept their ordinary typed arrays.
const platformBuffer: unknown = Reflect.get(globalThis, "Buffer");
const platformBufferPrototype: unknown = typeof platformBuffer === "function" ? platformBuffer.prototype as unknown : undefined;
const typedArrayPrototypes: readonly unknown[] = [
  Int8Array.prototype, Uint8Array.prototype, Uint8ClampedArray.prototype,
  Int16Array.prototype, Uint16Array.prototype, Int32Array.prototype,
  Uint32Array.prototype, Float32Array.prototype, Float64Array.prototype,
  BigInt64Array.prototype, BigUint64Array.prototype, platformBufferPrototype,
];

export type DynamoDbReadErrorCode = "transport" | "limit" | "invalid-response";

/** Redacted read-only boundary. Legacy mutation errors retain their old API. */
export class DynamoDbReadError extends Error {
  public readonly code: DynamoDbReadErrorCode;
  public constructor(code: DynamoDbReadErrorCode) {
    super(code === "transport" ? "DynamoDB read failed" : code === "limit"
      ? "DynamoDB read exceeds configured record, byte or work budget" : "invalid DynamoDB read response");
    this.name = "DynamoDbReadError";
    this.code = code;
  }
}

/** Limits apply after SDK decoding, never to wire allocation or codec output. */
export class DynamoDbReadOperation {
  readonly #scope: AbortScope;
  readonly #caller: AbortSignal | undefined;
  readonly #expires: number;
  readonly #maxBytes: number;
  readonly #maxRecords: number;
  #bytes = 0;
  #records = 0;
  #nodes = 0;

  public constructor(signal: AbortSignal | undefined, timeoutMs: number, maxBytes: number, maxRecords: number) {
    this.#caller = signal;
    this.#expires = performance.now() + timeoutMs;
    this.#scope = createAbortScope(signal, timeoutMs);
    this.#maxBytes = maxBytes;
    this.#maxRecords = maxRecords;
  }

  public get signal(): AbortSignal { return this.#scope.signal; }
  private cancelled(): QueryCancelledError { return new QueryCancelledError(this.#scope.deadlineExceeded ? "deadline" : "caller"); }

  public check(): void {
    if (this.signal.aborted || this.#caller?.aborted === true) throw this.cancelled();
    if (performance.now() >= this.#expires) throw new QueryCancelledError("deadline");
  }

  public async send<T>(effect: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.check();
    try {
      const value = await raceAbort(Promise.resolve(effect(this.signal)), this.signal, () => this.cancelled());
      this.check();
      return value;
    } catch {
      this.check();
      throw new DynamoDbReadError("transport");
    }
  }

  public admitRecords(count: number): void {
    this.check();
    if (!Number.isSafeInteger(count) || count < 0 || count > this.#maxRecords) throw new DynamoDbReadError("limit");
  }

  public consumeRecords(count: number): void {
    this.admitRecords(count);
    this.#records += count;
    if (this.#records > this.#maxRecords) throw new DynamoDbReadError("limit");
  }

  public account(value: unknown): void {
    try { this.measure(value, new Set<object>(), 0); }
    catch (error: unknown) {
      this.check();
      if (error instanceof DynamoDbReadError) throw error;
      throw new DynamoDbReadError("invalid-response");
    }
  }

  private bytes(count: number): void {
    this.check();
    if (count > this.#maxBytes - this.#bytes) throw new DynamoDbReadError("limit");
    this.#bytes += count;
  }

  private text(value: string): void {
    // UTF-16 length is a lower bound for UTF-8 bytes; reject before allocating
    // an encoded copy of a plainly oversized already-decoded SDK string.
    if (value.length > this.#maxBytes - this.#bytes) throw new DynamoDbReadError("limit");
    this.bytes(new TextEncoder().encode(value).byteLength + 2);
  }

  private intrinsicNumber(getter: (value: object) => unknown, value: object): number {
    const result = getter(value);
    if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) throw new DynamoDbReadError("invalid-response");
    return result;
  }

  private closedBuffer(value: object): void {
    if (Object.getPrototypeOf(value) !== ArrayBuffer.prototype || Reflect.ownKeys(value).length !== 0) throw new DynamoDbReadError("invalid-response");
  }

  private binary(value: object): void {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === ArrayBuffer.prototype) {
      this.closedBuffer(value);
      this.bytes(this.intrinsicNumber(arrayBufferByteLength, value) + 2);
      return;
    }
    const dataView = prototype === DataView.prototype;
    if (!dataView && !typedArrayPrototypes.includes(prototype)) throw new DynamoDbReadError("invalid-response");
    const length = this.intrinsicNumber(dataView ? dataViewByteLength : typedArrayByteLength, value);
    this.bytes(length + 2);
    const bufferGetter = dataView ? dataViewBuffer : typedArrayBuffer;
    const backing = bufferGetter(value);
    if (typeof backing !== "object" || backing === null) throw new DynamoDbReadError("invalid-response");
    this.closedBuffer(backing);
    const elements = dataView ? 0 : this.intrinsicNumber(typedArrayLength, value);
    // Canonical integer-indexed elements cannot be replaced by accessors.
    // Inspect only key names, not descriptors/values for every binary byte.
    for (const key of Reflect.ownKeys(value)) {
      if (dataView || typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= elements) throw new DynamoDbReadError("invalid-response");
    }
  }

  private measure(value: unknown, ancestors: Set<object>, depth: number): void {
    this.check();
    this.#nodes += 1;
    if (this.#nodes > 100_000 || depth > 64) throw new DynamoDbReadError("limit");
    if (value === null || value === undefined) { this.bytes(4); return; }
    if (typeof value === "string") { this.text(value); return; }
    if (typeof value === "boolean") { this.bytes(5); return; }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new DynamoDbReadError("invalid-response");
      this.text(String(value)); return;
    }
    if (typeof value === "bigint") { this.text(String(value)); return; }
    if (typeof value !== "object") throw new DynamoDbReadError("invalid-response");
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) { this.binary(value); return; }
    if (value instanceof NumberValue) {
      const keys = Reflect.ownKeys(value);
      const exact = Object.getOwnPropertyDescriptor(value, "value");
      if (Object.getPrototypeOf(value) !== NumberValue.prototype || keys.length !== 1 || keys[0] !== "value" || exact === undefined || !("value" in exact) || typeof exact.value !== "string") throw new DynamoDbReadError("invalid-response");
      this.text(exact.value); return;
    }
    if (ancestors.has(value)) throw new DynamoDbReadError("invalid-response");
    ancestors.add(value);
    try {
      this.bytes(2);
      if (value instanceof Set) {
        if (Object.getPrototypeOf(value) !== Set.prototype || Reflect.ownKeys(value).length !== 0) throw new DynamoDbReadError("invalid-response");
        for (const entry of setValues(value)) { this.measure(entry, ancestors, depth + 1); this.bytes(1); }
        return;
      }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new DynamoDbReadError("invalid-response");
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") throw new DynamoDbReadError("invalid-response");
        if (Array.isArray(value) && key === "length") continue;
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (property === undefined || !("value" in property)) throw new DynamoDbReadError("invalid-response");
        this.text(key);
        this.measure(property.value as unknown, ancestors, depth + 1);
        this.bytes(2);
      }
    } finally { ancestors.delete(value); }
  }

  public dispose(): void { this.#scope.dispose(); }
}
