import { QueryCancelledError, cancelQuietly, createAbortScope, raceAbort } from "@dalgo/adapter-runtime";
import { MongoReadError, type MongoReadExecutor, type MongoReadRequest, type MongoReadResult } from "./types.js";
import { aborted, jsonBytes, object, onlyKeys, positive, validateRequest } from "./validation.js";

/** Shared bounded JSON reader; a hostile/incomplete stream cannot defeat abort. */
async function readJson(body: ReadableStream<Uint8Array> | null, maximum: number, signal: AbortSignal, cancelled: () => Error): Promise<unknown> {
  if (body === null) throw new MongoReadError("protocol");
  const reader = body.getReader();
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const part = await raceAbort(reader.read(), signal, cancelled);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) throw new MongoReadError("bounds");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    cancelQuietly(reader);
    if (signal.aborted) throw cancelled();
    throw error instanceof MongoReadError ? error : new MongoReadError("protocol");
  } finally {
    // If cancellation raced an incomplete read, cancel() is intentionally not
    // awaited. Releasing that pending reader can throw and must not hide abort.
    try { reader.releaseLock(); } catch { /* Stream cleanup remains best effort. */ }
  }
}

export interface MongoHttpClientOptions {
  /** Same-origin or explicitly trusted HTTPS route; never a MongoDB URI. */
  readonly endpoint: string;
  readonly connectionId: string;
  readonly headers?: () => Promise<Readonly<Record<string, string>>> | Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

function connectionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new MongoReadError("unsupported");
}

function validateResult(value: unknown, request: MongoReadRequest): asserts value is MongoReadResult {
  if (!object(value)) throw new MongoReadError("protocol");
  if (request.kind === "discover") {
    onlyKeys(value, ["kind", "source", "collections"]);
    if (value.kind !== "collections" || value.source !== "configured" || !Array.isArray(value.collections)
      || value.collections.length > 256 || !value.collections.every((item: unknown) => typeof item === "string" && item.length <= 256)) throw new MongoReadError("protocol");
    return;
  }
  onlyKeys(value, ["kind", "documents", "nextCursor"]);
  if (value.kind !== "documents" || !Array.isArray(value.documents) || value.documents.length > request.limit
    || !value.documents.every(object) || (value.nextCursor !== undefined && (typeof value.nextCursor !== "string" || value.nextCursor.length > 32_768))
    || (request.kind === "aggregate" && value.nextCursor !== undefined)) throw new MongoReadError("protocol");
}

/** This module imports no MongoDB driver or Node builtin, including transitively. */
export class MongoHttpClient implements MongoReadExecutor {
  readonly #endpoint: string;
  readonly #connectionId: string;
  readonly #headers: MongoHttpClientOptions["headers"];
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRows: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;

  public constructor(options: MongoHttpClientOptions) {
    // Resolve relative routes only in a browser; Node callers provide a full URL.
    const url = new URL(options.endpoint, typeof location === "undefined" ? undefined : location.href);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new MongoReadError("unsupported");
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new MongoReadError("unsupported");
    connectionId(options.connectionId);
    this.#endpoint = url.toString();
    this.#connectionId = options.connectionId;
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = positive(options.timeoutMs, 30_000, 65_000);
    this.#maxRows = positive(options.maxRows, 1000, 10_000);
    this.#maxRequestBytes = positive(options.maxRequestBytes, 65_536, 1_048_576);
    this.#maxResponseBytes = positive(options.maxResponseBytes, 4_194_304, 16_777_216);
  }

  public async execute(request: MongoReadRequest, signal?: AbortSignal): Promise<MongoReadResult> {
    const scope = createAbortScope(signal, this.#timeoutMs);
    const cancelled = (): QueryCancelledError => new QueryCancelledError(scope.deadlineExceeded ? "deadline" : "caller");
    let response: Response | undefined;
    try {
      if (aborted(scope.signal)) throw cancelled();
      validateRequest(request, this.#maxRows, this.#maxRequestBytes);
      const body = jsonBytes({ connectionId: this.#connectionId, request }, this.#maxRequestBytes);
      const provided = await raceAbort(Promise.resolve().then(() => this.#headers?.()), scope.signal, cancelled);
      const headers = new Headers(provided);
      headers.set("content-type", "application/json"); headers.set("accept", "application/json");
      const pending = Promise.resolve().then(() => this.#fetch(this.#endpoint, {
        method: "POST", headers, body, signal: scope.signal, redirect: "error", credentials: "same-origin", cache: "no-store",
      }));
      void pending.then((late) => { if (aborted(scope.signal)) cancelQuietly(late.body); }, () => undefined);
      response = await raceAbort(pending, scope.signal, cancelled);
      if (!response.ok) {
        if (response.status === 408) {
          const value = await readJson(response.body, this.#maxResponseBytes, scope.signal, cancelled);
          if (!object(value)) throw new MongoReadError("protocol");
          onlyKeys(value, ["error", "reason"]);
          if (value.error !== "cancelled" || (value.reason !== "caller" && value.reason !== "deadline")) throw new MongoReadError("protocol");
          throw new QueryCancelledError(value.reason);
        }
        cancelQuietly(response.body);
        if (response.status === 401) throw new MongoReadError("authentication");
        if (response.status === 403) throw new MongoReadError("permission");
        if (response.status === 413) throw new MongoReadError("bounds");
        throw new MongoReadError("transport");
      }
      if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new MongoReadError("protocol");
      const result = await readJson(response.body, this.#maxResponseBytes, scope.signal, cancelled);
      validateResult(result, request);
      if (aborted(scope.signal)) throw cancelled();
      return result;
    } catch (error) {
      cancelQuietly(response?.body);
      if (aborted(scope.signal)) throw cancelled();
      throw error instanceof MongoReadError || error instanceof QueryCancelledError ? error : new MongoReadError("transport");
    } finally { scope.dispose(); }
  }
}

export interface MongoHttpHandlerOptions {
  /**
   * Mandatory authorization boundary. Verify the user, origin/CSRF and connection
   * permission here, returning that user's preconfigured read-only executor.
   * Never construct an executor from client URLs/credentials. Return undefined
   * for denied access. No default executor or anonymous fallback exists.
   */
  readonly authorize: (request: Request, connectionId: string, signal: AbortSignal) => Promise<MongoReadExecutor | undefined>;
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

function reply(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** Trusted server mounting hook; host authentication/authorization is mandatory. */
export function createMongoHttpHandler(options: MongoHttpHandlerOptions): (request: Request) => Promise<Response> {
  if (typeof options.authorize !== "function") throw new MongoReadError("permission");
  const timeoutMs = positive(options.timeoutMs, 30_000, 65_000);
  const maxRows = positive(options.maxRows, 1000, 10_000);
  const maxRequestBytes = positive(options.maxRequestBytes, 65_536, 1_048_576);
  const maxResponseBytes = positive(options.maxResponseBytes, 4_194_304, 16_777_216);
  return async (request) => {
    if (request.method !== "POST") return reply(405, { error: "method" });
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return reply(415, { error: "content-type" });
    const scope = createAbortScope(request.signal, timeoutMs);
    const cancelled = (): QueryCancelledError => new QueryCancelledError(scope.deadlineExceeded ? "deadline" : "caller");
    try {
      if (aborted(scope.signal)) throw cancelled();
      const body = await readJson(request.body, maxRequestBytes, scope.signal, cancelled);
      if (!object(body)) throw new MongoReadError("unsupported");
      onlyKeys(body, ["connectionId", "request"]);
      connectionId(body.connectionId);
      validateRequest(body.request, maxRows, maxRequestBytes);
      const executor = await raceAbort(Promise.resolve().then(() => options.authorize(request, body.connectionId as string, scope.signal)), scope.signal, cancelled);
      if (executor === undefined) return reply(403, { error: "permission" });
      const result = await raceAbort(executor.execute(body.request, scope.signal), scope.signal, cancelled);
      validateResult(result, body.request);
      jsonBytes(result, maxResponseBytes);
      if (aborted(scope.signal)) throw cancelled();
      return reply(200, result);
    } catch (error) {
      if (aborted(scope.signal) || error instanceof QueryCancelledError) {
        const reason = aborted(scope.signal) ? scope.deadlineExceeded ? "deadline" : "caller"
          : error instanceof QueryCancelledError && error.reason === "caller" ? "caller" : "deadline";
        return reply(408, { error: "cancelled", reason });
      }
      const code = error instanceof MongoReadError ? error.code : "transport";
      return reply(code === "authentication" ? 401 : code === "permission" ? 403 : code === "bounds" ? 413 : code === "unsupported" || code === "protocol" ? 400 : 502, { error: code });
    } finally { scope.dispose(); }
  };
}
