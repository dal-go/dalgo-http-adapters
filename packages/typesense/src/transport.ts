import {
  QueryCancelledError,
  cancelQuietly,
  createAbortScope,
  raceAbort,
  type AbortScope,
} from "@dalgo/adapter-runtime";

import { TypesenseHttpError, TypesenseRequestError, TypesenseResponseSizeError } from "./errors.js";
import { TypesenseJsonNumberError, parseLosslessJson } from "./json.js";

export type TypesenseFetch = typeof globalThis.fetch;
export type TypesenseHeaders = Readonly<Record<string, string>>;
export type TypesenseHeaderProvider =
  | TypesenseHeaders
  | (() => TypesenseHeaders | Promise<TypesenseHeaders>);

const API_KEY = "x-typesense-api-key";
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "trailer",
  "upgrade",
  "proxy-connection",
  "te",
  "keep-alive",
  "accept",
  "content-type",
  "user-agent",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export function positive(value: number | undefined, fallback: number, field: string, maximum = 16_777_216): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new TypeError(`${field} must be a safe integer from 1 to ${String(maximum)}`);
  }
  return result;
}

export function nonNegative(value: number | undefined, fallback: number, field: string, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) {
    throw new TypeError(`${field} must be a safe integer from 0 to ${String(maximum)}`);
  }
  return result;
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isObject(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function controlFree(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return value.isWellFormed();
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Validates and normalises a credential-free Typesense origin. */
export function validBaseUrl(value: string, allowInsecureLoopbackHttp: boolean): string {
  const url = new URL(value.trim());
  if (url.protocol === "http:") {
    if (!isLoopback(url.hostname) || !allowInsecureLoopbackHttp) {
      throw new TypeError("baseUrl must use HTTPS; loopback HTTP requires allowInsecureLoopbackHttp: true");
    }
  } else if (url.protocol !== "https:") {
    throw new TypeError("baseUrl must use HTTPS except for explicit loopback HTTP");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    || (url.pathname !== "" && url.pathname !== "/")) {
    throw new TypeError("baseUrl must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

function headersFrom(value: unknown): TypesenseHeaders {
  if (!isPlainObject(value)) throw new TypeError("Typesense headers must be a plain object");
  const headers = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  for (const [name, headerValue] of Object.entries(value)) {
    if (name === "__proto__" || !HEADER_NAME.test(name) || typeof headerValue !== "string"
      || !/^[\t\x20-\x7e]*$/u.test(headerValue)) {
      throw new TypeError("Typesense headers must have valid names and control-free string values");
    }
    const lower = name.toLowerCase();
    if (seen.has(lower) || RESERVED_HEADERS.has(lower)) {
      throw new TypeError("Typesense headers must not duplicate or override protocol headers");
    }
    seen.add(lower);
    headers[name] = headerValue;
  }
  const keyName = Object.keys(headers).find((name) => name.toLowerCase() === API_KEY);
  if (keyName === undefined || headers[keyName] === "") {
    throw new TypeError("Typesense headers must include a non-empty X-TYPESENSE-API-KEY");
  }
  return headers;
}

interface ResponseBody {
  readonly text: string;
  readonly bytes: number;
}

export interface TypesenseOperation {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly requests: number;
  readonly bytes: number;
  check(): void;
  cancelled(): Error;
  failed(): Error;
  addBytes(bytes: number): void;
  countRequest(): void;
  dispose(): void;
}

/**
 * One operation-wide cancellation/deadline scope plus cumulative page and byte
 * counters. Every physical request of one query, batch or metadata read shares
 * it, so a large result cannot reset a budget by starting a new page.
 */
export class TypesenseTransport {
  readonly #origin: string;
  readonly #headers: TypesenseHeaderProvider | undefined;
  readonly #metadataHeaders: TypesenseHeaderProvider | undefined;
  readonly #fetch: TypesenseFetch;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxTotalBytes: number;
  readonly #root: AbortSignal;
  readonly #onDispose: (operation: TypesenseOperation) => void;

  public constructor(options: {
    readonly baseUrl: string;
    readonly allowInsecureLoopbackHttp: boolean;
    readonly headers?: TypesenseHeaderProvider;
    readonly metadataHeaders?: TypesenseHeaderProvider;
    readonly fetch?: TypesenseFetch;
    readonly timeoutMs: number;
    readonly maxRequestBytes: number;
    readonly maxResponseBytes: number;
    readonly maxTotalBytes: number;
    readonly root: AbortSignal;
    readonly onDispose: (operation: TypesenseOperation) => void;
  }) {
    this.#origin = validBaseUrl(options.baseUrl, options.allowInsecureLoopbackHttp);
    this.#headers = options.headers;
    this.#metadataHeaders = options.metadataHeaders;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs;
    this.#maxRequestBytes = options.maxRequestBytes;
    this.#maxResponseBytes = options.maxResponseBytes;
    this.#maxTotalBytes = options.maxTotalBytes;
    this.#root = options.root;
    this.#onDispose = options.onDispose;
  }

  public get origin(): string { return this.#origin; }
  public get timeoutMs(): number { return this.#timeoutMs; }

  public begin(callerSignal?: AbortSignal): TypesenseOperation {
    return new Operation(this.#timeoutMs, callerSignal, this.#root, this.#onDispose);
  }

  public async request(
    path: string,
    parameters: URLSearchParams,
    operation: TypesenseOperation,
    metadata = false,
    accepted: readonly number[] = [],
    observeHeaders?: (headers: TypesenseHeaders) => void,
  ): Promise<{ readonly status: number; readonly body: unknown; readonly bytes: number }> {
    operation.check();
    if (operation.bytes >= this.#maxTotalBytes) throw new TypesenseResponseSizeError();
    const provider = metadata ? (this.#metadataHeaders ?? this.#headers) : this.#headers;
    let supplied: unknown;
    try {
      supplied = await raceAbort(
        Promise.resolve().then(() => typeof provider === "function" ? provider() : (provider ?? {})),
        operation.signal,
        operation.cancelled,
      );
    } catch {
      if (operation.signal.aborted) throw operation.cancelled();
      throw operation.failed();
    }
    const headers = headersFrom(supplied);
    observeHeaders?.(headers);
    operation.check();
    const query = parameters.toString();
    const relative = `${path}${query.length === 0 ? "" : `?${query}`}`;
    if (byteLength(relative) > this.#maxRequestBytes) {
      throw new RangeError("Typesense request exceeds maxRequestBytes");
    }
    const pending = Promise.resolve().then(() => this.#fetch(`${this.#origin}${relative}`, {
      method: "GET",
      redirect: "error",
      headers: { ...headers, accept: "application/json" },
      signal: operation.signal,
    }));
    void pending.then((late) => { if (operation.signal.aborted) cancelQuietly(late.body); }, () => undefined);
    operation.countRequest();
    let response: Response;
    try {
      response = await raceAbort(pending, operation.signal, operation.cancelled);
    } catch {
      if (operation.signal.aborted) throw operation.cancelled();
      throw operation.failed();
    }
    if (operation.signal.aborted) {
      cancelQuietly(response.body);
      throw operation.cancelled();
    }
    const remaining = this.#maxTotalBytes - operation.bytes;
    const maximum = Math.min(this.#maxResponseBytes, remaining);
    let consumed: ResponseBody;
    try {
      consumed = await this.#read(response, maximum, operation);
    } catch (error) {
      if (operation.signal.aborted) {
        cancelQuietly(response.body);
        throw operation.cancelled();
      }
      if (error instanceof TypesenseResponseSizeError) throw error;
      throw operation.failed();
    }
    operation.addBytes(consumed.bytes);
    operation.check();
    if (!response.ok && !accepted.includes(response.status)) {
      throw new TypesenseHttpError(response.status);
    }
    let body: unknown;
    if (consumed.text.length > 0) {
      try {
        body = parseLosslessJson(consumed.text);
      } catch (error) {
        if (error instanceof TypesenseJsonNumberError) throw error;
        // The provider body must never become an error cause or message.
        // eslint-disable-next-line preserve-caught-error
        throw new TypeError("Typesense returned malformed JSON");
      }
    }
    return { status: response.status, body, bytes: consumed.bytes };
  }

  async #read(response: Response, maximum: number, operation: TypesenseOperation): Promise<ResponseBody> {
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
      cancelQuietly(response.body);
      throw new TypesenseResponseSizeError();
    }
    if (response.body === null) return { text: "", bytes: 0 };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const item = await raceAbort(reader.read(), operation.signal, operation.cancelled);
        if (item.done) break;
        total += item.value.byteLength;
        if (total > maximum) {
          cancelQuietly(reader);
          throw new TypesenseResponseSizeError();
        }
        chunks.push(item.value);
      }
    } finally {
      if (operation.signal.aborted) cancelQuietly(reader);
      try {
        reader.releaseLock();
      } catch {
        // A cancelled stream can retain its lock.
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: new TextDecoder().decode(bytes), bytes: total };
  }
}

class Operation implements TypesenseOperation {
  readonly #scope: AbortScope;
  readonly #root: AbortSignal;
  readonly #controller = new AbortController();
  readonly #onDispose: (operation: TypesenseOperation) => void;
  readonly deadlineAt: number;
  #requests = 0;
  #bytes = 0;
  #disposed = false;

  public constructor(
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
    root: AbortSignal,
    onDispose: (operation: TypesenseOperation) => void,
  ) {
    this.#root = root;
    this.#onDispose = onDispose;
    this.#scope = createAbortScope(callerSignal, timeoutMs);
    this.deadlineAt = Date.now() + timeoutMs;
    const forward = (): void => { this.#controller.abort(); };
    if (this.#scope.signal.aborted || root.aborted) this.#controller.abort();
    else {
      this.#scope.signal.addEventListener("abort", forward, { once: true });
      root.addEventListener("abort", forward, { once: true });
    }
  }

  public get signal(): AbortSignal { return this.#controller.signal; }
  public get requests(): number { return this.#requests; }
  public get bytes(): number { return this.#bytes; }

  public check(): void {
    if (this.signal.aborted || this.#root.aborted) throw this.cancelled();
    if (Date.now() >= this.deadlineAt) throw new QueryCancelledError("deadline");
  }

  public cancelled = (): Error => {
    return new QueryCancelledError(this.#scope.deadlineExceeded ? "deadline" : "caller");
  };

  public failed = (): Error => {
    return new TypesenseRequestError();
  };

  public addBytes(bytes: number): void { this.#bytes += bytes; }
  public countRequest(): void { this.#requests += 1; }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#scope.dispose();
    this.#onDispose(this);
  }
}
