/** These are adapter boundaries, not declarations that Convex lacks writes/SQL. */
export const CONVEX_CAPABILITIES = Object.freeze({
  adapter: "@dalgo/dalgo2convex",
  storage: "native-query-functions",
  get: "CONFIGURED", exists: "CONFIGURED", getMany: "CONFIGURED",
  nativeQuery: "CONFIGURED", pagination: "CONFIGURED",
  metadata: "CONFIGURED", dynamicDiscovery: "NOT_IMPLEMENTED",
  structuredQuery: "NOT_IMPLEMENTED", writes: "NOT_IMPLEMENTED", transactions: "NOT_IMPLEMENTED",
  remoteExecutionCancellation: "UNVERIFIED", browserHostedCORS: "UNVERIFIED",
  cursorPersistenceAcrossReopen: "NOT_IMPLEMENTED",
} as const);
