import { AnalyticalError, fail, isObject, parseJSON } from "./wire.js";
import { cloneFrozen, nonempty, type Principal } from "./protocol.js";
import { opaqueID } from "./ledger.js";
import { abortable, type IdentityProvider, type SafeFetch, type TrustedIdentity } from "./transport.js";

const readonlyScope = "https://www.googleapis.com/auth/bigquery.readonly";
const cancelScope = "https://www.googleapis.com/auth/bigquery";
const discoveryURL = "https://accounts.google.com/.well-known/openid-configuration";
const userInfoURL = "https://openidconnect.googleapis.com/v1/userinfo";
const maxBodyBytes = 64 * 1024;

/** Pass to GIS initTokenClient; consent is triggered by the consumer's user gesture. */
export function googleAuthorizationScopes(options: { email?: boolean; cancellation?: boolean } = {}): string {
  return ["openid", options.cancellation ? cancelScope : readonlyScope, ...(options.email ? ["email"] : [])].join(" ");
}

/** Structural subset of GIS TokenResponse. Never store or log this object. */
export interface GoogleTokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly error?: string;
}
export interface GoogleIdentitySummary {
  readonly principal: Principal;
  readonly expiresAt: number;
  readonly read: true;
  readonly cancel: boolean;
  /** Optional verified display label; never an identity or account-linkage key. */
  readonly email?: string;
}
export interface GoogleIdentityConfig {
  readonly fetch?: SafeFetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** Metadata pilots may accept only the exact openid + BigQuery readonly grant set. */
  readonly scopePolicy?: "compatible" | "exact-readonly";
}

/** Memory-only GIS token provider. It never prompts, refreshes, links Firebase
 * accounts or chooses a project. Connect only from the real GIS callback; call
 * disconnect on app sign-out, local disconnect and execution-account change.
 */
export class GoogleTokenIdentityProvider implements IdentityProvider {
  readonly #fetch: SafeFetch;
  readonly #now: () => number;
  readonly #timeout: number;
  readonly #scopePolicy: "compatible" | "exact-readonly";
  #revision = 0;
  #identity: TrustedIdentity | undefined;
  #pending: AbortController | undefined;
  public constructor(config: GoogleIdentityConfig = {}) {
    this.#fetch = config.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#now = config.now ?? Date.now;
    this.#timeout = config.timeoutMs ?? 15000;
    this.#scopePolicy = config.scopePolicy ?? "compatible";
    if (this.#scopePolicy !== "compatible" && this.#scopePolicy !== "exact-readonly") fail("invalid_input");
    if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 15000) fail("invalid_input");
  }
  public disconnect(): void {
    this.#revision += 1;
    this.#identity = undefined;
    this.#pending?.abort();
    this.#pending = undefined;
  }
  public async connect(response: GoogleTokenResponse, signal?: AbortSignal): Promise<GoogleIdentitySummary> {
    // A denied/failed token rotation must invalidate the previous approval too.
    this.disconnect();
    const revision = this.#revision;
    const now = this.#now();
    if (signal?.aborted) fail("local_stopped");
    if (!response || response.error !== undefined || typeof response.access_token !== "string" ||
        response.access_token.length === 0 || response.access_token.length > 16384 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(response.access_token) ||
        typeof response.token_type !== "string" || response.token_type.toLowerCase() !== "bearer") fail("auth_required");
    const token = response.access_token;
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(response.expires_in) ||
        (response.expires_in ?? 0) < 1 || (response.expires_in ?? 0) > 86400) fail("auth_expired");
    const expiresAt = now + (response.expires_in as number) * 1000;
    if (!Number.isSafeInteger(expiresAt)) fail("auth_expired");
    if (typeof response.scope !== "string" || response.scope.length > 8192) fail("scope_missing");
    const grants = new Set(response.scope.split(/\s+/u));
    if (!grants.has("openid") || !(grants.has(readonlyScope) || grants.has(cancelScope))) fail("scope_missing");
    if (this.#scopePolicy === "exact-readonly" &&
        (grants.size !== 2 || !grants.has(readonlyScope))) fail("scope_missing");
    const controller = new AbortController();
    this.#pending = controller;
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const deadline = Math.min(now + this.#timeout, expiresAt);
    const timer = setTimeout(abort, deadline - now);
    let bytes = 0;
    const get = async (url: string, authenticated: boolean) => {
      if (controller.signal.aborted || this.#now() >= deadline) fail("local_stopped");
      const result = await abortable(this.#fetch(url, {
        method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
        headers: { Accept: "application/json", ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
      }), controller.signal);
      if (result.redirected || result.status >= 300 && result.status < 400) fail("auth_required");
      const reader = result.body?.getReader();
      if (!reader) fail("malformed_wire");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await abortable(reader.read(), controller.signal);
          if (chunk.done) break;
          length += chunk.value.byteLength;
          bytes += chunk.value.byteLength;
          if (length > maxBodyBytes || bytes > 2 * maxBodyBytes) fail("response_limit");
          chunks.push(chunk.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (controller.signal.aborted || this.#now() >= deadline) fail("local_stopped");
      if (!result.ok) fail(result.status === 401 ? "auth_expired" : "auth_required");
      const raw = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
      const body = parseJSON(raw, maxBodyBytes);
      if (!isObject(body)) fail("malformed_wire");
      return body;
    };
    try {
      // Discovery is public and never receives the access token. Source metadata
      // cannot override either endpoint, even with a Google-looking URL.
      const discovery = await get(discoveryURL, false);
      if (discovery.issuer !== "https://accounts.google.com" || discovery.userinfo_endpoint !== userInfoURL) fail("auth_required");
      const user = await get(userInfoURL, true);
      if (typeof user.sub !== "string" || user.sub.trim().length === 0) fail("auth_required");
      nonempty(user.sub);
      if (this.#now() >= expiresAt) fail("auth_expired");
      if (controller.signal.aborted || revision !== this.#revision) fail("local_stopped");
      const principal: Principal = { kind: "google-user", subject: user.sub, generation: opaqueID() };
      const identity = cloneFrozen({ principal, accessToken: token, expiresAt, read: true, cancel: grants.has(cancelScope) });
      this.#identity = identity;
      return cloneFrozen({ principal, expiresAt, read: true, cancel: identity.cancel,
        ...(typeof user.email === "string" && user.email.length <= 320 && user.email_verified === true ? { email: user.email } : {}),
      });
    } catch (error) {
      if (error instanceof AnalyticalError) throw error;
      return fail(controller.signal.aborted ? "local_stopped" : "auth_required");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (this.#pending === controller) this.#pending = undefined;
    }
  }
  public async authorize(signal: AbortSignal): Promise<TrustedIdentity> {
    if (signal.aborted) fail("local_stopped");
    const identity = this.#identity;
    if (!identity) fail("auth_required");
    if (this.#now() >= identity.expiresAt) { this.#identity = undefined; fail("auth_expired"); }
    return identity;
  }
}
