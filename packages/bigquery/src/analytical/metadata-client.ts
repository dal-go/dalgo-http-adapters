import { object, same } from "./metadata.js";
import { bounds, cloneFrozen, exactKeys, identifier, integerText, nonempty, project, timestamp, validatePrincipal, type Bounds, type Principal } from "./protocol.js";
import { abortable, realClock, Transport, type Clock, type IdentityProvider, type OperationScope, type SafeFetch } from "./transport.js";
import { AnalyticalError, fail, type JsonValue } from "./wire.js";

/** A trusted consumer allowlist, not a locator accepted from user input. */
export interface MetadataSource {
  readonly sourceId: string;
  readonly sourceProject: string;
  readonly datasetId: string;
  readonly tableId: string;
}
/** The application owner's explicit metadata consent is distinct from Google
 * OAuth grants. The protected callback must read current owner-scoped state. */
export interface MetadataConsent {
  readonly purpose: "metadata-only";
  readonly ownerId: string;
  readonly consentId: string;
  readonly source: MetadataSource;
  readonly principal: Principal;
  readonly selectedJobProject: string;
}
export type MetadataLimits = Pick<Bounds, "responseBytes" | "totalResponseBytes" | "wallMs" | "httpMs">;
export interface MetadataClientConfig {
  readonly sources: readonly MetadataSource[];
  readonly provider: IdentityProvider;
  readonly authorizeMetadata: (source: MetadataSource, signal: AbortSignal) => Promise<MetadataConsent>;
  readonly limits?: Partial<MetadataLimits>;
  readonly fetch?: SafeFetch;
  readonly clock?: Clock;
}
export interface MetadataOptions {
  readonly signal?: AbortSignal;
  readonly deadline?: number;
}
/** Deliberately partial native metadata projection. Nested schema/configuration
 * is preserved as lossless JSON; this is not an execution schema or rights proof. */
export interface MetadataDiscovery {
  readonly source: MetadataSource;
  readonly consent: MetadataConsent;
  readonly dataset: Readonly<Record<string, JsonValue>>;
  readonly table: Readonly<Record<string, JsonValue>>;
  readonly observedAt: string;
  readonly responseBytes: number;
  readonly status: "inactive";
  readonly queryAdmission: "blocked";
  readonly costAdmission: "not-granted";
  readonly projectPermissions: "unverified";
  readonly billing: "unverified";
  readonly sourceRights: "unreviewed";
  readonly providerRetentionAuthorization: "not-granted";
}
function source(value: MetadataSource): void {
  exactKeys(value, ["sourceId", "sourceProject", "datasetId", "tableId"]);
  nonempty(value.sourceId, 128);
  project(value.sourceProject);
  identifier(value.datasetId);
  identifier(value.tableId);
}
function consent(value: MetadataConsent, expected: MetadataSource): void {
  exactKeys(value, ["purpose", "ownerId", "consentId", "source", "principal", "selectedJobProject"]);
  if (value.purpose !== "metadata-only") fail("approval_required");
  nonempty(value.ownerId);
  nonempty(value.consentId);
  source(value.source);
  if (!same(value.source, expected)) fail("approval_changed");
  validatePrincipal(value.principal);
  if (value.principal.kind !== "google-user") fail("auth_required");
  project(value.selectedJobProject);
}
function wireText(value: JsonValue | undefined, maximum = 1024): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) fail("malformed_wire");
}
function nativeSchema(value: JsonValue | undefined): void {
  const schema = object(value);
  let count = 0;
  const fields = (value: JsonValue | undefined, depth: number): void => {
    if (!Array.isArray(value) || value.length === 0) fail("malformed_wire");
    if (depth > 8) fail("response_limit");
    const names = new Set<string>();
    for (const raw of value) {
      if (++count > 1024) fail("response_limit");
      const field = object(raw);
      wireText(field.name, 300);
      wireText(field.type, 64);
      if (!/^[A-Z][A-Z0-9_]*$/u.test(field.type) || names.has(field.name)) fail("malformed_wire");
      names.add(field.name);
      if (field.mode !== undefined && !["NULLABLE", "REQUIRED", "REPEATED"].includes(String(field.mode))) fail("malformed_wire");
      if ((field.type === "RECORD" || field.type === "STRUCT") !== Object.hasOwn(field, "fields")) fail("malformed_wire");
      if (field.fields !== undefined) fields(field.fields, depth + 1);
    }
  };
  fields(schema.fields, 0);
}
function projection(raw: JsonValue, expected: MetadataSource, table: boolean): Readonly<Record<string, JsonValue>> {
  const value = object(raw);
  const referenceKey = table ? "tableReference" : "datasetReference";
  const reference = object(value[referenceKey]);
  exactKeys(reference, table ? ["projectId", "datasetId", "tableId"] : ["projectId", "datasetId"], [], "malformed_wire");
  if (reference.projectId !== expected.sourceProject || reference.datasetId !== expected.datasetId || table && reference.tableId !== expected.tableId) fail("source_changed");
  // Dataset location is authoritative for this discovery; do not assume US.
  if (!table || Object.hasOwn(value, "location")) wireText(value.location, 64);
  if (table) {
    wireText(value.type, 64);
    nativeSchema(value.schema);
  }
  for (const key of ["etag", "lastModifiedTime"] as const) {
    if (!Object.hasOwn(value, key)) continue;
    if (key === "lastModifiedTime") integerText(value[key]);
    else wireText(value[key]);
  }
  const keys = table
    ? [referenceKey, "type", "location", "etag", "lastModifiedTime", "schema", "timePartitioning", "rangePartitioning", "clustering", "requirePartitionFilter"]
    : [referenceKey, "location", "etag", "lastModifiedTime"];
  const result: Record<string, JsonValue> = {};
  for (const key of keys) if (Object.hasOwn(value, key)) result[key] = value[key] as JsonValue;
  return result;
}

/** No query, dry-run, row, ledger, export or cost-admission method exists here. */
export class BigQueryMetadataClient {
  readonly #sources: ReadonlyMap<string, MetadataSource>;
  readonly #authorize: MetadataClientConfig["authorizeMetadata"];
  readonly #transport: Transport;
  readonly #clock: Clock;
  readonly #bounds: Bounds;
  #active = false;
  public constructor(config: MetadataClientConfig) {
    exactKeys(config, ["sources", "provider", "authorizeMetadata"], ["limits", "fetch", "clock"]);
    if (!Array.isArray(config.sources) || config.sources.length < 1 || config.sources.length > 128 || typeof config.authorizeMetadata !== "function") fail("invalid_input");
    const sources = cloneFrozen(config.sources);
    sources.forEach(source);
    if (new Set(sources.map(value => value.sourceId)).size !== sources.length) fail("invalid_input");
    this.#sources = new Map(sources.map(value => [value.sourceId, value]));
    this.#authorize = config.authorizeMetadata;
    exactKeys(config.limits ?? {}, [], ["responseBytes", "totalResponseBytes", "wallMs", "httpMs"]);
    this.#bounds = bounds({ responseBytes: 256 * 1024, totalResponseBytes: 1024 * 1024, wallMs: 30000, ...(config.limits ?? {}) });
    this.#clock = config.clock ?? realClock;
    this.#transport = new Transport(config.provider, config.fetch ?? ((url, init) => globalThis.fetch(url, init)), this.#clock);
  }
  public async discover(sourceId: string, options: MetadataOptions = {}): Promise<MetadataDiscovery> {
    nonempty(sourceId, 128);
    const requested = this.#sources.get(sourceId);
    if (requested === undefined) fail("policy_denied");
    exactKeys(options, [], ["signal", "deadline"]);
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof globalThis.AbortSignal)) fail("invalid_input");
    const now = this.#clock.now();
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(now + this.#bounds.wallMs) || options.deadline !== undefined && !Number.isSafeInteger(options.deadline)) fail("invalid_input");
    const deadline = Math.min(now + this.#bounds.wallMs, options.deadline ?? Number.MAX_SAFE_INTEGER);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal?.aborted || now >= deadline) fail("local_stopped");
    if (this.#active) fail("policy_denied");
    this.#active = true;
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, deadline - now);
    try {
      // The overall abort race bounds preparation, retries and injected sleeps,
      // even if a trusted integration ignores its signal.
      return await abortable(this.#discover(requested, deadline, controller.signal), controller.signal);
    } finally {
      controller.abort();
      this.#active = false;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  async #attest(requested: MetadataSource, signal: AbortSignal): Promise<MetadataConsent> {
    if (signal.aborted) fail("local_stopped");
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.#bounds.httpMs);
    try {
      const prepared = cloneFrozen(await abortable(this.#authorize(requested, controller.signal), controller.signal));
      if (controller.signal.aborted) fail("local_stopped");
      consent(prepared, requested);
      return prepared;
    } catch (error) {
      if (error instanceof AnalyticalError) throw error;
      return fail("approval_required");
    } finally {
      controller.abort();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  async #discover(requested: MetadataSource, deadline: number, signal: AbortSignal): Promise<MetadataDiscovery> {
    const prepared = await this.#attest(requested, signal);
    await this.#transport.verify(prepared.principal, deadline, signal);
    let bytes = 0;
    const scope: OperationScope = {
      bounds: this.#bounds, principal: prepared.principal, executionDeadline: deadline, signal,
      remaining: async () => this.#bounds.totalResponseBytes - bytes,
      debit: async count => { bytes += count; if (bytes > this.#bounds.totalResponseBytes) fail("response_limit"); },
      beforeDispatch: async () => {
        const current = await this.#attest(requested, signal);
        if (!same(current, prepared)) fail("approval_changed");
        // Consent preparation can disconnect/rotate the Google account while
        // the transport awaits. Reverify before the physical dispatch.
        await this.#transport.verify(prepared.principal, Math.min(deadline, this.#clock.now() + this.#bounds.httpMs), signal);
      },
    };
    try {
      const path = `projects/${requested.sourceProject}/datasets/${requested.datasetId}`;
      const dataset = projection(await this.#transport.call(scope, "GET", path, { datasetView: "METADATA" }), requested, false);
      const table = projection(await this.#transport.call(scope, "GET", `${path}/tables/${requested.tableId}`, { view: "STORAGE_STATS" }), requested, true);
      if (table.location !== undefined && table.location !== dataset.location) fail("source_changed");
      if (!same(await this.#attest(requested, signal), prepared)) fail("approval_changed");
      await this.#transport.verify(prepared.principal, Math.min(deadline, this.#clock.now() + this.#bounds.httpMs), signal);
      if (signal.aborted || this.#clock.now() >= deadline) fail("local_stopped");
      return cloneFrozen({
        source: requested, consent: prepared, dataset, table, observedAt: timestamp(this.#clock.now()), responseBytes: bytes,
        status: "inactive", queryAdmission: "blocked", costAdmission: "not-granted", projectPermissions: "unverified", billing: "unverified", sourceRights: "unreviewed", providerRetentionAuthorization: "not-granted",
      });
    } catch (error) {
      // The shared execution transport calls a missing resource result_expired;
      // discovery never implies a result job existed.
      if (error instanceof AnalyticalError && error.code === "result_expired") fail("remote_failed");
      throw error;
    }
  }
}
