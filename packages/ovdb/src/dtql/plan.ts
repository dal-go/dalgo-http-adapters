import {
  canonicalProviderEvidence, validateProviderReadPlan, validateProviderReads, validateSourceLeafAdmission,
  type ProviderReadPlan, type QueryMetadata, type SourceRight,
} from "@dalgo/core";
import { assertOpenVaultDbExecutionId, assertOpenVaultDbExecutionBudget, raceOpenVaultDbExecutionBudget, type OpenVaultDbExecutionBudget } from "./budget.js";

import { nativeCalendarDate } from "./wire.js";

const PATH = "/ecb-public/v1/databases/ecb/dtql";
const RESOURCE = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const DEFINITION = "399ce77bc4513b1a819f61e26a54fe8e6c46569b2b45ea078582d9ad6758697e";
const DECODER = "20477d567705fe7cf8115caf696848b9ea1db2e1a165b977a4f54bd610955b49";
const RIGHTS = "08669fda7a7d255d1c77d2be733e587a23bb2ff1a916e96c727b82d2540cdc93";

/** Independently pinned public document. Presence or matching digests do not confer admission. */
export interface OpenVaultDbPublicAdmission {
  readonly format: "ovdb-ecb-public-free-admission/1";
  readonly decision: "public-free-transient-read-only";
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly costOwner: string;
  readonly hostConfigSHA256: string;
  readonly publisherManifestSHA256: string;
  readonly decoderModuleVersion: "v0.4.0";
  readonly decoderSHA256: string;
  readonly rightsDigest: string;
  readonly requestProfile: "ecb-public-free/1";
  readonly workerPath: typeof PATH;
  readonly goPath: "/v1/databases/ecb/dtql";
  readonly directoryOrigin: string;
  readonly backendOrigin: string;
  readonly audience: "public-free";
  readonly paidAccess: false;
  readonly maxReads: 1;
  readonly maxRows: 50;
  readonly maxConcurrent: 1;
  readonly executionsPerMinute: 6;
}
export interface OpenVaultDbDTQLPlanConfiguration {
  readonly endpoint: string;
  readonly expectedServerId: "openvaultdb-cloud";
  readonly databaseId: "ecb";
  readonly collectionName: "daily";
  readonly requestProfile: "ecb-public-free/1";
  /** Actual host origin, supplied independently; browsers also compare location.origin. */
  readonly origin: string;
  readonly admission: OpenVaultDbPublicAdmission;
  /** Full independently verified immutable right, never reconstructed from the response. */
  readonly sourceRight: SourceRight;
}
const matches = (value: unknown, expected: unknown): boolean => value === expected;
const refuse = (): never => { throw new TypeError("refused OpenVaultDB DTQL admission"); };
function httpsOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.origin !== raw) refuse();
  return url.origin;
}
export function assertOpenVaultDbDTQLConfiguration(config: OpenVaultDbDTQLPlanConfiguration): void {
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port
    || config.endpoint !== endpoint.origin + PATH) refuse();
  const a = config.admission;
  const keys = ["format", "decision", "approvedBy", "approvedAt", "expiresAt", "costOwner", "hostConfigSHA256", "publisherManifestSHA256", "decoderModuleVersion", "decoderSHA256", "rightsDigest", "requestProfile", "workerPath", "goPath", "directoryOrigin", "backendOrigin", "audience", "paidAccess", "maxReads", "maxRows", "maxConcurrent", "executionsPerMinute"];
  if (Object.keys(a).length !== keys.length || keys.some(key => !Object.hasOwn(a, key))) refuse();
  const approved = Date.parse(a.approvedAt), expires = Date.parse(a.expiresAt), now = Date.now();
  if (!Number.isFinite(approved) || !Number.isFinite(expires) || approved > now || expires <= now
    || expires <= approved || expires - approved > 30 * 86400_000
    || !a.approvedBy.trim() || !a.costOwner.trim() || !/^[0-9a-f]{64}$/u.test(a.hostConfigSHA256)
    || !matches(a.format, "ovdb-ecb-public-free-admission/1") || !matches(a.decision, "public-free-transient-read-only")
    || a.publisherManifestSHA256 !== DEFINITION || a.decoderSHA256 !== DECODER || a.rightsDigest !== RIGHTS
    || !matches(a.decoderModuleVersion, "v0.4.0") || !matches(a.requestProfile, "ecb-public-free/1")
    || !matches(a.workerPath, PATH) || !matches(a.goPath, "/v1/databases/ecb/dtql") || !matches(a.audience, "public-free")
    || !matches(a.paidAccess, false) || !matches(a.maxReads, 1) || !matches(a.maxRows, 50) || !matches(a.maxConcurrent, 1) || !matches(a.executionsPerMinute, 6)
    || !matches(config.expectedServerId, "openvaultdb-cloud") || !matches(config.databaseId, "ecb") || !matches(config.collectionName, "daily")
    || !matches(config.requestProfile, a.requestProfile) || httpsOrigin(config.origin) !== httpsOrigin(a.directoryOrigin)
    || !new URL(httpsOrigin(a.backendOrigin)).hostname.endsWith(".run.app")
    || (typeof location !== "undefined" && location.origin !== config.origin)) refuse();
}
/** Structural and immutable binding checks; the host owns authorization and artifact verification. */
export async function validateOpenVaultDbDTQLPlan(
  configuration: OpenVaultDbDTQLPlanConfiguration, plan: ProviderReadPlan, budget: OpenVaultDbExecutionBudget,
): Promise<void> {
  const config = structuredClone(configuration), captured = structuredClone(plan);
  assertOpenVaultDbExecutionBudget(budget);
  try {
    assertOpenVaultDbDTQLConfiguration(config);
    assertOpenVaultDbExecutionId(budget, captured.execution.id);
    validateProviderReadPlan(captured);
    const binding = captured.bindings[0], request = captured.requests[0], right = captured.sourceRights[0];
    if (captured.execution.mode !== "proxy" || captured.execution.executorId !== config.expectedServerId
      || !/^[a-f0-9]{32}$/u.test(captured.execution.id) || captured.bindings.length !== 1 || captured.requests.length !== 1
      || captured.sourceRights.length !== 1 || captured.usedSourceIds.length !== 1 || captured.maxReads !== 1
      || binding?.providerSourceId !== "provider:ecb/FxReferenceQuote" || binding.rightsSourceId !== "ovdb:openvaultdb-cloud/ecb/daily"
      || binding.resourceId !== "ecb-daily" || binding.definitionDigest !== DEFINITION || binding.decoderDigest !== DECODER || binding.rightsDigest !== RIGHTS
      || request?.resourceId !== binding.resourceId || !matches(request.method, "GET") || request.upstreamUrl !== RESOURCE || Object.keys(request.params).length !== 0
      || right?.sourceId !== binding.rightsSourceId || captured.usedSourceIds[0] !== right.sourceId
      || right.source.serverId !== config.expectedServerId || right.source.databaseId !== config.databaseId || right.source.recordset !== config.collectionName
      || canonicalProviderEvidence(right) !== canonicalProviderEvidence(config.sourceRight)) refuse();
    await raceOpenVaultDbExecutionBudget(budget, validateSourceLeafAdmission({ kind: "provider-get", plan: captured }));
    assertOpenVaultDbDTQLConfiguration(config);
    assertOpenVaultDbExecutionBudget(budget);
  } catch {
    assertOpenVaultDbExecutionBudget(budget);
    refuse();
  }
}
/** Thin released-core evidence facade, with one native observation and the shared deadline. */
export async function validateOpenVaultDbDTQLEvidence(
  metadata: QueryMetadata, plan: ProviderReadPlan, budget: OpenVaultDbExecutionBudget,
): Promise<QueryMetadata> {
  const captured = structuredClone(plan);
  assertOpenVaultDbExecutionBudget(budget);
  try {
    assertOpenVaultDbExecutionId(budget, captured.execution.id);
    if (!Array.isArray(metadata.providerReads?.reads) || metadata.providerReads.reads.length !== 1) throw new TypeError();
    const result = await raceOpenVaultDbExecutionBudget(budget, validateProviderReads(metadata, captured));
    const read = result.providerReads?.reads[0];
    if (result.providerReads?.reads.length !== 1 || !nativeCalendarDate(read?.referenceDate) || read.bytes > 2 * 1024 * 1024) throw new TypeError();
    assertOpenVaultDbExecutionBudget(budget);
    return result;
  } catch {
    assertOpenVaultDbExecutionBudget(budget);
    throw new TypeError("refused OpenVaultDB DTQL evidence");
  }
}
