import {
  QueryCancelledError,
  cancelQuietly,
  createAbortScope,
  raceAbort,
} from "@dalgo/adapter-runtime";

const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 15_000;

export type CouchDbFetch = typeof globalThis.fetch;
export type CouchDbHeaders = Readonly<Record<string, string>>;
export type CouchDbHeaderProvider = CouchDbHeaders | (() => CouchDbHeaders | Promise<CouchDbHeaders>);

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

export function assertJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("CouchDB JSON numbers must be finite and not -0");
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("CouchDB JSON must not contain cycles");
    seen.add(value); for (const entry of value) assertJson(entry, seen); seen.delete(value); return;
  }
  if (!isPlainObject(value)) throw new TypeError("CouchDB JSON values must be plain objects, arrays, or primitives");
  if (seen.has(value)) throw new TypeError("CouchDB JSON must not contain cycles");
  seen.add(value); for (const entry of Object.values(value)) assertJson(entry, seen); seen.delete(value);
}

export function validateHeaders(headers: CouchDbHeaders): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string" || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) throw new TypeError("CouchDB configured headers must be CR/LF-safe strings");
  }
}

async function readResponse(response: Response, maximum: number, signal: AbortSignal, cancelled: () => Error): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
    cancelQuietly(response.body); throw new CouchDbResponseSizeError();
  }
  if (response.body === null) return "";
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const next = await raceAbort(reader.read(), signal, cancelled);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) { cancelQuietly(reader); throw new CouchDbResponseSizeError(); }
      chunks.push(next.value);
    }
  } finally {
    if (signal.aborted) cancelQuietly(reader);
    try { reader.releaseLock(); } catch { /* a cancelled stream can retain its lock */ }
  }
  const joined = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
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

  public async request(
    method: string,
    path: string,
    body?: unknown,
    accepted: readonly number[] = [],
    extraHeaders: CouchDbHeaders = {},
    callerSignal?: AbortSignal,
    maximumBytes = this.#maxResponseBytes,
    onHeaders?: (headers: CouchDbHeaders) => void,
  ): Promise<CouchDbResponse> {
    const scope = createAbortScope(callerSignal, this.#timeoutMs);
    const cancelled = (): Error => callerSignal === undefined
      ? new DOMException("The operation was aborted.", "AbortError")
      : new QueryCancelledError(scope.deadlineExceeded ? "deadline" : "caller");
    const bodyCancelled = (): Error => callerSignal === undefined
      ? new Error("CouchDB response timed out")
      : cancelled();
    try {
      let supplied: CouchDbHeaders;
      try {
        supplied = await raceAbort(
          Promise.resolve().then(() => typeof this.#headers === "function" ? this.#headers() : (this.#headers ?? {})),
          scope.signal,
          cancelled,
        );
      } catch (error) {
        if (scope.signal.aborted) throw cancelled();
        if (callerSignal !== undefined) throw new CouchDbRequestError();
        throw error;
      }
      validateHeaders(supplied); validateHeaders(extraHeaders);
      if (scope.signal.aborted) throw cancelled();
      onHeaders?.(supplied);
      let serialized: string | undefined;
      if (body !== undefined) { assertJson(body); serialized = JSON.stringify(body); if (byteLength(serialized) > this.#maxRequestBytes) throw new RangeError("CouchDB request exceeds maxRequestBytes"); }
      const pending = Promise.resolve().then(() => this.#fetch(`${this.#databaseUrl}${path}`, { method, redirect: "error", signal: scope.signal, headers: { ...supplied, ...extraHeaders, accept: "application/json", ...(serialized === undefined ? {} : { "content-type": "application/json" }) }, ...(serialized === undefined ? {} : { body: serialized }) }));
      void pending.then((late) => { if (scope.signal.aborted) cancelQuietly(late.body); }, () => undefined);
      let response: Response;
      try {
        response = await raceAbort(pending, scope.signal, cancelled);
      } catch (error) {
        if (scope.signal.aborted) throw cancelled();
        if (callerSignal !== undefined) throw new CouchDbRequestError();
        throw error;
      }
      let text: string;
      try {
        text = await readResponse(response, maximumBytes, scope.signal, bodyCancelled);
      } catch (error) {
        if (scope.signal.aborted) {
          if (callerSignal === undefined) throw error;
          cancelQuietly(response.body); throw cancelled();
        }
        if (callerSignal !== undefined && !(error instanceof CouchDbResponseSizeError)) throw new CouchDbRequestError();
        throw error;
      }
      if (scope.signal.aborted) throw cancelled();
      if (!response.ok && !accepted.includes(response.status)) throw new CouchDbHttpError(response.status);
      if (text.length === 0) return { status: response.status, body: undefined };
      try { return { status: response.status, body: JSON.parse(text) }; } catch { throw new TypeError("CouchDB returned invalid JSON"); }
    } finally { scope.dispose(); }
  }
}
