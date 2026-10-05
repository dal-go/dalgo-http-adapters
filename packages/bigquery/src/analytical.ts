/** Pure browser-compatible A0 foundation. It has no DALgo runtime import and
 * does not submit jobs, provide approval/ledger controls or expose job cursors.
 */
export { canonicalJSON, hashPayload } from "./analytical/canonical.js";
export type { HashPayloadName, HashedPayload } from "./analytical/canonical.js";
export { operationDeadline } from "./analytical/deadline.js";
export type { DeadlineInput } from "./analytical/deadline.js";
export { decodeRows, normalizeScalar, normalizeScalarBytes } from "./analytical/values.js";
export type { AnalyticalCell, AnalyticalField } from "./analytical/values.js";
export { AnalyticalError, JsonNumber, MAX_DEPTH, MAX_RESPONSE_BYTES, parseJSON } from "./analytical/wire.js";
export type { AnalyticalErrorCode, JsonValue } from "./analytical/wire.js";
