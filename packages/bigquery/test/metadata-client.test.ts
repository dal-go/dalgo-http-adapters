import { describe, expect, it, vi } from "vitest";
import { BigQueryMetadataClient, type MetadataClientConfig, type MetadataConsent, type MetadataSource, type TrustedIdentity } from "../src/analytical.js";
const source: MetadataSource = { sourceId: "fabricated-metadata", sourceProject: "source-project", datasetId: "synthetic", tableId: "metadata" };
const principal = { kind: "google-user" as const, subject: "verified-subject", generation: "generation-1" };
const consent: MetadataConsent = { purpose: "metadata-only", ownerId: "app-owner", consentId: "metadata-consent-1", source, principal, selectedJobProject: "future-job-project" };
const dataset = { datasetReference: { projectId: source.sourceProject, datasetId: source.datasetId }, location: "EU", etag: "dataset-etag", lastModifiedTime: "1893456000000" };
const table = {
  tableReference: { ...dataset.datasetReference, tableId: source.tableId }, type: "TABLE", location: "EU", etag: "table-etag", lastModifiedTime: "1893456000001",
  schema: { fields: [
    { name: "native_year", type: "INTEGER", mode: "NULLABLE", description: "Synthetic native year" },
    { name: "native_text_year", type: "STRING", mode: "NULLABLE" },
    { name: "native_nested", type: "RECORD", mode: "REPEATED", fields: [{ name: "coordinates", type: "GEOGRAPHY", mode: "REQUIRED" }] },
    { name: "native_range", type: "RANGE", rangeElementType: { type: "DATE" } },
  ] },
  timePartitioning: { type: "DAY", field: "native_day" }, clustering: { fields: ["native_year"] }, requirePartitionFilter: true,
  // Discovery is explicitly partial and does not publish source rows/statistics.
  numRows: "1234", externalDataConfiguration: { sourceUris: ["gs://fabricated/fixture"] },
};
function fixture(overrides: Partial<MetadataClientConfig> = {}) {
  const identity: TrustedIdentity = { principal, accessToken: "secret-test-token", expiresAt: Date.now() + 60000, read: true, cancel: false };
  const authorize = vi.fn(async () => identity);
  const prepare = vi.fn(async () => consent);
  const fetcher = vi.fn(async (url: string, _init: RequestInit) => { void _init; return new Response(JSON.stringify(url.includes("/tables/") ? table : dataset)); });
  const config: MetadataClientConfig = { sources: [source], provider: { authorize }, authorizeMetadata: prepare, fetch: fetcher, ...overrides };
  return { client: new BigQueryMetadataClient(config), identity, config, authorize, prepare, fetcher };
}
describe("metadata-only browser discovery", () => {
  it("makes exactly two fixed metadata GETs, preserves native shape, and grants no execution/cost/rights", async () => {
    const { client, fetcher, prepare } = fixture();
    const result = await client.discover(source.sourceId);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://bigquery.googleapis.com/bigquery/v2/projects/source-project/datasets/synthetic?datasetView=METADATA",
      "https://bigquery.googleapis.com/bigquery/v2/projects/source-project/datasets/synthetic/tables/metadata?view=STORAGE_STATS",
    ]);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).not.toContain("secret-test-token");
      expect(url).not.toContain("future-job-project");
      expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", cache: "no-store", headers: { Authorization: "Bearer secret-test-token" } });
      expect(init.body).toBeUndefined();
      expect(init.headers).not.toHaveProperty("x-goog-user-project");
    }
    expect(prepare).toHaveBeenCalledTimes(4);
    expect(result.table.schema).toEqual(table.schema);
    expect(result.table).not.toHaveProperty("numRows");
    expect(result.table).not.toHaveProperty("externalDataConfiguration");
    expect(result).toMatchObject({ status: "inactive", queryAdmission: "blocked", costAdmission: "not-granted", projectPermissions: "unverified", billing: "unverified", sourceRights: "unreviewed", providerRetentionAuthorization: "not-granted", dataset });
    expect(result.responseBytes).toBe(JSON.stringify(dataset).length + JSON.stringify(table).length);
    expect(JSON.stringify(result)).not.toContain("secret-test-token");
    expect(Object.isFrozen(result.table.schema)).toBe(true);
    expect(Object.keys(Object.getPrototypeOf(client))).toEqual([]);
    expect("execute" in client || "preview" in client || "nextPage" in client).toBe(false);
  });
  it("refuses unallowlisted sources before consent, identity or network", async () => {
    const { client, authorize, prepare, fetcher } = fixture();
    await expect(client.discover("unapproved")).rejects.toThrow("policy_denied");
    expect(authorize).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { ...consent, purpose: "query" }, { ...consent, ownerId: "" }, { ...consent, selectedJobProject: "" },
    { ...consent, source: { ...source, tableId: "other" } }, { ...consent, principal: { ...principal, kind: "workload" } },
    { ...consent, accessToken: "must-not-be-accepted" },
  ])("rejects invalid protected consent before any metadata read", async value => {
    const { client, authorize, fetcher } = fixture({ authorizeMetadata: async () => value as MetadataConsent });
    await expect(client.discover(source.sourceId)).rejects.toThrow();
    expect(authorize).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["ownerId", "consentId", "selectedJobProject"] as const)("refuses changed %s before dispatch", async key => {
    let calls = 0;
    const { client, fetcher } = fixture({ authorizeMetadata: async () => ++calls === 1 ? consent : { ...consent, [key]: "changed-project" } });
    await expect(client.discover(source.sourceId)).rejects.toThrow("approval_changed");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rechecks account after consent preparation and refuses rotation before dispatch", async () => {
    let generation = principal.generation; let calls = 0;
    const { client, fetcher } = fixture({
      authorizeMetadata: async () => { if (++calls === 2) generation = "generation-2"; return consent; },
      provider: { authorize: async () => ({ principal: { ...principal, generation }, accessToken: "ephemeral", expiresAt: Date.now() + 60000, read: true, cancel: false }) },
    });
    await expect(client.discover(source.sourceId)).rejects.toThrow("approval_changed");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks consent again on GET retry and retains sanitized provider failures", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => new Response("secret-provider-body", { status: 503, headers: { "Retry-After": "0" } }));
    const { client } = fixture({
      authorizeMetadata: async () => ++calls <= 2 ? consent : { ...consent, consentId: "revoked" },
      fetch: fetcher,
    });
    await expect(client.discover(source.sourceId)).rejects.toThrow("approval_changed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("copies the allowlist before any await and freezes returned consent", async () => {
    const mutable = { ...source }; const sources = [mutable];
    const { client } = fixture({ sources });
    mutable.tableId = "unapproved"; sources.length = 0;
    const result = await client.discover(source.sourceId);
    expect(result.source.tableId).toBe(source.tableId);
    expect(Object.isFrozen(result.consent.source)).toBe(true);
  });
  it("refuses owner changes during the table response before delivering metadata", async () => {
    let ownerId = consent.ownerId;
    const { client } = fixture({
      authorizeMetadata: async () => ({ ...consent, ownerId }),
      fetch: async url => { if (url.includes("/tables/")) ownerId = "other-owner"; return new Response(JSON.stringify(url.includes("/tables/") ? table : dataset)); },
    });
    await expect(client.discover(source.sourceId)).rejects.toThrow("approval_changed");
  });
  it("allows only one active discovery per client and stops an aborted prepare", async () => {
    const controller = new AbortController();
    const { client, fetcher } = fixture({ authorizeMetadata: () => new Promise(() => {}) });
    const pending = client.discover(source.sourceId, { signal: controller.signal });
    const stopped = expect(pending).rejects.toThrow("local_stopped");
    await expect(client.discover(source.sourceId)).rejects.toThrow("policy_denied");
    controller.abort(); await stopped;
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["consent", "identity", "fetch", "stream"])("bounds ignored abort in %s", async stage => {
    const never = <T>(): Promise<T> => new Promise(() => {});
    const valid = fixture();
    const { client } = fixture({
      limits: { httpMs: 20, wallMs: 40 },
      authorizeMetadata: stage === "consent" ? () => never() : valid.config.authorizeMetadata,
      provider: stage === "identity" ? { authorize: () => never() } : valid.config.provider,
      fetch: stage === "fetch" ? () => never() : stage === "stream" ? async () => new Response(new ReadableStream({ pull: () => never() })) : valid.fetcher,
    });
    await expect(client.discover(source.sourceId)).rejects.toThrow("local_stopped");
  });
  it.each(["deadline", "abort"])("stops expired %s before authorization", async stage => {
    const { client, authorize, prepare, fetcher } = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(client.discover(source.sourceId, stage === "abort" ? { signal: controller.signal } : { deadline: Date.now() - 1 })).rejects.toThrow("local_stopped");
    expect(authorize).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([new Uint8Array([0xff]), new TextEncoder().encode('{"location":"EU","location":"US"}')])("rejects malformed UTF-8/duplicate JSON", async body => {
    const { client } = fixture({ fetch: async () => new Response(body) });
    await expect(client.discover(source.sourceId)).rejects.toThrow("malformed_wire");
  });
  it.each([200, 403, 503])("caps decompressed success/error bodies (status %s)", async status => {
    const { client } = fixture({ limits: { responseBytes: 8 }, fetch: async () => new Response(new Uint8Array(9), { status }) });
    await expect(client.discover(source.sourceId)).rejects.toThrow("response_limit");
  });
  it("charges dataset and table responses to one byte cap", async () => {
    const { client } = fixture({ limits: { totalResponseBytes: JSON.stringify(dataset).length + 1 } });
    await expect(client.discover(source.sourceId)).rejects.toThrow("response_limit");
  });
  it.each([401, 403, 404, 302])("never exposes provider failure body for status %s", async status => {
    const { client } = fixture({ fetch: async () => new Response("secret-provider-body secret-test-token", { status }) });
    const error = await client.discover(source.sourceId).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("secret");
    if (status === 404) expect(String(error)).toContain("remote_failed");
  });
  it.each([
    { ...dataset, datasetReference: { ...dataset.datasetReference, projectId: "wrong-project" } },
    { ...dataset, location: null },
  ])("refuses malformed/mismatched dataset evidence without a table request", async value => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(value)));
    const { client } = fixture({ fetch: fetcher });
    await expect(client.discover(source.sourceId)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...table, location: "US" }, { ...table, lastModifiedTime: 1893456000001 },
    { ...table, schema: { fields: [{ name: "broken", type: "RECORD" }] } },
  ])("refuses contradictory or malformed table metadata", async value => {
    const { client } = fixture({ fetch: async url => new Response(JSON.stringify(url.includes("/tables/") ? value : dataset)) });
    await expect(client.discover(source.sourceId)).rejects.toThrow();
  });
});
