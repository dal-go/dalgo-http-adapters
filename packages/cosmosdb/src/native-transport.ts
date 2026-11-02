import { decodeNativeCosmosJson, nativeCosmosNumber, type NativeCosmosJson } from "./native-json.js";
import type { NativeOperation } from "./native-operation.js";
import { NativeCosmosError, nativeHttpFailure, type NativeCosmosResponseMetadata } from "./native-types.js";

const encoder = new TextEncoder();
export function nativeBytes(text: string): number { return encoder.encode(text).byteLength; }
export function nativeHeader(value: string | null, maximum = 16_384): string | undefined {
  if (value === null || value === "") return undefined;
  if (value.length > maximum || /[^ -~]/u.test(value)) throw new NativeCosmosError("protocol");
  return value;
}
export async function nativeDigest(op: NativeOperation, fields: readonly string[]): Promise<string> {
  op.check();
  const available: unknown = Reflect.get(globalThis, "crypto");
  if (typeof available !== "object" || available === null) throw new NativeCosmosError("configuration");
  const subtle: unknown = Reflect.get(available, "subtle");
  if (typeof subtle !== "object" || subtle === null || typeof Reflect.get(subtle, "digest") !== "function") throw new NativeCosmosError("configuration");
  const encoded = fields.map(field => encoder.encode(field));
  const size = encoded.reduce((total, field) => total + 4 + field.length, 0);
  if (size > 2_097_152) throw new NativeCosmosError("bounds");
  const input = new Uint8Array(size); const view = new DataView(input.buffer); let offset = 0;
  for (const field of encoded) { view.setUint32(offset, field.length); offset += 4; input.set(field, offset); offset += field.length; }
  const digest = await op.io(() => globalThis.crypto.subtle.digest("SHA-256", input));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function metadata(headers: Headers): NativeCosmosResponseMetadata {
  const charge = headers.get("x-ms-request-charge");
  let requestCharge;
  if (charge !== null) {
    if (charge.length > 128 || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(charge) || !Number.isFinite(Number(charge)) || Number(charge) > 1e12) throw new NativeCosmosError("protocol");
    requestCharge = nativeCosmosNumber(charge);
  }
  const activityId = nativeHeader(headers.get("x-ms-activity-id"), 1024);
  const etag = nativeHeader(headers.get("etag"));
  return { ...(requestCharge === undefined ? {} : { requestCharge }), ...(activityId === undefined ? {} : { activityId }), ...(etag === undefined ? {} : { etag }) };
}
function validateHeaders(headers: Headers): void {
  let bytes = 0; let nodes = 0;
  for (const [name, value] of headers) {
    if (++nodes > 1024 || name.length + value.length > 65_536) throw new NativeCosmosError("bounds");
    bytes += nativeBytes(name) + nativeBytes(value);
    if (bytes > 65_536) throw new NativeCosmosError("bounds");
  }
}
function bytesView(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new NativeCosmosError("protocol");
  const prototype: unknown = Object.getPrototypeOf(Uint8Array.prototype);
  if (prototype === null || typeof prototype !== "object") throw new NativeCosmosError("protocol");
  const length = Object.getOwnPropertyDescriptor(prototype, "byteLength");
  const offset = Object.getOwnPropertyDescriptor(prototype, "byteOffset");
  const buffer = Object.getOwnPropertyDescriptor(prototype, "buffer");
  if (length?.get === undefined || offset?.get === undefined || buffer?.get === undefined) throw new NativeCosmosError("protocol");
  const size: unknown = length.get.call(value); const start: unknown = offset.get.call(value); const backing: unknown = buffer.get.call(value);
  if (typeof size !== "number" || typeof start !== "number" || !(backing instanceof ArrayBuffer)) throw new NativeCosmosError("protocol");
  return new Uint8Array(backing, start, size);
}
async function readBody(op: NativeOperation, response: Response): Promise<NativeCosmosJson> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let done = false; let size = 0; const chunks: Uint8Array[] = [];
  try {
    const remaining = op.limits.maxResponseBytes - op.budget.responseBytes;
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > remaining)) throw new NativeCosmosError("bounds");
    if (response.body === null) throw new NativeCosmosError("protocol");
    reader = response.body.getReader(); // Establish ownership before any post-acquisition check.
    op.check();
    for (;;) {
      const owned = reader;
      const next = await op.io(() => owned.read());
      if (next.done) { done = true; break; }
      if (chunks.length >= 65_536) throw new NativeCosmosError("bounds");
      const view = bytesView(next.value); op.response(view.byteLength); size += view.byteLength;
      chunks.push(new Uint8Array(view));
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return decodeNativeCosmosJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), () => { op.check(); });
  } finally {
    if (!done) op.cleanup(reader ?? response.body);
    if (reader !== undefined) {
      try { reader.releaseLock(); }
      catch {
        op.cleanup(reader);
        try { ReadableStreamDefaultReader.prototype.releaseLock.call(reader); } catch { /* A hostile foreign reader has no stronger native release contract. */ }
      }
    }
    op.check();
  }
}
export interface NativeResponse {
  readonly status: number; readonly body?: NativeCosmosJson; readonly metadata: NativeCosmosResponseMetadata;
  readonly continuation?: string; readonly sessionToken?: string; readonly count?: number;
}
export async function nativeResponse(op: NativeOperation, fetch: () => Response | Promise<Response>): Promise<NativeResponse> {
  let response: Response | undefined; let readerOwnsBody = false;
  try {
    response = await op.io(async () => { const value = await fetch(); response = value; return value; }, value => { op.cleanup(value.body); });
    const status = response.status;
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new NativeCosmosError("protocol");
    validateHeaders(response.headers);
    const observed = metadata(response.headers);
    const sessionToken = nativeHeader(response.headers.get("x-ms-session-token"));
    const continuation = nativeHeader(response.headers.get("x-ms-continuation"));
    const countHeader = response.headers.get("x-ms-item-count");
    let count;
    if (countHeader !== null) {
      if (!/^\d+$/u.test(countHeader) || !Number.isSafeInteger(Number(countHeader)) || Number(countHeader) > op.limits.maxRows) throw new NativeCosmosError("protocol");
      count = Number(countHeader);
    }
    const common = { status, metadata: observed, ...(sessionToken === undefined ? {} : { sessionToken }), ...(continuation === undefined ? {} : { continuation }), ...(count === undefined ? {} : { count }) };
    if (status === 404) return common;
    if (status !== 200) {
      const retry = response.headers.get("x-ms-retry-after-ms"); let retryAfterMs;
      if (retry !== null) {
        if (!/^\d+$/u.test(retry) || !Number.isSafeInteger(Number(retry)) || Number(retry) > 86_400_000) throw new NativeCosmosError("protocol");
        retryAfterMs = Number(retry);
      }
      throw nativeHttpFailure(status, observed, retryAfterMs);
    }
    // readBody owns cleanup even if getReader acquires then revokes the caller.
    readerOwnsBody = true;
    const body = await readBody(op, response);
    return { ...common, body };
  } finally {
    if (!readerOwnsBody && response !== undefined) op.cleanup(response.body);
    op.check();
  }
}
