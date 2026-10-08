import { providerEvidenceDigest, type ProviderReadBinding, type ProviderReadPlan, type QueryMetadata, type SourceRight } from "@dalgo/core";
import { type OpenVaultDbDTQLPlanConfiguration } from "../src/dtql/index.js";

// Immutable declaration metadata from Cloud's reviewed publisher fixture.
// Observations and rows below are authored synthetic values; no upstream content.
const expected: { binding: ProviderReadBinding; right: SourceRight } = {
  "binding": {
    "providerSourceId": "provider:ecb/FxReferenceQuote",
    "rightsSourceId": "ovdb:openvaultdb-cloud/ecb/daily",
    "resourceId": "ecb-daily",
    "definitionDigest": "399ce77bc4513b1a819f61e26a54fe8e6c46569b2b45ea078582d9ad6758697e",
    "decoderDigest": "20477d567705fe7cf8115caf696848b9ea1db2e1a165b977a4f54bd610955b49",
    "rightsDigest": "08669fda7a7d255d1c77d2be733e587a23bb2ff1a916e96c727b82d2540cdc93"
  },
  "right": {
    "sourceId": "ovdb:openvaultdb-cloud/ecb/daily",
    "source": {
      "serverId": "openvaultdb-cloud",
      "databaseId": "ecb",
      "recordset": "daily"
    },
    "declaration": {
      "name": "ECB reuse conditions",
      "url": "https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html"
    },
    "declarationScope": "database",
    "declaredAt": {
      "serverId": "openvaultdb-cloud",
      "databaseId": "ecb"
    },
    "evidenceOrigin": "publisher-definition-verified",
    "pins": [
      {
        "role": "provider",
        "repository": "https://github.com/openvaultdb/ovdb",
        "revision": "c72f1e711041a85ec67d6fe86f7621ae4bde302e",
        "path": "publisher/source/ecb-daily/ovdb.yaml",
        "sha256": "399ce77bc4513b1a819f61e26a54fe8e6c46569b2b45ea078582d9ad6758697e",
        "bytes": 4504
      }
    ],
    "attribution": {
      "text": "Source: European Central Bank (ECB).",
      "url": "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html"
    },
    "freeSource": {
      "text": "The original ECB rates are available free of charge from the ECB website.",
      "url": "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
    },
    "transformations": [
      "ECB XML has been restructured into rows; EUR base context has been made explicit. Source rates and reference dates are preserved."
    ]
  }
};
export async function fixture(executionId = "0123456789abcdef0123456789abcdef"): Promise<{ config: OpenVaultDbDTQLPlanConfiguration; plan: ProviderReadPlan; metadata: QueryMetadata }> {
  const { binding, right } = structuredClone(expected);
  const execution = { id: executionId, mode: "proxy" as const, executorId: "openvaultdb-cloud" };
  const request = { resourceId: "ecb-daily", method: "GET" as const, upstreamUrl: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", params: {} };
  const plan = { execution, bindings: [binding], requests: [request], sourceRights: [right], usedSourceIds: [right.sourceId], maxReads: 1 };
  const observation = { resourceId: "ecb-daily", requestDigest: await providerEvidenceDigest({ format: "ovdb-resource-request/1", ...request }),
    fetchedAt: "2037-02-04T01:02:03Z", referenceDate: "2037-02-03", upstreamUrl: request.upstreamUrl, status: 200,
    contentType: "application/xml", bytes: 42, sha256: "a".repeat(64), attestation: "proxy-executor-observed" as const };
  const read = { ...observation, observationId: await providerEvidenceDigest({ format: "ovdb-read-observation-id/1", execution, binding, read: observation }) };
  const metadata = { sourceRights: [right], usedSourceIds: [right.sourceId], providerReads: {
    format: "ovdb-provider-read/1" as const, execution, bindings: [binding], reads: [read],
    usage: [{ providerSourceId: binding.providerSourceId, rightsSourceId: binding.rightsSourceId, observationIds: [read.observationId] }],
  } };
  const config: OpenVaultDbDTQLPlanConfiguration = { endpoint: "https://worker.example/ecb-public/v1/databases/ecb/dtql",
    expectedServerId: "openvaultdb-cloud", databaseId: "ecb", collectionName: "daily", requestProfile: "ecb-public-free/1",
    origin: "https://directory.example", sourceRight: right,
    admission: { format: "ovdb-ecb-public-free-admission/1", decision: "public-free-transient-read-only", approvedBy: "synthetic fixture",
      approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(), costOwner: "synthetic fixture",
      hostConfigSHA256: "a".repeat(64), publisherManifestSHA256: binding.definitionDigest, decoderModuleVersion: "v0.4.0", decoderSHA256: binding.decoderDigest,
      rightsDigest: binding.rightsDigest, requestProfile: "ecb-public-free/1", workerPath: "/ecb-public/v1/databases/ecb/dtql", goPath: "/v1/databases/ecb/dtql",
      directoryOrigin: "https://directory.example", backendOrigin: "https://synthetic.run.app", audience: "public-free", paidAccess: false,
      maxReads: 1, maxRows: 50, maxConcurrent: 1, executionsPerMinute: 6 },
  };
  return { config, plan, metadata };
}
export const rows = [{ key: "daily/AAA", data: { time: "2037-02-03", currency: "AAA", rate: "001.23000" } }];
export function response(metadata: QueryMetadata, records: unknown = rows, extra: object = {}): Response {
  return new Response(JSON.stringify({ records, complete: true, ...metadata, ...extra }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
