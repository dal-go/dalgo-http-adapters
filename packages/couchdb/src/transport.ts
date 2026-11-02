import { cancelQuietly } from "@dalgo/adapter-runtime";
import { CouchDbOperation } from "./operation.js";

const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 15_000;

export type CouchDbFetch = typeof globalThis.fetch;
export type CouchDbHeaders = Readonly<Record<string, string>>;
export type CouchDbHeaderProvider = CouchDbHeaders | ((signal?: AbortSignal) => CouchDbHeaders | Promise<CouchDbHeaders>);

export interface CouchDbTransportOptions {
  /** Existing CouchDB database, as an HTTPS URL or loopback HTTP URL. */
  readonly databaseUrl: string;
  /** Re-evaluated for every request, for safely refreshed bearer/cookie headers. */
  readonly headers?: CouchDbHeaderProvider | undefined;
  readonly fetch?: CouchDbFetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxRequestBytes?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
}

export interface CouchDbResponse {
  readonly status: number;
  readonly body: unknown;
  /** Exact number of decoded response-body bytes, for caller-owned batch bounds. */
  readonly bytes: number;
}

export class CouchDbHttpError extends Error {
  public readonly status: number;
  public constructor(status: number) {
    super(`CouchDB request failed with HTTP ${String(status)}`);
    this.name = "CouchDbHttpError";
    this.status = status;
  }
}

/** A redacted failure while obtaining headers, following a request, or consuming a response. */
export class CouchDbRequestError extends Error {
  public constructor() {
    super("CouchDB request could not be completed");
    this.name = "CouchDbRequestError";
  }
}

/**
 * Adapter-owned response bounds failure. The message is a fixed diagnostic and
 * safe to expose; arbitrary transport RangeErrors are not preserved.
 */
export class CouchDbResponseSizeError extends RangeError {
  public constructor() {
    super("CouchDB response exceeds maxResponseBytes");
  }
}

export function positive(value: number | undefined, fallback: number, field: string, maximum = 16_777_216): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`${field} must be a safe integer from 1 to ${String(maximum)}`);
  return result;
}

export function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
export function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function assertJson(value: unknown): void {
  const seen = new Set<object>();
  let nodes = 0;
  let stringBytes = 0;
  const chargeString = (value: string): void => {
    if (value.length > 16_777_216) throw new RangeError("CouchDB JSON string byte bound exceeded");
    stringBytes += byteLength(value);
    if (stringBytes > 16_777_216) throw new RangeError("CouchDB JSON string byte bound exceeded");
  };
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 65_536 || depth > 32) throw new RangeError("CouchDB JSON structural bound exceeded");
    if (typeof entry === "string") { chargeString(entry); return; }
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry) || Object.is(entry, -0)) throw new TypeError("CouchDB JSON numbers must be finite and must not be -0");
      if (Number.isInteger(entry) && !Number.isSafeInteger(entry)) throw new TypeError("CouchDB JSON integer numbers must be safe integers");
      return;
    }
    if (typeof entry !== "object" || (!Array.isArray(entry) && !isPlainObject(entry))) throw new TypeError("CouchDB JSON values must be null, primitives, arrays, or plain records");
    if (Array.isArray(entry) && Object.getPrototypeOf(entry) !== Array.prototype) throw new TypeError("CouchDB JSON arrays must have the standard prototype");
    if (seen.has(entry)) throw new TypeError("CouchDB JSON must not contain cycles");
    seen.add(entry);
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    const names = Reflect.ownKeys(descriptors);
    if (names.length > 65_537) throw new RangeError("CouchDB JSON structural bound exceeded");
    if (Array.isArray(entry) && (entry.length > 65_536 || names.length !== entry.length + 1)) throw new TypeError("CouchDB JSON arrays must be dense with no extra properties");
    for (const name of names) {
      if (typeof name !== "string") throw new TypeError("CouchDB JSON records must have only enumerable string properties");
      if (Array.isArray(entry) && name === "length") continue;
      const descriptor = descriptors[name];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("CouchDB JSON accessors and hidden properties are not supported");
      if (Array.isArray(entry) && (!/^(0|[1-9][0-9]*)$/u.test(name) || Number(name) >= entry.length)) throw new TypeError("CouchDB JSON arrays must have only indexed values");
      chargeString(name);
      visit(descriptor.value, depth + 1);
    }
    seen.delete(entry);
  };
  visit(value, 0);
}

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

/**
 * Rejects a JSON number token that {@link JSON.parse} would silently round.
 *
 * The adapter's numeric policy is deliberately narrower than ECMAScript's:
 * every JSON number must become a finite IEEE-754 double, integer-valued
 * numbers must be safe integers, and `-0` is refused. Decimal/exponent values
 * that stay non-integer use normal IEEE-754 semantics. Malformed tokens are
 * left for `JSON.parse` to report; this scan never includes the token, a value
 * or a credential in an error message.
 */
function assertLosslessNumber(token: string): void {
  if (!JSON_NUMBER.test(token)) return;
  const value = Number(token);
  if (!Number.isFinite(value)) throw new TypeError("CouchDB returned a JSON number outside the finite range");
  if (Object.is(value, -0)) throw new TypeError("CouchDB returned a JSON -0 number");
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new TypeError("CouchDB returned a JSON integer outside the safe integer range");
  }
}

/**
 * Scans raw wire text before `JSON.parse`, so a provider value such as
 * `9007199254740993` is refused instead of being accepted as the different
 * number `9007199254740992`. Strings (including escaped quotes) are skipped.
 */
export function assertLosslessJson(text: string): void {
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x22) {
      index += 1;
      while (index < text.length) {
        const inner = text.charCodeAt(index);
        if (inner === 0x5c) { index += 2; continue; }
        index += 1;
        if (inner === 0x22) break;
      }
      continue;
    }
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) {
      const start = index;
      if (code === 0x2d) index += 1;
      while (index < text.length) {
        const digit = text.charCodeAt(index);
        if (digit < 0x30 || digit > 0x39) break;
        index += 1;
      }
      if (text.charCodeAt(index) === 0x2e) {
        index += 1;
        while (index < text.length) {
          const digit = text.charCodeAt(index);
          if (digit < 0x30 || digit > 0x39) break;
          index += 1;
        }
      }
      const exponent = text.charCodeAt(index);
      if (exponent === 0x65 || exponent === 0x45) {
        index += 1;
        const sign = text.charCodeAt(index);
        if (sign === 0x2b || sign === 0x2d) index += 1;
        while (index < text.length) {
          const digit = text.charCodeAt(index);
          if (digit < 0x30 || digit > 0x39) break;
          index += 1;
        }
      }
      assertLosslessNumber(text.slice(start, index));
      continue;
    }
    index += 1;
  }
}

export function validateHeaders(headers: CouchDbHeaders): void {
  if (!isPlainObject(headers)) throw new TypeError("CouchDB configured headers must be a plain record");
  const descriptors = Object.getOwnPropertyDescriptors(headers);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > 128) throw new RangeError("CouchDB configured headers exceed the supported bound");
  let bytes = 0; const names = new Set<string>();
  for (const key of keys) {
    if (typeof key !== "string") throw new TypeError("CouchDB configured headers must have string names");
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("CouchDB configured header accessors are not supported");
    const value: unknown = descriptor.value;
    if (typeof value !== "string" || /[\r\n]/u.test(key) || /[\r\n]/u.test(value)) throw new TypeError("CouchDB configured headers must be CR/LF-safe strings");
    if (key.length > 256 || value.length > 8192 || names.has(key.toLowerCase())) throw new RangeError("CouchDB configured headers exceed the supported bound");
    names.add(key.toLowerCase()); bytes += byteLength(key) + byteLength(value);
    if (bytes > 65_536) throw new RangeError("CouchDB configured headers exceed the supported bound");
  }
}

const disposedBodies = new WeakSet();
function discard(response: Response): void {
  const body = response.body;
  if (body === null || disposedBodies.has(body)) return;
  disposedBodies.add(body); cancelQuietly(body);
}

async function readResponse(response: Response, maximum: number, op: CouchDbOperation): Promise<{ readonly text: string; readonly bytes: number }> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) {
    discard(response); throw new CouchDbResponseSizeError();
  }
  const body = response.body;
  if (body === null) return { text: "", bytes: 0 };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = body.getReader(); }
  catch { discard(response); op.check(); throw new CouchDbRequestError(); }
  disposedBodies.add(body);
  const chunks: Uint8Array[] = []; let total = 0; let complete = false;
  try {
    // Ownership cleanup is installed before a getter can make this check fail.
    op.check();
    for (;;) {
      const next = await op.io(() => reader.read());
      if (next.done) { complete = true; break; }
      if (next.value.byteLength > maximum - total) throw new CouchDbResponseSizeError();
      op.responseBytes(next.value.byteLength);
      total += next.value.byteLength; chunks.push(next.value);
    }
    const joined = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    op.check();
    try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(joined), bytes: total }; }
    catch { throw new TypeError("CouchDB returned invalid UTF-8"); }
  } finally {
    if (!complete) cancelQuietly(reader);
    try { reader.releaseLock(); } catch { /* Best-effort owned cleanup. */ }
  }
}

/**
 * Shared CouchDB HTTP transport. Managed and native documents differ only in
 * their resource mapping; headers, redaction, request bounds and cancellation
 * are identical.
 */
export class CouchDbTransport {
  readonly #databaseUrl: string;
  readonly #headers: CouchDbHeaderProvider | undefined;
  readonly #fetch: CouchDbFetch;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;

  public constructor(options: CouchDbTransportOptions) {
    const url = new URL(options.databaseUrl.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new TypeError("databaseUrl must use HTTPS, except for loopback development");
    if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) throw new TypeError("databaseUrl must not contain credentials, a query, or a fragment");
    if (url.pathname === "/" || /\/_/u.test(url.pathname)) throw new TypeError("databaseUrl must name one existing application database, not a CouchDB management endpoint");
    this.#databaseUrl = url.toString().replace(/\/+$/u, "");
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 120_000);
    this.#maxRequestBytes = positive(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, "maxRequestBytes");
    this.#maxResponseBytes = positive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
  }

  public get databaseUrl(): string { return this.#databaseUrl; }
  public get timeoutMs(): number { return this.#timeoutMs; }

  public async within<T>(callerSignal: AbortSignal | undefined, work: (op: CouchDbOperation) => T | Promise<T>, maximumBytes = this.#maxResponseBytes, bytesError: () => Error = () => new CouchDbResponseSizeError()): Promise<T> {
    const op = new CouchDbOperation(callerSignal, this.#timeoutMs, maximumBytes, this.#maxRequestBytes, () => new CouchDbRequestError(), bytesError);
    let result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
    try { op.check(); const value = await work(op); op.check(); result = { ok: true, value }; }
    catch (error: unknown) { op.fail(); result = { ok: false, error }; }
    finally { op.dispose(); }
    try {
      op.checkCancellation();
      if (!result.ok) throw result.error;
      op.check(); op.deliver();
      return result.value;
    } catch (error: unknown) { op.fail(); op.checkCancellation(); throw error; }
  }

  public async request(
    method: string,
    path: string,
    body?: unknown,
    accepted: readonly number[] = [],
    extraHeaders: CouchDbHeaders = {},
    callerSignal?: AbortSignal,
    maximumBytes = this.#maxResponseBytes,
    onHeaders?: (headers: CouchDbHeaders) => void,
    operation?: CouchDbOperation,
  ): Promise<CouchDbResponse> {
    if (operation === undefined) return this.within(callerSignal, (op) => this.request(method, path, body, accepted, extraHeaders, op.signal, maximumBytes, onHeaders, op), maximumBytes);
    const op = operation;
    op.check();
    let serialized: string | undefined;
    if (body !== undefined) { assertJson(body); serialized = JSON.stringify(body); op.requestBytes(byteLength(serialized)); }
    const supplied = await op.io(() => typeof this.#headers === "function" ? this.#headers(op.signal) : (this.#headers ?? {}));
    validateHeaders(supplied); validateHeaders(extraHeaders);
    // Capture the checked values before any later credential-provider mutation.
    const headers = { ...supplied }; onHeaders?.(headers); op.check();
    let received: Response | undefined;
    const pending = Promise.resolve().then(() => {
      op.check();
      return this.#fetch(`${this.#databaseUrl}${path}`, { method, redirect: "error", signal: op.signal, headers: { ...headers, ...extraHeaders, accept: "application/json", ...(serialized === undefined ? {} : { "content-type": "application/json" }) }, ...(serialized === undefined ? {} : { body: serialized }) });
    }).then((response) => { received = response; if (op.stopped) discard(response); return response; });
    let response: Response;
    try { response = await op.io(() => pending); }
    catch (error: unknown) { if (received !== undefined) discard(received); throw error; }
    let readerOwnsBody = false;
    try {
      let headerBytes = 0;
      for (const [name, value] of response.headers) { headerBytes += byteLength(name) + byteLength(value); if (headerBytes > 65_536) throw new RangeError("CouchDB response headers exceed the supported bound"); }
      if (!response.ok && !accepted.includes(response.status)) throw new CouchDbHttpError(response.status);
      if (!response.ok || method === "HEAD" || method === "PUT" || method === "DELETE") { op.check(); return { status: response.status, body: undefined, bytes: 0 }; }
      readerOwnsBody = true;
      const { text, bytes } = await readResponse(response, maximumBytes, op);
      op.check();
      if (text.length === 0) return { status: response.status, body: undefined, bytes };
      assertLosslessJson(text);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new TypeError("CouchDB returned invalid JSON"); }
      assertJson(parsed); op.check();
      return { status: response.status, body: parsed, bytes };
    } finally { if (!readerOwnsBody) discard(response); }
  }
}
