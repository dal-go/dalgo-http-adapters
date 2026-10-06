/** Browser-compatible A0 analytical protocol with no DALgo runtime import.
 * Consumers inject trusted identity, protected read policy and durable session storage.
 */
export { canonicalJSON, hashPayload } from "./analytical/canonical.js";
export type { HashPayloadName, HashedPayload } from "./analytical/canonical.js";
export { operationDeadline } from "./analytical/deadline.js";
export type { DeadlineInput } from "./analytical/deadline.js";
export { decodeRows, normalizeScalar, normalizeScalarBytes } from "./analytical/values.js";
export type { AnalyticalCell, AnalyticalField } from "./analytical/values.js";
export { AnalyticalError, JsonNumber, MAX_DEPTH, MAX_RESPONSE_BYTES, parseJSON } from "./analytical/wire.js";
export type { AnalyticalErrorCode, JsonValue } from "./analytical/wire.js";

export { BigQueryAnalyticalClient, AnalyticalRun, Approval, ExecutionFailure, queryRequest } from "./analytical/client.js";
export type { ClientConfig, PreparedRead, OperationOptions, JobStatus, CancelResult } from "./analytical/client.js";
export { compileReadPlan, bounds } from "./analytical/protocol.js";
export type { SourceProfile, ReadQuery, ReadPlan, Parameter, CompiledPredicate, Principal, Execution, Bounds, SchemaField, Observation, JobRef, Receipt, Page } from "./analytical/protocol.js";
export { IndexedDBLedger, MemoryLedger } from "./analytical/ledger.js";
export type { Ledger, LedgerState, Preview } from "./analytical/ledger.js";
export type { TrustedIdentity, IdentityProvider, Clock, SafeFetch } from "./analytical/transport.js";
export { GoogleTokenIdentityProvider, googleAuthorizationScopes } from "./analytical/google-identity.js";
export type { GoogleTokenResponse, GoogleIdentitySummary, GoogleIdentityConfig } from "./analytical/google-identity.js";
export { BigQueryMetadataClient } from "./analytical/metadata-client.js";
export type { MetadataSource, MetadataConsent, MetadataLimits, MetadataClientConfig, MetadataOptions, MetadataDiscovery } from "./analytical/metadata-client.js";
