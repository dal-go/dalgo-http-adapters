import { createAbortScope, raceAbort, QueryCancelledError } from "@dalgo/adapter-runtime";
import { isRedisValue, RedisReadError, resolveRedisLimits, validateRedisRead, type RedisLimits, type RedisReadExecutor } from "./contracts.js";
import { assertActive, cancellationError, object, readJson } from "./http-body.js";

export interface RedisHttpHandlerOptions extends RedisLimits {
  /** Required host integration. Authenticate and authorize this user/resource, then return its server-owned executor.
   * Return undefined for denied access. Never construct an endpoint from the request body.
   * The host remains responsible for CSRF/origin policy, rate limits and key-scoped Redis ACLs.
   */
  readonly authorize: (request: Request, signal: AbortSignal) => Promise<RedisReadExecutor | undefined>;
}

function response(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** Fetch-compatible trusted server route. It accepts only a native read command, never connection credentials. */
export function createRedisHttpHandler(options: RedisHttpHandlerOptions): (request: Request) => Promise<Response> {
  if (typeof options.authorize !== "function") throw new TypeError("Redis HTTP authorization is required");
  const limits = resolveRedisLimits(options);
  return async (request) => {
    if (request.method !== "POST") return response(405, { error: "method" });
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return response(415, { error: "content-type" });
    const scope = createAbortScope(request.signal, limits.timeoutMs);
    try {
      const executor = await raceAbort(Promise.resolve().then(() => options.authorize(request, scope.signal)), scope.signal, () => cancellationError(scope));
      if (executor === undefined) return response(403, { error: "denied" });
      const body = await readJson(request.body, limits.maxCommandBytes + 4_096, scope);
      if (!object(body) || Object.keys(body).length !== 1 || !Array.isArray(body.command)) throw new RedisReadError("policy");
      const command = validateRedisRead(body.command, limits);
      const result = await raceAbort(executor.execute(command, scope.signal), scope.signal, () => cancellationError(scope));
      assertActive(scope);
      if (!isRedisValue(result)) throw new RedisReadError("protocol");
      const payload = { result };
      if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > limits.maxReplyBytes) throw new RedisReadError("limit");
      assertActive(scope);
      return response(200, payload);
    } catch (error) {
      if (error instanceof QueryCancelledError) return response(error.reason === "deadline" ? 504 : 499, { error: error.reason });
      if (error instanceof RedisReadError) return response(error.code === "limit" ? 413 : error.code === "policy" ? 400 : 502, { error: error.code });
      return response(502, { error: "transport" });
    } finally { scope.dispose(); }
  };
}
