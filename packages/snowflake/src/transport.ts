import { raceAbort } from "@dalgo/adapter-runtime";
import { failure } from "./errors.js";
import { decode, encode, object, utf8 } from "./json.js";
import { integer, Manager, signalAborted, type Operation, type SnowflakeLimits } from "./operation.js";
export { SnowflakeError } from "./errors.js";
export { integer } from "./operation.js";
export type { SnowflakeLimits } from "./operation.js";

export interface Binding { type: "TEXT" | "FIXED" | "REAL" | "BOOLEAN"; value: string }
export interface TransportOptions extends SnowflakeLimits {
  endpoint: string;
  /** Called per ordinary HTTP request; cancel uses the captured submit credential. */
  token: (signal?: AbortSignal) => string | Promise<string>;
  tokenType?: "OAUTH" | "KEYPAIR_JWT";
  database: string; schema: string; warehouse?: string; role?: string;
  fetch?: typeof globalThis.fetch; pollIntervalMs?: number; maxPolls?: number;
}
interface Statement { handle?: string; readonly credential: string; completed: boolean; cancelStarted: boolean }
function handle(value: unknown): string {
  if (typeof value !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value)) throw failure("Invalid Snowflake statement handle");
  return value.toLowerCase();
}
function rows(value: unknown, width: number, expected: number, op: Operation): (string | null)[][] {
  if (!Array.isArray(value) || value.length !== expected) throw failure("Incomplete Snowflake partition");
  const result: (string | null)[][] = [];
  for (const row of value) {
    op.check(); if (!Array.isArray(row) || row.length !== width) throw failure("Invalid Snowflake result rows");
    const copy: (string | null)[] = [];
    for (const cell of row) { if (cell !== null && typeof cell !== "string") throw failure("Invalid Snowflake result rows"); copy.push(cell); }
    result.push(copy);
  }
  return result;
}
function byteView(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw failure("Invalid Snowflake response bytes");
  const prototype: unknown = Object.getPrototypeOf(Uint8Array.prototype);
  if (typeof prototype !== "object" || prototype === null) throw failure("Invalid Snowflake response bytes");
  const sizeGetter = Object.getOwnPropertyDescriptor(prototype, "byteLength")?.get;
  const startGetter = Object.getOwnPropertyDescriptor(prototype, "byteOffset")?.get;
  const bufferGetter = Object.getOwnPropertyDescriptor(prototype, "buffer")?.get;
  if (sizeGetter === undefined || startGetter === undefined || bufferGetter === undefined) throw failure("Invalid Snowflake response bytes");
  const size: unknown = Reflect.apply(sizeGetter, value, []); const start: unknown = Reflect.apply(startGetter, value, []); const buffer: unknown = Reflect.apply(bufferGetter, value, []);
  if (typeof size !== "number" || typeof start !== "number" || !(buffer instanceof ArrayBuffer)) throw failure("Invalid Snowflake response bytes");
  return new Uint8Array(buffer, start, size);
}
function headers(response: Response): void {
  let bytes = 0; let count = 0;
  for (const [name, value] of response.headers) {
    if (++count > 1024 || name.length + value.length > 65_536 || (bytes += utf8(name) + utf8(value)) > 65_536) throw failure("Snowflake header budget exceeded");
  }
}
async function readBody(response: Response, op: Operation): Promise<Record<string, unknown>> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined; let done = false;
  try {
    const maximum = Math.min(op.limits.maxPageBytes, op.limits.maxResponseBytes - op.responseBytes);
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) throw failure("Snowflake response budget exceeded");
    if (response.body === null) throw failure("Invalid Snowflake JSON response");
    reader = response.body.getReader(); op.check();
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const owned = reader; const next = await op.io(() => owned.read());
      if (next.done) { done = true; break; }
      const view = byteView(next.value); size += view.byteLength; op.response(view.byteLength);
      if (size > maximum || chunks.length >= 65_536) throw failure("Snowflake response budget exceeded");
      chunks.push(new Uint8Array(view));
    }
    const body = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return object(decode(new TextDecoder("utf-8", { fatal: true }).decode(body), op));
  } finally {
    if (!done) op.cleanup(reader ?? response.body);
    if (reader !== undefined) {
      try { reader.releaseLock(); }
      catch { op.cleanup(reader); try { ReadableStreamDefaultReader.prototype.releaseLock.call(reader); } catch { /* No stronger contract for foreign readers. */ } }
    }
    op.check();
  }
}

export class Transport {
  readonly #manager: Manager; readonly #options: TransportOptions; readonly #endpoint: string;
  readonly #fetch: typeof globalThis.fetch; readonly #interval: number; readonly #polls: number;
  public constructor(options: TransportOptions) {
    let url: URL;
    try { url = new URL(options.endpoint); } catch { throw failure("Expected a Snowflake HTTPS account origin"); }
    if (url.protocol !== "https:" || !url.hostname.endsWith(".snowflakecomputing.com") || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw failure("Expected a Snowflake HTTPS account origin");
    this.#manager = new Manager(options); this.#endpoint = url.origin; this.#options = { ...options };
    this.#interval = integer(options.pollIntervalMs ?? 250, 0, "pollIntervalMs", this.#manager.limits.timeoutMs);
    this.#polls = integer(options.maxPolls ?? 240, 1, "maxPolls", 1000); this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof options.token !== "function" || typeof this.#fetch !== "function" || options.tokenType !== undefined && !["OAUTH", "KEYPAIR_JWT"].includes(options.tokenType)) throw failure("Invalid Snowflake transport configuration");
  }
  public close(): void { this.#manager.close(); }
  public run<T>(signal: AbortSignal | undefined, effect: (op: Operation) => Promise<T>): Promise<T> { return this.#manager.run(signal, effect); }
  private authorization(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, "X-Snowflake-Authorization-Token-Type": this.#options.tokenType ?? "OAUTH", "Content-Type": "application/json", Accept: "application/json", "User-Agent": "dalgo2snowflake/0.1.0" };
  }
  private async token(op: Operation): Promise<string> {
    const token = await op.io(() => this.#options.token(op.signal));
    if (typeof token !== "string" || token.length === 0 || token.length > 16_384 || /[^!-~]/u.test(token)) throw failure("Invalid Snowflake token");
    return token;
  }
  private async request(op: Operation, path: string, credential: string, body?: string): Promise<{ status: number; payload: Record<string, unknown> }> {
    op.request(body === undefined ? 0 : utf8(body)); let response: Response | undefined; let readerOwns = false;
    try {
      response = await op.io(async () => {
        const value = await this.#fetch(this.#endpoint + path, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: op.signal, headers: this.authorization(credential), ...(body === undefined ? {} : { body }) });
        response = value; return value;
      }, value => { op.cleanup(value.body); });
      headers(response);
      if (![200, 202, 429].includes(response.status) || body !== undefined && response.status === 429) throw failure("Snowflake request rejected", response.status);
      readerOwns = true; const payload = await readBody(response, op); return { status: response.status, payload };
    } finally { if (!readerOwns && response !== undefined) op.cleanup(response.body); op.check(); }
  }
  /** Separate finite cleanup scope; never acquire another ordinary operation slot. */
  private cancel(op: Operation, statement: Statement): void {
    if (statement.completed || statement.cancelStarted || statement.handle === undefined) return;
    statement.cancelStarted = true; const ownedHandle = statement.handle; const credential = statement.credential;
    void op.retain(async () => {
      const controller = new AbortController(); const race = new AbortController(); const expires = performance.now() + 2000;
      const stop = (): void => { controller.abort(); race.abort(); };
      const timer = setTimeout(stop, 2000);
      let response: Response | undefined; let reader: ReadableStreamDefaultReader<Uint8Array> | undefined; let done = false;
      const check = (): void => {
        if (signalAborted(controller.signal) || performance.now() >= expires) { stop(); throw failure("Snowflake cancellation outcome unknown"); }
      };
      const bounded = async <T>(effect: () => T | PromiseLike<T>): Promise<T> => {
        check();
        const value = await raceAbort(op.retain(() => { check(); return effect(); }), race.signal, () => failure("Snowflake cancellation outcome unknown"));
        check();
        return value;
      };
      try {
        response = await bounded(async () => {
          const value = await this.#fetch(`${this.#endpoint}/api/v2/statements/${ownedHandle}/cancel`, { method: "POST", redirect: "error", signal: controller.signal, headers: this.authorization(credential) });
          response = value; if (signalAborted(controller.signal)) op.cleanup(value.body); return value;
        });
        headers(response); if (response.status !== 200 || response.body === null) return;
        reader = response.body.getReader(); if (signalAborted(controller.signal)) return;
        let text = ""; const decoder = new TextDecoder("utf-8", { fatal: true }); let bytes = 0; let chunks = 0;
        for (;;) {
          const owned = reader; const next = await bounded(() => owned.read()); if (next.done) { done = true; break; }
          const view = byteView(next.value); bytes += view.byteLength;
          if (bytes > 16_384 || ++chunks > 1024) return; text += decoder.decode(view, { stream: true });
        }
        text += decoder.decode();
        // A successful HTTP reply alone is not proof of the owned handle being cancelled.
        let nodes = 0;
        const status = decode(text, { check, node: () => { check(); if (++nodes > 4096) throw failure("Snowflake cancellation outcome unknown"); } });
        if (handle(object(status).statementHandle) !== ownedHandle) return;
        // Matching CancelStatus is server-reported protocol confirmation only;
        // it never changes the original local caller/deadline failure.
      } catch { /* Unknown/failed cancel is never a fallback auth or successful local read. */ }
      finally {
        clearTimeout(timer); if (!done) op.cleanup(reader ?? response?.body ?? null);
        if (reader !== undefined) { try { reader.releaseLock(); } catch { op.cleanup(reader); try { ReadableStreamDefaultReader.prototype.releaseLock.call(reader); } catch { /* Foreign reader. */ } } }
      }
    });
  }
  public async read(op: Operation, statement: string, bindings: Record<string, Binding>, maxRows: number, aggregateRows = maxRows): Promise<Record<string, string | null>[]> {
    op.check();
    const envelope = { statement, bindings, database: this.#options.database, schema: this.#options.schema,
      ...(this.#options.warehouse === undefined ? {} : { warehouse: this.#options.warehouse }), ...(this.#options.role === undefined ? {} : { role: this.#options.role }),
      timeout: Math.max(1, Math.ceil((op.expires - performance.now()) / 1000)) };
    // Validate the complete escaped body before auth, then refresh server seconds
    // after credential latency. The second body is no larger than its admission.
    const admitted = encode(envelope, op.limits.maxRequestBytes - op.requestBytes, op); op.admitRequest(utf8(admitted));
    const owned: Statement = { credential: await this.token(op), completed: false, cancelStarted: false };
    op.check(); envelope.timeout = Math.max(1, Math.ceil((op.expires - performance.now()) / 1000));
    const body = encode(envelope, op.limits.maxRequestBytes - op.requestBytes, op);
    try {
      let result = await this.request(op, "/api/v2/statements", owned.credential, body);
      if (result.payload.statementHandle !== undefined) owned.handle = handle(result.payload.statementHandle);
      if (result.status !== 200 && owned.handle === undefined) throw failure("Invalid Snowflake statement handle");
      let polls = 0;
      while (result.status !== 200) {
        if (++polls > this.#polls) throw failure("Snowflake polling limit exceeded");
        let timer: ReturnType<typeof setTimeout> | undefined; let resolveDelay: (() => void) | undefined;
        try { await op.io(() => new Promise<undefined>(resolve => { resolveDelay = () => { resolve(undefined); }; timer = setTimeout(resolveDelay, this.#interval); })); }
        finally { clearTimeout(timer); resolveDelay?.(); }
        op.admitRequest(0); result = await this.request(op, `/api/v2/statements/${owned.handle}`, await this.token(op));
        if (result.payload.statementHandle !== undefined && handle(result.payload.statementHandle) !== owned.handle) throw failure("Mismatched Snowflake statement handle");
      }
      owned.completed = true;
      const metadata = object(result.payload.resultSetMetaData);
      if (!Array.isArray(metadata.rowType) || metadata.rowType.length === 0 || metadata.rowType.length > op.limits.maxColumns) throw failure("Missing Snowflake column metadata");
      const columns = metadata.rowType.map(column => {
        const name = object(column).name;
        if (typeof name !== "string" || name.length === 0 || utf8(name) > 4096) throw failure("Invalid Snowflake column metadata"); return name;
      });
      if (new Set(columns).size !== columns.length) throw failure("Duplicate Snowflake column names");
      const count = metadata.numRows;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw failure("Invalid Snowflake row count");
      if (count > maxRows || op.rows + count > aggregateRows) throw failure("Snowflake result exceeds maxRows; use an explicit query limit");
      const partitions = metadata.partitionInfo;
      if (!Array.isArray(partitions) || partitions.length === 0 || partitions.length > op.limits.maxPartitions) throw failure("Missing or excessive Snowflake partitions");
      const partitionCounts = partitions.map(partition => {
        const count = object(partition).rowCount;
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw failure("Invalid Snowflake partition row count"); return count;
      });
      if (partitionCounts.reduce((sum, count) => sum + count, 0) !== count) throw failure("Inconsistent Snowflake partition metadata");
      if (partitions.length > 1 && owned.handle === undefined) throw failure("Invalid Snowflake statement handle");
      const allRows: Record<string, string | null>[] = [];
      for (let i = 0; i < partitions.length; i++) {
        let payload = result.payload;
        if (i > 0) {
          op.admitRequest(0); const part = await this.request(op, `/api/v2/statements/${owned.handle}?partition=${i}`, await this.token(op));
          if (part.status !== 200) throw failure("Snowflake partition unavailable", part.status);
          if (part.payload.statementHandle !== undefined && handle(part.payload.statementHandle) !== owned.handle) throw failure("Mismatched Snowflake statement handle"); payload = part.payload;
        }
        const expected = partitionCounts[i]; if (expected === undefined) throw failure("Incomplete Snowflake partition");
        for (const row of rows(payload.data, columns.length, expected, op)) {
          const record: Record<string, string | null> = {};
          for (const [index, name] of columns.entries()) {
            const cell = row[index]; if (cell === undefined) throw failure("Invalid Snowflake result rows");
            Object.defineProperty(record, name, { value: cell, enumerable: true, writable: true, configurable: true });
          }
          allRows.push(record);
        }
      }
      if (allRows.length !== count) throw failure("Incomplete Snowflake result"); op.rows += count; op.check(); return allRows;
    } catch (error: unknown) { this.cancel(op, owned); throw error; }
  }
}
