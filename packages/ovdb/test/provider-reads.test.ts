import {
  collection, providerEvidenceDigest, type ProviderReadPlan, type QueryMetadata, type SourceRight,
} from "@dalgo/core";
import { describe, expect, it, vi } from "vitest";
import { OpenVaultDbClient, OpenVaultDbDatabase } from "../src/index.js";

// Fabricated declarations and observations only. No upstream response fixtures.
async function fixture(): Promise<{ metadata: QueryMetadata; plan: ProviderReadPlan }> {
  const hash = "a".repeat(64);
  const url = "https://provider.example/daily.xml";
  const right: SourceRight = {
    sourceId: "ovdb:gateway/db/daily", source: { serverId: "gateway", databaseId: "db", recordset: "daily" },
    declaration: { text: "Synthetic terms\n\tPreserved exactly", url: "https://provider.example/terms#reuse" },
    declarationScope: "database", declaredAt: { serverId: "gateway", databaseId: "db" },
    evidenceOrigin: "publisher-definition-verified", pins: [], transformations: ["Synthetic XML to rows"],
    attribution: { text: "Synthetic provider" }, freeSource: { text: "Free original", url },
  };
  const execution = { id: "synthetic-execution", mode: "proxy" as const, executorId: "gateway" };
  const binding = {
    providerSourceId: "provider:synthetic/Quote", rightsSourceId: right.sourceId, resourceId: "daily",
    definitionDigest: hash, decoderDigest: hash,
    rightsDigest: await providerEvidenceDigest({ format: "ovdb-rights-binding/1", right }),
  };
  const request = { resourceId: "daily", method: "GET" as const, upstreamUrl: url, params: {} };
  const observation = {
    resourceId: "daily", requestDigest: await providerEvidenceDigest({ format: "ovdb-resource-request/1", ...request }),
    fetchedAt: "2026-10-06T09:00:00Z", upstreamUrl: url, status: 200, contentType: "text/xml",
    sha256: hash, bytes: 42, referenceDate: "2026-10-05", attestation: "proxy-executor-observed" as const,
  };
  const read = { ...observation, observationId: await providerEvidenceDigest({
    format: "ovdb-read-observation-id/1", execution, binding, read: observation,
  }) };
  return {
    metadata: {
      sourceRights: [right], usedSourceIds: [right.sourceId], providerReads: {
        format: "ovdb-provider-read/1", execution, bindings: [binding], reads: [read],
        usage: [{ providerSourceId: binding.providerSourceId, rightsSourceId: right.sourceId, observationIds: [read.observationId] }],
      },
    },
    plan: structuredClone({ execution, bindings: [binding], requests: [request], sourceRights: [right], usedSourceIds: [right.sourceId] }),
  };
}

function response(metadata: unknown, records: unknown = [], cache = "no-store"): Response {
  return new Response(JSON.stringify({ records, ...metadata as object }), {
    headers: { "Content-Type": "application/json", "Cache-Control": cache },
  });
}

function fetchResponse(make: () => Response): typeof globalThis.fetch {
  return () => Promise.resolve(make());
}

function database(fetcher: typeof globalThis.fetch, expectedServerId: string | null = "gateway"): OpenVaultDbDatabase {
  return new OpenVaultDbDatabase({
    baseUrl: "https://gateway.example", databaseId: "db", fetch: fetcher,
    ...(expectedServerId === null ? {} : { expectedServerId }),
  });
}
const daily = collection<{ rate: string }>("daily");

describe("OpenVaultDB provider reads transport", () => {
  it("preserves exact detached evidence for empty and populated results", async () => {
    for (const records of [[], [{ key: "daily/synthetic", data: { rate: "001.23000" } }]]) {
      const { metadata, plan } = await fixture();
      const db = database(fetchResponse(() => response(metadata, records)));
      const page = await db.query(daily.query().build(), { providerReadPlan: plan });
      expect(page).toMatchObject(metadata);
      expect(page.records.map((record) => record.data.rate)).toEqual(records.length === 0 ? [] : ["001.23000"]);
      Object.assign(plan.execution, { id: "later execution" });
      expect(page.providerReads?.execution.id).toBe("synthetic-execution");
    }
  });

  it("preserves legacy rights and absent metadata without claiming required evidence", async () => {
    const { metadata } = await fixture();
    const legacy = { sourceRights: metadata.sourceRights, usedSourceIds: metadata.usedSourceIds };
    expect(await database(fetchResponse(() => response(legacy))).query(daily.query().build())).toEqual({ records: [], ...legacy });
    expect(await database(fetchResponse(() => response({}))).query(daily.query().build())).toEqual({ records: [] });
  });

  it("refuses unsolicited or missing evidence and malformed envelopes before codec output", async () => {
    const { metadata, plan } = await fixture();
    const decode = vi.fn((value: unknown) => value);
    const query = collection("daily", { codec: { encode: (value: unknown) => value, decode } }).query().build();
    const records = [{ key: "daily/synthetic", data: { rate: "001.23000" } }];
    await expect(database(fetchResponse(() => response(metadata, records))).query(query)).rejects.toThrow("independently admitted plan");
    await expect(database(fetchResponse(() => response({}, records))).query(query, { providerReadPlan: plan })).rejects.toThrow();
    const malformed = { ...metadata, providerReads: { ...metadata.providerReads, body: "forbidden synthetic body" } };
    await expect(database(fetchResponse(() => response(malformed, records))).query(query, { providerReadPlan: plan })).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  });

  it("refuses changed rights, immutable bindings, request digests and usage", async () => {
    for (const kind of ["rights", "definition", "request", "usage"] as const) {
      const { metadata, plan } = await fixture();
      if (kind === "rights") Object.assign(metadata.sourceRights?.[0]?.declaration ?? {}, { text: "changed" });
      if (kind === "definition") Object.assign(metadata.providerReads?.bindings[0] ?? {}, { definitionDigest: "b".repeat(64) });
      if (kind === "request") Object.assign(metadata.providerReads?.reads[0] ?? {}, { requestDigest: "b".repeat(64) });
      if (kind === "usage") Object.assign(metadata.providerReads ?? {}, { usage: [] });
      await expect(database(fetchResponse(() => response(metadata))).query(daily.query().build(), { providerReadPlan: plan })).rejects.toThrow();
    }
  });

  it("checks configured server, database and recordset before network I/O", async () => {
    for (const field of ["serverId", "databaseId", "recordset"] as const) {
      const { plan } = await fixture();
      Object.assign(plan.sourceRights[0]?.source ?? {}, { [field]: "wrong" });
      const fetcher = vi.fn<typeof globalThis.fetch>();
      await expect(database(fetcher).query(daily.query().build(), { providerReadPlan: plan })).rejects.toThrow("queried source");
      expect(fetcher).not.toHaveBeenCalled();
    }
    const { plan } = await fixture();
    await expect(database(vi.fn<typeof globalThis.fetch>(), null).query(daily.query().build(), { providerReadPlan: plan })).rejects.toThrow("expectedServerId");
  });

  it("enforces the independently admitted read and metadata budgets", async () => {
    for (const limits of [{ maxReads: 0 }, { maxMetadataBytes: 1 }]) {
      const { metadata, plan } = await fixture();
      await expect(database(fetchResponse(() => response(metadata))).query(daily.query().build(), {
        providerReadPlan: { ...plan, ...limits },
      })).rejects.toThrow();
    }
  });

  it("captures the plan and wire query before an asynchronous token provider", async () => {
    const { metadata, plan } = await fixture();
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(await new Request(input, init).json()).toEqual({ collection: "daily", limit: 2 });
      return response(metadata);
    });
    const db = new OpenVaultDbDatabase({
      baseUrl: "https://gateway.example", databaseId: "db", expectedServerId: "gateway", fetch: fetcher,
      getAccessToken: async () => { await wait; return "synthetic token"; },
    });
    const query = daily.query().limit(2).build();
    const pending = db.query(query, { providerReadPlan: plan });
    Object.assign(plan.execution, { id: "racing mutation" });
    Object.assign(query, { limit: 100 });
    release?.();
    expect((await pending).providerReads?.execution.id).toBe("synthetic-execution");
  });

  it("requires response no-store and forces fetch no-store, omitted cookies and redirect refusal", async () => {
    const { metadata, plan } = await fixture();
    await expect(database(fetchResponse(() => response(metadata, [], "public, max-age=30")))
      .query(daily.query().build(), { providerReadPlan: plan })).rejects.toThrow("Cache-Control no-store");
    const fetcher = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      expect(request.cache).toBe("no-store");
      expect(request.credentials).toBe("omit");
      expect(request.redirect).toBe("error");
      return Promise.resolve(response({}));
    });
    const client = new OpenVaultDbClient({ baseUrl: "https://gateway.example", databaseId: "db", fetch: fetcher });
    await client.request(client.queryPath(), { cache: "force-cache", redirect: "follow", credentials: "include" });
  });

  it("refuses malformed records, invalid UTF-8 and oversized responses", async () => {
    for (const records of [{}, [null], [{ key: 1, data: {} }], [{ key: "daily/synthetic" }]]) {
      await expect(database(fetchResponse(() => response({}, records))).query(daily.query().build())).rejects.toThrow();
    }
    await expect(database(fetchResponse(() => new Response(new Uint8Array([255])))).query(daily.query().build())).rejects.toThrow();
    await expect(database(fetchResponse(() => new Response(" ".repeat(2 * 1024 * 1024 + 1)))).query(daily.query().build())).rejects.toThrow("exceeds 2 MiB");
  });

  it("preserves point-read legacy rights and refuses live evidence lacking a point-read plan API", async () => {
    const { metadata } = await fixture();
    const point = { key: "daily/synthetic", data: { rate: "001.23000" } };
    const legacy = { sourceRights: metadata.sourceRights, usedSourceIds: metadata.usedSourceIds };
    const result = await database(fetchResponse(() => new Response(JSON.stringify({ ...point, ...legacy })))).get(daily.key("synthetic"));
    expect(result.metadata).toMatchObject(legacy);
    await expect(database(fetchResponse(() => new Response(JSON.stringify({ ...point, ...metadata }))))
      .get(daily.key("synthetic"))).rejects.toThrow("provider point reads");
  });
});
