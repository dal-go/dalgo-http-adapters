import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MetadataFixtureHarness, googleAuthorizationScopes, type PublicMetadataObservation, type SafeFetch } from "../src/analytical.js";
const goldenBytes = readFileSync(new URL("../testdata/bigquery-public-observation.json", import.meta.url));
const golden = JSON.parse(goldenBytes.toString()) as PublicMetadataObservation;
const source = { sourceId: golden.source_id, sourceProject: golden.source_project, datasetId: golden.dataset_id, tableId: golden.table_id };
const token = { access_token: "fixture-token", token_type: "Bearer", expires_in: 3600, scope: googleAuthorizationScopes() };
function fixture(options: { identity?: () => void; cleanup?: () => void; metadata?: (call: number, init: RequestInit) => void; status?: number; table?: unknown; limits?: { responseBytes?: number; wallMs?: number } } = {}) {
  let now = Date.parse(golden.observed_at); let calls = 0;
  const requests: string[] = [];
  const identityFetch: SafeFetch = async url => {
    options.identity?.();
    return new Response(JSON.stringify(url.includes("well-known") ? { issuer: "https://accounts.google.com", userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo" } : { sub: "fixture-principal", email: "private@example.invalid", email_verified: true }));
  };
  const harness = new MetadataFixtureHarness({ sources: [source], identityFetch,
    metadataFetch: async (url, init) => {
      requests.push(url); calls += 1;
      expect(init.method).toBe("GET"); expect(init.redirect).toBe("error"); expect(init.credentials).toBe("omit"); expect(init.cache).toBe("no-store");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-token");
      expect(url).not.toMatch(/jobs|queries|rows|list/u);
      options.metadata?.(calls, init);
      if (options.cleanup && calls === 1) return new Response("{}", { status: 503, headers: { "Retry-After": "0" } });
      const body = (options.cleanup ? calls === 2 : calls === 1) ? { datasetReference: { projectId: source.sourceProject, datasetId: source.datasetId }, location: golden.location, access: [{ principal: "secret" }] } : options.table ?? {
        tableReference: { projectId: source.sourceProject, datasetId: source.datasetId, tableId: source.tableId }, type: golden.object_type,
        schema: { fields: golden.schema.map(f => ({ ...f, description: "private", policyTags: { names: ["secret"] }, ...(f.fields ? { fields: f.fields.map(n => ({ ...n, mode: undefined, defaultValueExpression: "private", precision: "38" })) } : {}) })) },
        clustering: { fields: ["secret"] }, numRows: "100", description: "private table",
      };
      return new Response(JSON.stringify(body), { status: options.status ?? 200 });
    }, clock: { now: () => now, sleep: async (ms, signal) => { now += ms; signal?.addEventListener("abort", () => options.cleanup?.(), { once: true }); } }, ...(options.limits ? { limits: options.limits } : {}),
  });
  const ready = async () => { harness.setOwner("private-owner"); harness.select(source.sourceId, "private-job-project"); await harness.connect(token); harness.consentToMetadata(); };
  return { harness, ready, requests, advance: (ms: number) => { now += ms; } };
}
describe("protected fixture metadata consumer", () => {
  it("matches exact registry golden and excludes hostile nested/provider/identity fields", async () => {
    expect(createHash("sha256").update(goldenBytes).digest("hex")).toBe("2dcf87f754c51b7c655a42ff73d27f0e7b0fab79e9d229db06656203d8e63117");
    const f = fixture(); await f.ready(); const result = await f.harness.discover(); expect(result).toEqual(golden);
    expect(f.requests).toEqual([
      `https://bigquery.googleapis.com/bigquery/v2/projects/${source.sourceProject}/datasets/${source.datasetId}?datasetView=METADATA`,
      `https://bigquery.googleapis.com/bigquery/v2/projects/${source.sourceProject}/datasets/${source.datasetId}/tables/${source.tableId}?view=STORAGE_STATS`,
    ]);
    const serialized = JSON.stringify(result);
    for (const secret of ["private", "fixture-principal", "fixture-token", "consent", "policyTags", "precision", "clustering", "numRows", "defaultValueExpression"]) expect(serialized).not.toContain(secret);
  });
  it("requires owner and independent explicit consent, never a caller-supplied snapshot", async () => {
    const f = fixture(); await expect(f.harness.discover()).rejects.toThrow("approval_required");
    await f.ready(); f.harness.denyMetadataConsent(); await expect(f.harness.discover()).rejects.toThrow("approval_required");
    f.harness.consentToMetadata(); await expect(f.harness.discover({ binding: {} } as never)).rejects.toThrow("invalid_input");
    expect(f.requests).toHaveLength(0);
  });
  it.each(["owner", "source", "project", "disconnect", "deny", "rotation"])("invalidates before in-flight %s change", async change => {
    const f = fixture({ metadata: call => { if (call !== 1) return;
      switch (change) {
        case "owner": f.harness.setOwner("other"); break;
        case "source": expect(() => f.harness.select("untrusted", "private-job-project")).toThrow("policy_denied"); break;
        case "project": f.harness.select(source.sourceId, "other-project"); break;
        case "disconnect": f.harness.disconnect(); break;
        case "deny": f.harness.denyMetadataConsent(); break;
        case "rotation": void f.harness.connect({ ...token, error: "denied" }).catch(() => {}); break;
      }
    } }); await f.ready(); await expect(f.harness.discover()).rejects.toThrow(); expect(f.requests).toHaveLength(1);
  });
  it("rejects sign-out during identity verification and requires new consent after rotation", async () => {
    let armed = false; const f = fixture({ identity: () => { if (armed) f.harness.setOwner(undefined); } });
    f.harness.setOwner("owner"); f.harness.select(source.sourceId, "job-project"); armed = true;
    await expect(f.harness.connect(token)).rejects.toThrow(); await expect(f.harness.discover()).rejects.toThrow("approval_required");
    armed = false; await f.ready(); await f.harness.connect(token); await expect(f.harness.discover()).rejects.toThrow("approval_required"); expect(f.requests).toHaveLength(0);
  });
  it("rejects expiry before dispatch and cleanup-time revocation before delivery", async () => {
    const expired = fixture(); await expired.ready(); expired.advance(3600001); await expect(expired.harness.discover()).rejects.toThrow("auth_expired"); expect(expired.requests).toHaveLength(0);
    const cleanup = fixture({ cleanup: () => cleanup.harness.denyMetadataConsent() });
    await cleanup.ready(); await expect(cleanup.harness.discover()).rejects.toThrow("approval_changed"); expect(cleanup.requests).toHaveLength(3);
  });
  it.each([401,403,404,302])("fails closed on HTTP %i", async status => { const f = fixture({ status }); await f.ready(); await expect(f.harness.discover()).rejects.toThrow(); expect(f.requests).toHaveLength(1); });
  it("enforces response and original deadline bounds", async () => {
    const small = fixture({ limits: { responseBytes: 1 } }); await small.ready(); await expect(small.harness.discover()).rejects.toThrow("response_limit");
    const slow = fixture({ metadata: () => slow.advance(31_000) }); await slow.ready(); await expect(slow.harness.discover()).rejects.toThrow("local_stopped"); expect(slow.requests).toHaveLength(1);
  });
  it.each([[{ name: "A", type: "STRING" }, { name: "a", type: "STRING" }], [{ name: "x", type: "UNREVIEWED" }], Array.from({ length: 501 }, (_, i) => ({ name: `x${i}`, type: "STRING" }))])("rejects invalid or excessive public schema %#", async fields => {
    const f = fixture({ table: { tableReference: { projectId: source.sourceProject, datasetId: source.datasetId, tableId: source.tableId }, type: "TABLE", schema: { fields } } });
    await f.ready(); await expect(f.harness.discover()).rejects.toThrow();
  });
});
