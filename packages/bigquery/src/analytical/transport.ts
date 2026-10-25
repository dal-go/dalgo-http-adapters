import { AnalyticalError, fail, parseJSON, type JsonValue } from "./wire.js";
import { operationDeadline } from "./deadline.js";
import { same } from "./metadata.js";
import { validatePrincipal, type Bounds, type Principal } from "./protocol.js";
export interface TrustedIdentity {
  readonly principal: Principal;
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly read: boolean;
  readonly cancel: boolean;
}
/** For google-user the consumer attests same-token verified sub/grants, for
 * workload the operator attests the configured subject. Never caller JSON.
 */
export interface IdentityProvider {
  authorize(signal: AbortSignal): Promise<TrustedIdentity>;
}
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export const realClock: Clock = {
  now: () => Date.now(), sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AnalyticalError("local_stopped"));
      return;
    }
    const abort = (): void => { clearTimeout(timer); reject(new AnalyticalError("local_stopped")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, {
      once: true
    });
  })
};
export interface OperationScope {
  readonly bounds: Bounds;
  readonly executionDeadline: number;
  readonly principal: Principal;
  readonly callerDeadline?: number;
  readonly signal?: AbortSignal;
  beforeDispatch?(): Promise<void>;
  remaining(): Promise<number>;
  debit(bytes: number): Promise<void>;
}
// Bound injected providers/transports too: AbortSignal cooperation alone cannot
// prove a deadline when an integration accidentally ignores cancellation.
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(new AnalyticalError("local_stopped"));
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new AnalyticalError("local_stopped"));
    signal.addEventListener("abort", abort, {
      once: true
    });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => { });
  });
}
export type SafeFetch = (input: string, init: RequestInit) => Promise<Response>;
export class Transport {
  readonly #provider: IdentityProvider;
  readonly #fetch: SafeFetch;
  readonly #clock: Clock;
  public constructor(provider: IdentityProvider, fetcher: SafeFetch, clock: Clock) { this.#provider = provider; this.#fetch = fetcher; this.#clock = clock; }
  public async verify(principal: Principal, deadline: number, signal?: AbortSignal, rebind = false): Promise<Principal> {
    if (signal?.aborted || this.#clock.now() >= deadline)
      fail("local_stopped");
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, {
      once: true
    });
    const timer = setTimeout(abort, deadline - this.#clock.now());
    try {
      let identity: TrustedIdentity;
      try {
        identity = await abortable(this.#provider.authorize(controller.signal), controller.signal);
      }
      catch (error) {
        if (error instanceof AnalyticalError)
          throw error;
        fail("auth_required");
      }
      validatePrincipal(identity.principal);
      if (rebind ? identity.principal.kind !== principal.kind || identity.principal.subject !== principal.subject : !same(identity.principal, principal))
        fail("approval_changed");
      if (typeof identity.accessToken !== "string" || !identity.accessToken || /[\r\n]/u.test(identity.accessToken))
        fail("auth_required");
      if (!Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= this.#clock.now())
        fail("auth_expired");
      if (!identity.read)
        fail("scope_missing");
      if (controller.signal.aborted || this.#clock.now() >= deadline)
        fail("local_stopped");
      return {
        ...identity.principal
      };
    }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  public async call(scope: OperationScope, method: "GET" | "POST", path: string, query: Record<string, string>, body?: unknown, control = false, cancel = false, beforeDispatch?: () => void): Promise<JsonValue> {
    if (!/^projects\/[A-Za-z0-9_-]+\/(?:datasets|queries|jobs)(?:\/[A-Za-z0-9_%./-]+)*$/u.test(path) || path.includes(".."))
      fail("invalid_input");
    const controlDeadline = this.#clock.now() + Math.min(15000, scope.bounds.httpMs);
    const callerDeadline = control ? Math.min(scope.callerDeadline ?? Number.MAX_SAFE_INTEGER, controlDeadline) : scope.callerDeadline;
    for (let attempt = 0; attempt < (method === "GET" ? 3 : 1); attempt += 1) {
      if (scope.signal?.aborted)
        fail("local_stopped");
      const now = this.#clock.now();
      const remaining = await scope.remaining();
      const deadline = operationDeadline({
        now, executionDeadline: scope.executionDeadline, httpLimitMs: scope.bounds.httpMs, control, bytesRemaining: BigInt(remaining), ...(callerDeadline === undefined ? {} : {
          callerDeadline
        })
      });
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      scope.signal?.addEventListener("abort", abort, {
        once: true
      });
      const timer = setTimeout(abort, deadline - now);
      let response: Response | undefined;
      let identity: TrustedIdentity;
      try {
        try {
          identity = await abortable(this.#provider.authorize(controller.signal), controller.signal);
        }
        catch (error) {
          if (error instanceof AnalyticalError)
            throw error;
          fail("auth_required");
        }
        validatePrincipal(identity.principal);
        if (!same(identity.principal, scope.principal))
          fail("approval_changed");
        if (typeof identity.accessToken !== "string" || identity.accessToken.length < 1 || /[\r\n]/u.test(identity.accessToken))
          fail("auth_required");
        if (!Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= this.#clock.now())
          fail("auth_expired");
        if (!identity.read || (cancel && !identity.cancel))
          fail("scope_missing");
        if (controller.signal.aborted || this.#clock.now() >= deadline)
          fail("local_stopped");
        const url = `https://bigquery.googleapis.com/bigquery/v2/${path}${Object.keys(query).length === 0 ? "" : "?" + new URLSearchParams(query)}`;
        const requestBody = body === undefined ? undefined : JSON.stringify(body);
        await scope.beforeDispatch?.();
        if(controller.signal.aborted || this.#clock.now()>=deadline)fail("local_stopped");
        beforeDispatch?.();
        try {
          response = await abortable(this.#fetch(url, {
            method, headers: {
              Authorization: `Bearer ${identity.accessToken}`, Accept: "application/json", ...(body === undefined ? {} : {
                "Content-Type": "application/json"
              })
            }, redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal, ...(requestBody === undefined ? {} : {
              body: requestBody
            })
          }), controller.signal);
        }
        catch {
          if (controller.signal.aborted)
            fail("local_stopped");
          fail(method === "POST" ? cancel ? "cancellation_unknown" : "submission_unknown" : "remote_failed");
        }
        if (controller.signal.aborted || this.#clock.now() >= deadline)
          fail("local_stopped");
        if (response.redirected || response.status >= 300 && response.status < 400)
          fail(method === "POST" ? cancel ? "cancellation_unknown" : "submission_unknown" : "remote_failed");
        const chunks: Uint8Array[] = [];
        let length = 0;
        const reader = response.body?.getReader();
        if (reader !== undefined) {
          try {
            while (true) {
              const item = await abortable(reader.read(), controller.signal);
              if (item.done)
                break;
              const chunk = item.value;
              await scope.debit(chunk.byteLength);
              length += chunk.byteLength;
              if (length > scope.bounds.responseBytes || controller.signal.aborted || this.#clock.now() >= deadline) {
                void reader.cancel().catch(() => { });
                fail(length > scope.bounds.responseBytes ? "response_limit" : "local_stopped");
              }
              chunks.push(chunk);
            }
          }
          catch (error) {
            try {
              void reader.cancel().catch(() => { });
            }
            catch { /* no provider body retained */ }
            if (error instanceof AnalyticalError)
              throw error;
            fail(method === "POST" ? cancel ? "cancellation_unknown" : "submission_unknown" : "remote_failed");
          }
          finally {
            reader.releaseLock();
          }
        }
        const raw = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          raw.set(chunk, offset);
          offset += chunk.length;
        }
        if (controller.signal.aborted || this.#clock.now() >= deadline)
          fail("local_stopped");
        if (response.status >= 200 && response.status < 300)
          return parseJSON(raw, scope.bounds.responseBytes);
        // Provider bodies are charged but never copied into public errors/logs.
        if (method === "GET" && [429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
          let delay = 100 * 2 ** attempt;
          const retry = response.headers.get("Retry-After");
          if (retry !== null) {
            if (/^[0-9]+$/u.test(retry))
              delay = Number(retry) * 1000;
            else {
              const date = Date.parse(retry);
              if (Number.isFinite(date))
                delay = Math.max(0, date - this.#clock.now());
            }
          }
          const next = operationDeadline({
            now: this.#clock.now(), executionDeadline: scope.executionDeadline, httpLimitMs: scope.bounds.httpMs, control, bytesRemaining: BigInt(await scope.remaining()), ...(callerDeadline === undefined ? {} : {
              callerDeadline
            })
          });
          if (this.#clock.now() + delay >= next)
            fail("local_stopped");
          await this.#clock.sleep(delay, scope.signal);
          continue;
        }
        if (response.status === 401)
          fail("auth_expired");
        if (response.status === 403)
          fail("scope_missing");
        if (response.status === 404)
          fail(control ? "remote_failed" : "result_expired");
        fail(method === "POST" ? cancel ? "cancellation_unknown" : "submission_unknown" : "remote_failed");
      }
      finally {
        clearTimeout(timer);
        scope.signal?.removeEventListener("abort", abort);
      }
    }
    return fail("remote_failed");
  }
}
