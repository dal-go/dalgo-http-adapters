import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleTokenIdentityProvider, googleAuthorizationScopes, type GoogleIdentityConfig, type GoogleTokenResponse, type SafeFetch } from "../src/analytical.js";

const token: GoogleTokenResponse = {
  access_token: "synthetic-access-token", token_type: "Bearer", expires_in: 3600,
  scope: googleAuthorizationScopes(),
};
const discovery = { issuer: "https://accounts.google.com", userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo" };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
function fixture(user: unknown = { sub: "stable-google-subject" }, scopePolicy?: GoogleIdentityConfig["scopePolicy"]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let now = 1000000;
  const responses = [json(discovery), json(user)];
  const fetch: SafeFetch = async (url, init) => {
    calls.push({ url, init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected synthetic request");
    return response;
  };
  const provider = new GoogleTokenIdentityProvider({ fetch, now: () => now, ...(scopePolicy === undefined ? {} : { scopePolicy }) });
  return { provider, calls, responses, advance: (ms: number) => { now += ms; } };
}
const signal = (): AbortSignal => new AbortController().signal;
afterEach(() => vi.useRealTimers());
describe("same-token Google execution identity", () => {
  it("requires openid and narrow read consent; broader cancellation and email are explicit", () => {
    expect(googleAuthorizationScopes()).toBe("openid https://www.googleapis.com/auth/bigquery.readonly");
    expect(googleAuthorizationScopes({ email: true, cancellation: true })).toBe("openid https://www.googleapis.com/auth/bigquery email");
    expect(googleAuthorizationScopes()).not.toContain("cloud-platform");
  });
  it("verifies fixed discovery and same-token UserInfo, with missing email allowed", async () => {
    const f = fixture();
    const connected = await f.provider.connect(token);
    expect(connected.principal).toMatchObject({ kind: "google-user", subject: "stable-google-subject" });
    expect(connected.cancel).toBe(false);
    expect(connected).not.toHaveProperty("email");
    expect(connected).not.toHaveProperty("accessToken");
    expect(f.calls.map(call => call.url)).toEqual([
      "https://accounts.google.com/.well-known/openid-configuration", "https://openidconnect.googleapis.com/v1/userinfo",
    ]);
    expect(f.calls[0]?.init.headers).toEqual({ Accept: "application/json" });
    expect(f.calls[1]?.init.headers).toEqual({ Accept: "application/json", Authorization: "Bearer synthetic-access-token" });
    for (const call of f.calls) expect(call.init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", cache: "no-store" });
    const identity = await f.provider.authorize(signal());
    expect(identity.accessToken).toBe(token.access_token);
    expect(identity.principal).toEqual(connected.principal);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(JSON.stringify(f.provider)).toBe("{}");
    expect(JSON.stringify(connected)).not.toContain(token.access_token);
  });
  it("exact readonly policy keeps the real callback token and verifies its same-token subject", async () => {
    const f = fixture(undefined, "exact-readonly");
    const response = { ...token, scope: "https://www.googleapis.com/auth/bigquery.readonly openid" };
    const connected = await f.provider.connect(response);
    expect(connected.cancel).toBe(false);
    expect(connected.principal.subject).toBe("stable-google-subject");
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].init.headers).not.toHaveProperty("Authorization");
    expect(f.calls[1].init.headers).toHaveProperty("Authorization", `Bearer ${response.access_token}`);
    expect((await f.provider.authorize(signal())).accessToken).toBe(response.access_token);
  });
  it.each([
    undefined, "", "openid", "https://www.googleapis.com/auth/bigquery.readonly",
    googleAuthorizationScopes({ cancellation: true }),
    `${googleAuthorizationScopes()} https://www.googleapis.com/auth/bigquery`,
    `${googleAuthorizationScopes()} https://www.googleapis.com/auth/cloud-platform`,
    `${googleAuthorizationScopes()} email`, `${googleAuthorizationScopes()} arbitrary-grant`,
  ])("exact readonly policy refuses absent or broader actual grants before identity I/O: %s", async scope => {
    const f = fixture(undefined, "exact-readonly");
    await f.provider.connect(token);
    const response = scope === undefined ? { access_token: "rotation", token_type: "Bearer", expires_in: 3600 } : { ...token, scope };
    await expect(f.provider.connect(response)).rejects.toThrow("scope_missing");
    expect(f.calls).toHaveLength(2);
    await expect(f.provider.authorize(signal())).rejects.toThrow("auth_required");
  });
  it("exact readonly policy invalidates authorization on a GIS callback error without leaking the error", async () => {
    const f = fixture(undefined, "exact-readonly");
    await f.provider.connect(token);
    await expect(f.provider.connect({ error: "invented callback secret", ...token })).rejects.toThrow("auth_required");
    await expect(f.provider.authorize(signal())).rejects.toThrow("auth_required");
    expect(f.calls).toHaveLength(2);
  });
  it("compatible default still permits requested optional email and cancellation grants", async () => {
    const f = fixture();
    const result = await f.provider.connect({ ...token, scope: googleAuthorizationScopes({ email: true, cancellation: true }) });
    expect(result.cancel).toBe(true);
  });
  it("binds stable sub independently of email and replaces generation on every token change", async () => {
    const f = fixture({ sub: "subject1", email: "label@example.test", email_verified: true });
    const first = await f.provider.connect(token);
    expect(first.email).toBe("label@example.test");
    f.responses.push(json(discovery), json({ sub: "subject1" }));
    const second = await f.provider.connect({ ...token, access_token: "rotated", scope: googleAuthorizationScopes({ cancellation: true }) });
    expect(second.principal.subject).toBe(first.principal.subject);
    expect(second.principal.generation).not.toBe(first.principal.generation);
    expect(second.cancel).toBe(true);
    f.responses.push(json(discovery), json({ sub: "different-google-account", email: "label@example.test", email_verified: true }));
    const third = await f.provider.connect(token);
    expect(third.principal.subject).toBe("different-google-account");
    expect(third.principal.generation).not.toBe(second.principal.generation);
  });
  it.each([
    { scope: "openid" }, { scope: "https://www.googleapis.com/auth/bigquery.readonly" },
    { scope: "openid https://www.googleapis.com/auth/cloud-platform" }, { scope: "" },
  ])("refuses partial identity/read grants before network: %j", async input => {
    const f = fixture();
    await expect(f.provider.connect({ ...token, ...input })).rejects.toThrow("scope_missing");
    expect(f.calls).toHaveLength(0);
    await expect(f.provider.authorize(signal())).rejects.toThrow("auth_required");
  });
  it.each([{ email: "label@example.test" }, { sub: "" }, { sub: 123 }, { sub: null }])("refuses missing stable subject: %j", async user => {
    const f = fixture(user);
    await expect(f.provider.connect(token)).rejects.toThrow("auth_required");
    await expect(f.provider.authorize(signal())).rejects.toThrow("auth_required");
  });
  it("refuses an untrusted discovery endpoint with zero token-bearing dispatch", async () => {
    const f = fixture();
    f.responses.splice(0, 1, json({ ...discovery, userinfo_endpoint: "https://openidconnect.googleapis.com.attacker.test/v1/userinfo" }));
    await expect(f.provider.connect(token)).rejects.toThrow("auth_required");
    expect(f.calls).toHaveLength(1);
    expect(JSON.stringify(f.calls)).not.toContain(token.access_token);
  });
  it("expires locally with no automatic refresh or consent and disconnect clears authorization", async () => {
    const f = fixture();
    await f.provider.connect({ ...token, expires_in: 1 });
    f.advance(1000);
    await expect(f.provider.authorize(signal())).rejects.toThrow("auth_expired");
    await expect(f.provider.authorize(signal())).rejects.toThrow("auth_required");
    expect(f.calls).toHaveLength(2);
    f.responses.push(json(discovery), json({ sub: "stable-google-subject" }));
    await f.provider.connect(token);
    f.provider.disconnect();
    await expect(f.provider.authorize(signal())).rejects.toThrow("auth_required");
  });
  it("denial, invalid lifetime and failed token rotation invalidate old authorization without leaking errors", async () => {
    const f = fixture();
    await f.provider.connect(token);
    await expect(f.provider.connect({ ...token, error: "secret denial body" })).rejects.toThrow("auth_required");
    await expect(f.provider.authorize(signal())).rejects.toThrow("auth_required");
    for (const expires_in of [0, -1, 0.5, Number.MAX_SAFE_INTEGER, NaN]) {
      await expect(f.provider.connect({ ...token, expires_in })).rejects.toThrow("auth_expired");
    }
    expect(f.calls).toHaveLength(2);
  });
  it("bounds decompressed UserInfo bodies and rejects duplicate sub keys", async () => {
    for (const body of ['{"sub":"one","sub":"two"}', JSON.stringify({ sub: "one", ignored: "x".repeat(65536) })]) {
      const f = fixture();
      f.responses.splice(1, 1, new Response(body));
      await expect(f.provider.connect(token)).rejects.toThrow(body.includes("ignored") ? "response_limit" : "malformed_wire");
      await expect(f.provider.authorize(signal())).rejects.toThrow("auth_required");
    }
  });
  it("sanitizes HTTP failures and refuses redirects", async () => {
    const f = fixture();
    f.responses.splice(1, 1, new Response("sensitive-provider-error", { status: 401 }));
    await expect(f.provider.connect(token)).rejects.toThrow("auth_expired");
    const other = fixture();
    other.responses.splice(0, 1, new Response("", { status: 302, headers: { Location: "https://attacker.test" } }));
    await expect(other.provider.connect(token)).rejects.toThrow("auth_required");
    expect(other.calls).toHaveLength(1);
  });
  it("disconnect aborts a pending uncooperative provider and cannot install late identity", async () => {
    let finish: ((value: Response) => void) | undefined;
    const provider = new GoogleTokenIdentityProvider({ fetch: async () => new Promise(resolve => { finish = resolve; }) });
    const pending = provider.connect(token);
    const rejected = expect(pending).rejects.toThrow("local_stopped");
    provider.disconnect();
    finish?.(json(discovery));
    await rejected;
    await expect(provider.authorize(signal())).rejects.toThrow("auth_required");
  });
  it("times out an uncooperative fetch under a single bounded identity operation", async () => {
    vi.useFakeTimers();
    const provider = new GoogleTokenIdentityProvider({ timeoutMs: 10, fetch: async () => new Promise(() => {}) });
    const rejection = expect(provider.connect(token)).rejects.toThrow("local_stopped");
    await vi.advanceTimersByTimeAsync(11);
    await rejection;
  });
});
