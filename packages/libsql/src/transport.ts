import { cancelQuietly, raceAbort } from "@dalgo/adapter-runtime";

import { LibSQLHttpError, LibSQLPipelineError, LibSQLRequestError } from "./errors.js";
import type { LibSQLFetch, LibSQLHeadersProvider } from "./types.js";
import type { LibSQLScalar } from "./sql.js";

export type HranaValue =
  | { readonly type: "null" }
  | { readonly type: "integer"; readonly value: string }
  | { readonly type: "float"; readonly value: number | null }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "blob"; readonly base64: string };

export interface HranaColumn { readonly name?: unknown; }
export interface HranaStatementResult {
  readonly cols?: unknown;
  readonly rows?: unknown;
  readonly affected_row_count?: unknown;
}

export type HranaStatementOutcome =
  | { readonly ok: true; readonly result: HranaStatementResult }
  | { readonly ok: false; readonly code: string | undefined; readonly extendedCode: string | undefined };

export interface PipelineOutcome {
  readonly outcomes: readonly HranaStatementOutcome[];
  /** The memory-only header set actually sent, after provider resolution and validation. */
  readonly headers: Readonly<Record<string, string>>;
  /** Actual decoded response body bytes. */
  readonly bytes: number;
}

export interface HranaStatement {
  readonly sql: string;
  readonly args: readonly LibSQLScalar[];
  readonly wantRows: boolean;
}

/** Operation-wide cancellation context shared by header, fetch, body and page work. */
export interface RequestContext {
  readonly signal: AbortSignal;
  /** Never copies `AbortSignal.reason` or a transport error. */
  cancelled(): Error;
  /** Redacted non-cancellation transport failure. */
  failed(): Error;
}

interface PipelineErrorBody { readonly code?: unknown; readonly extended_code?: unknown; }
interface PipelineResultBody { readonly type?: unknown; readonly response?: unknown; readonly error?: unknown; }
interface PipelineResponseBody { readonly baton?: unknown; readonly results?: unknown; }

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Validates and normalises a credential-free server origin. */
export function validBaseUrl(value: string, allowInsecureLoopbackHttp: boolean): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new TypeError("serverUrl must be an absolute URL"); }
  if (url.protocol === "http:") {
    if (!isLoopback(url.hostname) || !allowInsecureLoopbackHttp) {
      throw new TypeError("serverUrl must use HTTPS; loopback HTTP requires allowInsecureLoopbackHttp: true");
    }
  } else if (url.protocol !== "https:") {
    throw new TypeError("serverUrl must use HTTPS except for explicit loopback HTTP");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.pathname !== "" && url.pathname !== "/")) {
    throw new TypeError("serverUrl must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

export function headersFrom(value: Readonly<Record<string, string>>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || typeof headerValue !== "string" || /[\r\n]/u.test(headerValue)) {
      throw new TypeError("headers must have valid names and newline-free values");
    }
    headers[name] = headerValue;
  }
  return headers;
}

export function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z0-9_]{1,64}$/u.test(value) ? value : undefined;
}

function parsePipelineJson(body: string): unknown {
  try { return JSON.parse(body) as unknown; } catch { throw new TypeError("malformed libSQL JSON response"); }
}

function pipelineOutcomes(value: unknown, statements: number): readonly HranaStatementOutcome[] {
  if (!isObject(value)) throw new TypeError("malformed libSQL pipeline response");
  const response = value as PipelineResponseBody;
  if (response.baton !== null) throw new TypeError("malformed libSQL pipeline baton");
  const results = response.results;
  if (!Array.isArray(results) || results.length !== statements + 1) throw new TypeError("malformed libSQL pipeline response");
  const close = results[results.length - 1] as PipelineResultBody | undefined;
  if (!isObject(close) || close.type !== "ok" || !isObject(close.response) || close.response.type !== "close") {
    throw new TypeError("malformed libSQL close response");
  }
  const outcomes: HranaStatementOutcome[] = [];
  for (let index = 0; index < statements; index += 1) {
    const result = results[index] as PipelineResultBody | undefined;
    if (!isObject(result)) throw new TypeError("malformed libSQL pipeline result");
    if (result.type === "error") {
      const error = isObject(result.error) ? result.error as PipelineErrorBody : {};
      outcomes.push({ ok: false, code: safeCode(error.code), extendedCode: safeCode(error.extended_code) });
      continue;
    }
    if (result.type !== "ok" || !isObject(result.response) || result.response.type !== "execute" || !isObject(result.response.result)) {
      throw new TypeError("malformed libSQL execute response");
    }
    outcomes.push({ ok: true, result: result.response.result as HranaStatementResult });
  }
  return outcomes;
}

/** Throws the redacted in-band failure for a statement the caller requires to succeed. */
export function requireStatement(outcome: HranaStatementOutcome): HranaStatementResult {
  if (!outcome.ok) throw new LibSQLPipelineError(outcome.code, outcome.extendedCode);
  return outcome.result;
}

/**
 * One JSON Hrana v3 pipeline transport. Every request is close-terminated, uses
 * `redirect: "error"`, and is bounded in request and response bytes. It never
 * stores credentials: the header provider is resolved for each request and the
 * resolved headers can be observed only for cursor-scope binding.
 */
export class LibSQLTransport {
  readonly #origin: string;
  readonly #headers: LibSQLHeadersProvider | undefined;
  readonly #fetch: LibSQLFetch;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;

  public constructor(options: {
    readonly origin: string;
    readonly headers?: LibSQLHeadersProvider;
    readonly fetch: LibSQLFetch;
    readonly maxRequestBytes: number;
    readonly maxResponseBytes: number;
  }) {
    this.#origin = options.origin;
    this.#headers = options.headers;
    this.#fetch = options.fetch;
    this.#maxRequestBytes = options.maxRequestBytes;
    this.#maxResponseBytes = options.maxResponseBytes;
  }

  public get origin(): string { return this.#origin; }

  public async pipeline(
    statements: readonly HranaStatement[],
    context: RequestContext,
    observeHeaders?: (headers: Readonly<Record<string, string>>) => void,
    maximumResponseBytes = this.#maxResponseBytes,
  ): Promise<PipelineOutcome> {
    let provided: Readonly<Record<string, string>> | undefined;
    try {
      provided = await raceAbort(
        Promise.resolve().then(() => this.#headers?.()),
        context.signal,
        context.cancelled,
      );
    } catch {
      if (context.signal.aborted) throw context.cancelled();
      throw context.failed();
    }
    if (provided !== undefined && !isObject(provided)) throw new TypeError("headers must return an object");
    const headers = provided === undefined ? {} : headersFrom(provided);
    observeHeaders?.(headers);
    const body = JSON.stringify({
      baton: null,
      requests: [
        ...statements.map((statement) => ({
          type: "execute",
          stmt: {
            sql: statement.sql,
            args: statement.args.map((value) => encodedValue(value)),
            want_rows: statement.wantRows,
          },
        })),
        { type: "close" },
      ],
    });
    if (new TextEncoder().encode(body).byteLength > this.#maxRequestBytes) {
      throw new RangeError("libSQL request exceeds maxRequestBytes");
    }
    if (context.signal.aborted) throw context.cancelled();
    const pending = Promise.resolve().then(() => this.#fetch(`${this.#origin}/v3/pipeline`, {
      method: "POST",
      redirect: "error",
      signal: context.signal,
      headers: { ...headers, accept: "application/json", "content-type": "application/json" },
      body,
    }));
    void pending.then((late) => { if (context.signal.aborted) cancelQuietly(late.body); }, () => undefined);
    let response: Response;
    try {
      response = await raceAbort(pending, context.signal, context.cancelled);
    } catch (error) {
      if (context.signal.aborted) throw context.cancelled();
      if (error instanceof LibSQLHttpError) throw error;
      throw context.failed();
    }
    if (!response.ok) {
      cancelQuietly(response.body);
      throw new LibSQLHttpError(response.status);
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximumResponseBytes)) {
      cancelQuietly(response.body);
      throw new RangeError("libSQL response exceeds maxResponseBytes");
    }
    const bodyAndBytes = await this.readBoundedBody(response, context, maximumResponseBytes);
    return { outcomes: pipelineOutcomes(parsePipelineJson(bodyAndBytes.text), statements.length), headers, bytes: bodyAndBytes.bytes };
  }

  private async readBoundedBody(response: Response, context: RequestContext, maximum: number): Promise<{ readonly text: string; readonly bytes: number }> {
    if (response.body === null) throw new TypeError("libSQL response was unexpectedly empty");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await raceAbort(reader.read(), context.signal, context.cancelled);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maximum) {
          cancelQuietly(reader);
          throw new RangeError("libSQL response exceeds maxResponseBytes");
        }
        chunks.push(next.value);
      }
    } catch (error) {
      if (context.signal.aborted) throw context.cancelled();
      if (error instanceof RangeError) throw error;
      throw context.failed();
    } finally {
      if (context.signal.aborted) cancelQuietly(reader);
      try { reader.releaseLock(); } catch { /* A mocked stream can retain a pending read after deadline expiry. */ }
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(output), bytes: size };
    } catch {
      throw new TypeError("malformed libSQL UTF-8 response");
    }
  }
}

export function encodedValue(value: LibSQLScalar): HranaValue {
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "text", value };
  if (typeof value === "boolean") return { type: "integer", value: value ? "1" : "0" };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("libSQL numbers must be finite");
    if (Number.isInteger(value)) return { type: "integer", value: String(value) };
    return { type: "float", value };
  }
  throw new TypeError("malformed libSQL bind value");
}

/** Decodes one Hrana scalar without ever coercing a text, blob or unsafe integer. */
export function decodedValue(value: unknown): LibSQLScalar {
  if (!isObject(value) || typeof value.type !== "string") throw new TypeError("malformed libSQL result value");
  switch (value.type) {
    case "null": return null;
    case "text": if (typeof value.value === "string") return value.value; break;
    case "integer": {
      if (typeof value.value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(value.value)) break;
      const integer = Number(value.value);
      if (!Number.isSafeInteger(integer)) {
        throw new RangeError("libSQL result integer is outside JavaScript safe-integer range");
      }
      if (Object.is(integer, -0)) throw new RangeError("libSQL result integer must not be negative zero");
      return integer;
    }
    case "float":
      if (typeof value.value === "number" && Number.isFinite(value.value)) return value.value;
      break;
    case "blob":
      throw new RangeError("libSQL blob values are not supported by this adapter");
  }
  throw new TypeError("libSQL returned an unsupported mapped value");
}

export { LibSQLRequestError };
