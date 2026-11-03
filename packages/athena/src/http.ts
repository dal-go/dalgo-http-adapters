import { QueryCancelledError } from "@dalgo/adapter-runtime";
import type { StructuredQuery } from "@dalgo/core";
import { AthenaNativeClient } from "./client.js";
import { AthenaError, fail, safe } from "./errors.js";
import { decode, encode } from "./json.js";
import { Manager, type Operation } from "./operation.js";
import type { AthenaCursor, AthenaLimits, AthenaNativePage } from "./types.js";
import { field, only } from "./validation.js";
export interface AthenaHttpHandlerOptions extends AthenaLimits {
  readonly allowedOrigins: readonly string[];
  /** Mandatory principal/CSRF authorization. Return a stable authority/source
   * client, never create endpoints/credentials from this request descriptor. */
  readonly authorize: (request: Request, signal: AbortSignal) => AthenaNativeClient | undefined | Promise<AthenaNativeClient | undefined>;
}
function response(status: number, value: unknown): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } }); }
/** Hosting must map actual disconnect/upload cancellation to Request.signal.
 * Native ACK is local server success, not proof a browser received the body. */
export function createAthenaHttpHandler(options: AthenaHttpHandlerOptions): (request: Request) => Promise<Response> {
  if (typeof options.authorize !== "function" || !Array.isArray(options.allowedOrigins) || options.allowedOrigins.length === 0 || options.allowedOrigins.length > 32 || options.allowedOrigins.includes("*")) throw fail("configuration");
  const origins = new Set(options.allowedOrigins); const manager = new Manager(options);
  return async request => {
    if (request.method !== "POST") return response(405, { error: "input" });
    if (!origins.has(request.headers.get("origin") ?? "")) return response(403, { error: "permission" });
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return response(415, { error: "input" });
    let op: Operation | undefined;
    try {
      op = manager.begin(request.signal); const active = op;
      const bytes = await active.bytes(request.body, active.limits.maxRequestBytes); active.newDocument();
      const input = only(decode(new TextDecoder("utf-8", { fatal: true }).decode(bytes), active), ["operation", "query", "pageSize", "offset", "projection", "cursor"]);
      if (input.operation !== "query" && input.operation !== "next") throw fail("input");
      if (input.operation === "query" && input.cursor !== undefined || input.operation === "next" && (input.query !== undefined || input.offset !== undefined || input.projection !== undefined || input.pageSize !== undefined || typeof input.cursor !== "string" || input.cursor.length > 256)) throw fail("input");
      if (input.operation === "query") {
        const query = only(input.query, ["source", "filters", "orders", "limit", "offset"]); only(field(query, "source"), ["kind", "name"]);
      }
      const client = await active.io(() => options.authorize(request, active.signal));
      if (!(client instanceof AthenaNativeClient)) throw fail("permission");
      const deliver = (page: AthenaNativePage, check: () => void): Response => {
        check(); active.check(); const wire = encode(page, active.limits.maxResponseBytes, active);
        const result = new Response(wire, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
        active.prepareDelivery(); check(); return result;
      };
      if (input.operation === "next") return await client.mapNextPage(input.cursor as AthenaCursor, request.signal, deliver, active.expires);
      return await client.mapQueryPage(input.query as StructuredQuery<unknown>, { signal: request.signal, ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize as number }), ...(input.offset === undefined ? {} : { offset: input.offset as number }), ...(input.projection === undefined ? {} : { projection: input.projection as readonly string[] }) }, deliver, active.expires);
    } catch (original) {
      let error: Error; try { error = op === undefined ? safe(original) : op.failure(original); } catch (fresh) { error = safe(fresh); }
      if (error instanceof QueryCancelledError) return response(408, { error: "cancelled", reason: error.reason });
      const code = error instanceof AthenaError ? error.code : "transport";
      return response(code === "permission" ? 403 : code === "bounds" ? 413 : code === "cursor" || code === "input" ? 400 : code === "busy" ? 503 : 502, { error: code });
    } finally { op?.finish(); }
  };
}
