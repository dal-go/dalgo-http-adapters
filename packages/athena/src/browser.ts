import type { StructuredQuery } from "@dalgo/core";
import { fail } from "./errors.js";
import { decode, encode, object, utf8 } from "./json.js";
import { responseBodyStream, httpHeaders, httpStatus } from "./protocol.js";
import { cancelled, integer, Manager } from "./operation.js";
import type { AthenaCursor, AthenaLimits, AthenaNativePage, AthenaReadOptions, AthenaReader } from "./types.js";
import { array, field, only, text } from "./validation.js";
export { AthenaError } from "./errors.js";
export type { AthenaNativePage, AthenaColumn, AthenaCursor, AthenaReadOptions } from "./types.js";
export interface AthenaHttpOptions extends AthenaLimits {
  readonly endpoint: string;
  /** Application bridge headers only; never AWS credentials. */
  readonly headers: (signal: AbortSignal) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  readonly fetch?: typeof fetch; readonly allowLoopbackHttpForTesting?: boolean;
}
function queryWire(query: StructuredQuery<unknown>): unknown {
  only(query, ["source", "filters", "orders", "limit", "offset", "startAt", "startAfter", "endAt", "endBefore"]);
  for (const key of ["startAt", "startAfter", "endAt", "endBefore"]) if (field(query, key) !== undefined) throw fail("input");
  const source = only(field(query, "source"), ["kind", "name", "parent", "codec"]); if (field(source, "parent") !== undefined) throw fail("input");
  return { source: { kind: field(source, "kind"), name: field(source, "name") }, filters: field(query, "filters") ?? [], orders: field(query, "orders") ?? [],
    ...(field(query, "limit") === undefined ? {} : { limit: field(query, "limit") }), ...(field(query, "offset") === undefined ? {} : { offset: field(query, "offset") }) };
}
function nativePage(value: unknown): AthenaNativePage {
  const page = only(value, ["columns", "rows", "ordinalStart", "hasMore", "nextCursor", "receipt"]); const columns = array(page.columns, 512).map(value => object(value));
  const rows = array(page.rows, 1000).map(value => { const row = array(value, columns.length); if (row.length !== columns.length || row.some(cell => cell !== null && typeof cell !== "string")) throw fail("protocol"); return row; });
  if (typeof page.hasMore !== "boolean" || page.hasMore !== (page.nextCursor !== undefined)) throw fail("protocol");
  integer(page.ordinalStart, 0, 100_000); if (page.nextCursor !== undefined) text(page.nextCursor, 256);
  const receipt = object(page.receipt); if (receipt.state !== "SUCCEEDED" || receipt.complete !== !page.hasMore) throw fail("protocol");
  for (const column of columns) { text(column.name); text(column.type, 256); }
  return { ...page, rows, columns } as unknown as AthenaNativePage;
}
/** Browser-safe client of an authenticated fixed-authority application bridge. */
export class AthenaHttpClient implements AthenaReader {
  readonly #manager: Manager; readonly #endpoint: string; readonly #fetch: typeof fetch; readonly #headers: AthenaHttpOptions["headers"];
  public constructor(options: AthenaHttpOptions) {
    let url: URL; try { url = new URL(options.endpoint, typeof location === "undefined" ? undefined : location.href); } catch { throw fail("configuration"); }
    if (url.protocol !== "https:" && !(options.allowLoopbackHttpForTesting === true && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)) || url.username || url.password || url.search || url.hash) throw fail("configuration");
    if (typeof options.headers !== "function") throw fail("configuration"); this.#headers = options.headers; this.#endpoint = url.toString(); this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init)); this.#manager = new Manager(options);
  }
  public close(): void { this.#manager.close(); }
  async #execute(admit: () => unknown, signal?: AbortSignal): Promise<AthenaNativePage> {
    const op = this.#manager.begin(signal); let owned: Response | undefined; let reading = false;
    try {
      const wire = encode(op.call(admit), op.limits.maxRequestBytes, op); const supplied = await op.io(() => this.#headers(op.signal));
      const fields = only(supplied, Object.keys(supplied)); if (Object.keys(fields).length > 128) throw fail("bounds"); const headers = new Headers(); let headerBytes = 0;
      for (const [key, value] of Object.entries(fields)) { if (typeof value !== "string" || value.length > 32_768 || /[\r\n]/u.test(value)) throw fail("input"); headerBytes += key.length + value.length; if (headerBytes > 65536) throw fail("bounds"); headers.set(key, value); }
      headers.set("content-type", "application/json"); op.request(utf8(wire));
      const response = await op.io(() => Promise.resolve(this.#fetch(this.#endpoint, { method: "POST", headers, body: wire, signal: op.signal, redirect: "error", cache: "no-store", credentials: "same-origin" })).then(value => { owned = value; return value; }), value => { op.cleanup(responseBodyStream(value)); });
      reading = true; const bytes = await op.bytes(responseBodyStream(response), op.limits.maxResponseBytes); op.newDocument(); const payload = decode(new TextDecoder("utf-8", { fatal: true }).decode(bytes), op);
      if (httpHeaders(response).get("content-type")?.split(";")[0]?.trim() !== "application/json") throw fail("protocol");
      if (httpStatus(response) !== 200) {
        const error = object(payload); if (error.error === "cancelled" && (error.reason === "caller" || error.reason === "deadline")) throw cancelled(error.reason);
        throw fail(httpStatus(response) === 403 ? "permission" : httpStatus(response) === 400 ? "cursor" : "transport");
      }
      const result = nativePage(payload); op.prepareDelivery(); return result;
    } catch (error) { throw op.failure(error); }
    finally { if (!reading && owned !== undefined) op.cleanup(responseBodyStream(owned)); op.finish(); }
  }
  public queryPage(query: StructuredQuery<unknown>, options: AthenaReadOptions = {}): Promise<AthenaNativePage> {
    return this.#execute(() => ({ operation: "query", query: queryWire(query), ...(options.pageSize === undefined ? {} : { pageSize: integer(options.pageSize, 1, 1000) }), ...(options.offset === undefined ? {} : { offset: integer(options.offset, 0, 100_000) }), ...(options.projection === undefined ? {} : { projection: array(options.projection, 512).map(value => text(value)) }) }), options.signal);
  }
  public nextPage(cursor: AthenaCursor, signal?: AbortSignal): Promise<AthenaNativePage> { return this.#execute(() => ({ operation: "next", cursor: text(cursor, 256) }), signal); }
}
