import { cancelQuietly, createAbortScope, QueryCancelledError, raceAbort } from "@dalgo/adapter-runtime";
import type { Value } from "convex/values";
import { ConvexReadError, type ConvexOptions } from "./types.js";
import { decodeValue, encoded, fail, fields, parseJSON, positive } from "./validation.js";

export interface Limits {
  timeoutMs: number; maxRows: number; maxGetManyKeys: number; maxPages: number;
  maxResponseBytes: number; maxRequestBytes: number; maxTotalRequestBytes: number;
  maxWorkRows: number; maximumRowsRead: number; maximumBytesRead: number;
  maxConcurrent: number; maxCursors: number; cursorTtlMs: number;
}
export function limits(options: ConvexOptions): Limits {
  return {
    timeoutMs: positive(options.timeoutMs, 30_000, 120_000),
    maxRows: positive(options.maxRows, 1000, 10_000), maxGetManyKeys: positive(options.maxGetManyKeys, 100, 1000),
    maxPages: positive(options.maxPages, 100, 1000), maxResponseBytes: positive(options.maxResponseBytes, 4_194_304, 16_777_216),
    maxRequestBytes: positive(options.maxRequestBytes, 65_536, 1_048_576), maxTotalRequestBytes: positive(options.maxTotalRequestBytes, 1_048_576, 16_777_216),
    maxWorkRows: positive(options.maxWorkRows, 10_000, 100_000),
    maximumRowsRead: positive(options.maximumRowsRead, 1000, 10_000), maximumBytesRead: positive(options.maximumBytesRead, 1_048_576, 4_194_304),
    maxConcurrent: positive(options.maxConcurrent, 4, 16), maxCursors: positive(options.maxCursors, 128, 1024),
    cursorTtlMs: positive(options.cursorTtlMs, 300_000, 600_000),
  };
}
export interface Journal {
  rows: number; pages: number; requestBytes: number; responseBytes: number; workRows: number;
  readonly expires: number; readonly ids: Set<string>; readonly cursors: Set<string>;
}
export function journal(ttl: number): Journal {
  return { rows: 0, pages: 0, requestBytes: 0, responseBytes: 0, workRows: 0, expires: performance.now() + ttl, ids: new Set(), cursors: new Set() };
}
export class Operation {
  readonly #scope;
  readonly #caller: AbortSignal | undefined;
  readonly #expires: number;
  readonly #controller = new AbortController();
  readonly #forward = (): void => { this.#controller.abort(); };
  #pending = 0;
  #release: (() => void) | undefined;
  public constructor(caller: AbortSignal | undefined, timeoutMs: number, started = performance.now()) {
    this.#caller = caller;
    this.#expires = started + timeoutMs;
    this.#scope = createAbortScope(caller, Math.max(1, Math.ceil(this.#expires - performance.now())));
    if (this.#scope.signal.aborted) this.#controller.abort();
    else this.#scope.signal.addEventListener("abort", this.#forward, { once: true });
  }
  public get signal(): AbortSignal { return this.#controller.signal; }
  public readonly error = (): Error => {
    if (this.#scope.signal.aborted) return new QueryCancelledError(this.#scope.deadlineExceeded ? "deadline" : "caller");
    return new ConvexReadError("closed");
  };
  public readonly check = (): void => {
    try {
      const elapsed = performance.now() >= this.#expires;
      if (this.#scope.signal.aborted) throw this.error();
      if (this.#caller?.aborted === true) throw new QueryCancelledError("caller");
      if (elapsed) throw new QueryCancelledError("deadline");
      if (this.#controller.signal.aborted) fail("closed");
    } catch (error) {
      if (error instanceof ConvexReadError || error instanceof QueryCancelledError) throw error;
      throw new ConvexReadError("transport");
    }
  };
  public stop(): void { this.#controller.abort(); }
  /** Retain admission until borrowed work physically settles, even after abort. */
  public track<T>(promise: Promise<T>): Promise<T> {
    this.#pending++;
    const settled = (): void => {
      this.#pending--;
      if (this.#pending === 0 && this.#release !== undefined) {
        const release = this.#release;
        this.#release = undefined;
        release();
      }
    };
    return promise.then(
      value => { settled(); return value; },
      (error: unknown) => { settled(); throw error; },
    );
  }
  public finish(release: () => void): void {
    if (this.#pending === 0) release();
    else this.#release = release;
  }
  public dispose(): void {
    this.#scope.dispose();
    this.#scope.signal.removeEventListener("abort", this.#forward);
  }
}
export function endpoint(options: ConvexOptions): string {
  let url: URL;
  try { url = new URL(options.endpoint); } catch { return fail("invalid-input"); }
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(options.allowInsecureLoopbackHttp === true && url.protocol === "http:" && loopback))
    || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.pathname !== "/" && url.pathname !== "") || options.endpoint.includes("?") || options.endpoint.includes("#")) fail("invalid-input");
  return url.origin + "/api/query";
}
export async function authorization(options: ConvexOptions, op: Operation): Promise<{ token: string | undefined; fingerprint: string }> {
  op.check();
  if (options.token === undefined) return { token: undefined, fingerprint: "anonymous" };
  const token = await raceAbort(op.track(Promise.resolve().then(() => {
    op.check(); return typeof options.token === "function" ? options.token(op.signal) : options.token;
  })), op.signal, op.error);
  op.check();
  if (typeof token !== "string" || token.length < 1 || token.length > 8192 || !/^[!-~]+$/u.test(token)) fail("denied");
  const bytes = new TextEncoder().encode(token);
  const digest = await raceAbort(op.track(crypto.subtle.digest("SHA-256", bytes)), op.signal, op.error);
  op.check();
  return { token, fingerprint: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
}

/** One bounded HTTP request, borrowing fetch but owning its exact body/reader. */
export async function call(url: string, transport: typeof fetch, path: string, args: Value, token: string | undefined, op: Operation, budget: Journal, bound: Limits, workRows: number): Promise<Value> {
  op.check();
  const body = JSON.stringify({ path, format: "convex_encoded_json", args: [encoded(args)] });
  if (body.length > bound.maxRequestBytes) fail("limit");
  const size = new TextEncoder().encode(body).byteLength;
  if (size > bound.maxRequestBytes || size > bound.maxTotalRequestBytes - budget.requestBytes || budget.pages >= bound.maxPages || workRows > bound.maxWorkRows - budget.workRows) fail("limit");
  // Incurred attempts/work and bytes are retained even if delivery is cancelled.
  budget.pages++; budget.requestBytes += size; budget.workRows += workRows;
  const controller = new AbortController();
  const onAbort = (): void => { controller.abort(); };
  if (op.signal.aborted) controller.abort(); else op.signal.addEventListener("abort", onAbort, { once: true });
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let abandoned = false, cleaned = false;
  const clean = (): void => {
    if (response === undefined || cleaned) return;
    cleaned = true;
    try { cancelQuietly(reader ?? response.body); } catch { /* A hostile getter cannot replace the redacted failure. */ }
  };
  try {
    const pending = Promise.resolve().then(() => {
      op.check();
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
      if (token !== undefined) headers.authorization = "Bearer " + token;
      return transport(url, { method: "POST", body, headers, signal: controller.signal, credentials: "omit", redirect: "error" });
    }).then(value => { response = value; if (abandoned || op.signal.aborted) clean(); return value; });
    const received = await raceAbort(op.track(pending), op.signal, op.error);
    op.check();
    if (received.redirected || (received.url !== "" && received.url !== url)) fail("transport");
    if (received.status !== 200) fail(received.status === 401 || received.status === 403 ? "denied" : "transport");
    if (received.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") fail("protocol");
    const remaining = bound.maxResponseBytes - budget.responseBytes;
    const length = received.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > remaining)) fail("limit");
    if (received.body === null) fail("protocol");
    reader = received.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      op.check();
      const part = await raceAbort(op.track(reader.read()), op.signal, op.error);
      op.check();
      if (part.done) break;
      if (part.value.byteLength > bound.maxResponseBytes - budget.responseBytes) fail("limit");
      budget.responseBytes += part.value.byteLength; total += part.value.byteLength;
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const envelope = fields(parseJSON(bytes), ["status", "value", "logLines", "errorMessage", "errorData"]);
    // Even successful provider logs are deliberately never emitted or retained.
    if (envelope.status !== "success" || !Object.hasOwn(envelope, "value")) fail("protocol");
    const decoded = decodeValue(envelope.value as Parameters<typeof decodeValue>[0], bound.maxResponseBytes, op.check);
    op.check();
    return decoded;
  } catch (error) {
    op.check();
    if (error instanceof ConvexReadError || error instanceof QueryCancelledError) throw error;
    throw new ConvexReadError("transport");
  } finally {
    abandoned = true;
    controller.abort();
    clean();
    try { reader?.releaseLock(); } catch { /* A pending hostile reader must not delay completion. */ }
    op.signal.removeEventListener("abort", onAbort);
    op.check();
  }
}
