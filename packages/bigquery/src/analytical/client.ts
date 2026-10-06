import { AnalyticalError, fail, parseJSON, type JsonValue } from "./wire.js";
import { canonicalJSON } from "./canonical.js";
import { decodeRows, type AnalyticalCell } from "./values.js";
import { decodeSchema, object, same, validateDataset, validateTable } from "./metadata.js";
import { bounds, checkDecimalConstraints, cloneFrozen, compileReadPlan, digest, encoded, exactKeys, integerText, nonempty, timestamp, validateExecution, validateSource, wireParameters, type Bounds, type Execution, type JobRef, type Observation, type Page, type ReadPlan, type ReadQuery, type Receipt, type SourceProfile } from "./protocol.js";
import { opaqueID, type CursorState, type Ledger, type Preview, type RunRecord } from "./ledger.js";
import { abortable, realClock, Transport, type Clock, type IdentityProvider, type OperationScope, type SafeFetch } from "./transport.js";
export interface PreparedRead {
  readonly source: SourceProfile;
  readonly query: ReadQuery;
  readonly policyDigest: string;
}
export interface ClientConfig {
  readonly profiles: readonly SourceProfile[];
  readonly prepare: (signal?: AbortSignal) => Promise<PreparedRead>;
  readonly provider: IdentityProvider;
  readonly ledger: Ledger;
  readonly fetch?: SafeFetch;
  readonly clock?: Clock;
}
export interface OperationOptions {
  readonly signal?: AbortSignal;
  readonly callerDeadline?: number;
}
export interface JobStatus {
  readonly job: JobRef;
  readonly state: "running" | "completed" | "failed" | "cancelled";
  readonly billedBytes?: string;
  readonly warnings: readonly string[];
}
export interface CancelResult {
  readonly job: JobRef;
  readonly state: "cancel_requested" | "unknown";
}
/** Capability minted by this client only; JSON cannot manufacture approval. */
export class Approval {
  readonly #opaque = true;
  private constructor() { void this.#opaque; }
  public static mint(): Approval { return new Approval(); }
}
interface Session {
  readonly accessPrincipal: Execution["principal"];
  readonly id: string;
  emptyDelivered: boolean;
  readonly controller: AbortController;
  rows: readonly (readonly AnalyticalCell[])[];
  index: number;
  loaded: boolean;
  done: boolean;
  mode: "" | "row" | "page";
  digest: string;
}
interface RunDriver {
  receipt(): Promise<Receipt>;
  schema(): Promise<readonly import("./protocol.js").SchemaField[]>;
  next(mode: "row" | "page", options: OperationOptions): Promise<Page | null>;
  close(): Promise<void>;
}
/** Returns immutable page/row receipts; local stop never implies server cancel. */
export class AnalyticalRun {
  readonly #driver: RunDriver;
  public constructor(driver: RunDriver) { this.#driver = driver; }
  public receipt(): Promise<Receipt> { return this.#driver.receipt(); }
  public schema(): Promise<readonly import("./protocol.js").SchemaField[]> { return this.#driver.schema(); }
  public nextPage(options: OperationOptions = {}): Promise<Page | null> { return this.#driver.next("page", options); }
  public nextRow(options: OperationOptions = {}): Promise<Page | null> { return this.#driver.next("row", options); }
  public close(): Promise<void> { return this.#driver.close(); }
}
const codeOf = (error: unknown): string => error instanceof AnalyticalError ? error.code : "remote_failed";
const warnings = (value: JsonValue | undefined): string[] => {
  if (value === undefined)
    return [];
  if (!Array.isArray(value))
    fail("malformed_wire");
  return value.map(entry => { const reason = object(entry).reason; return typeof reason === "string" && ["accessDenied", "backendError", "billingTierLimitExceeded", "invalidQuery", "notFound", "rateLimitExceeded", "resourcesExceeded", "stopped", "cancelled"].includes(reason) ? reason : "provider_warning"; });
};
async function sha(value: Uint8Array): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", value as Uint8Array<ArrayBuffer>); return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""); }
function parseJob(value: JsonValue | undefined): JobRef { const job = object(value); exactKeys(job, ["projectId", "jobId", "location"], [], "malformed_wire"); for (const key of ["projectId", "jobId", "location"])
  if (typeof job[key] !== "string" || job[key] === "")
    fail("malformed_wire"); return job as unknown as JobRef; }
const budgetKey = (preview: Preview): string => JSON.stringify([preview.execution.principal.kind, preview.execution.principal.subject, preview.execution.jobProject]);
function approvalPayload(preview: Omit<Preview, "approvalDigest"> | Preview): unknown { return {
  effectivePlanDigest: preview.plan.digest, observationDigest: preview.observation.digest, policyDigest: preview.policyDigest, principal: preview.execution.principal, jobProject: preview.execution.jobProject, location: preview.observation.location, maximumBytesBilled: preview.execution.maximumBytesBilled, sessionBudgetBytes: preview.execution.sessionBudgetBytes, bounds: preview.bounds, estimatedBytes: preview.estimatedBytes
}; }
export function queryRequest(plan: ReadPlan, execution: Execution, limits: Bounds, location: string, dryRun: boolean): unknown {
  validateExecution(execution);
  return {
    query: plan.sql, useLegacySql: false, parameterMode: "NAMED", queryParameters: wireParameters(plan.parameters), location, maximumBytesBilled: execution.maximumBytesBilled, maxResults: limits.pageSize, timeoutMs: 1000, jobTimeoutMs: String(limits.wallMs), jobCreationMode: "JOB_CREATION_REQUIRED", formatOptions: {
      useInt64Timestamp: true
    }, dryRun
  };
}
export class BigQueryAnalyticalClient {
  readonly #profiles = new Map<string, SourceProfile>();
  readonly #prepare: ClientConfig["prepare"];
  readonly #ledger: Ledger;
  readonly #clock: Clock;
  readonly #transport: Transport;
  readonly #approvals = new WeakMap<Approval, {
    nonce: string;
    digest: string;
  }>();
  private constructor(config: ClientConfig) { this.#prepare = config.prepare; this.#ledger = config.ledger; this.#clock = config.clock ?? realClock; this.#transport = new Transport(config.provider, config.fetch ?? ((url, init) => globalThis.fetch(url, init)), this.#clock); }
  public static async create(config: ClientConfig): Promise<BigQueryAnalyticalClient> {
    if (!config.ledger || typeof config.prepare !== "function" || !config.provider || !Array.isArray(config.profiles) || config.profiles.length === 0)
      fail("invalid_input");
    const client = new BigQueryAnalyticalClient(config);
    for (const input of config.profiles) {
      validateSource(input);
      const profile = cloneFrozen(input);
      const key = await digest("SourceProfile", profile);
      if (client.#profiles.has(key))
        fail("invalid_input");
      client.#profiles.set(key, profile);
    }
    return client;
  }
  async #prepared(signal?: AbortSignal, deadline = this.#clock.now() + 15000): Promise<{
    plan: ReadPlan;
    policyDigest: string;
    source: SourceProfile;
  }> {
    if (signal?.aborted || this.#clock.now() >= deadline)
      fail("local_stopped");
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, {
      once: true
    });
    const timer = setTimeout(abort, deadline - this.#clock.now());
    let prepared: PreparedRead;
    try {
      prepared = await abortable(this.#prepare(controller.signal), controller.signal);
      if (this.#clock.now() >= deadline)
        fail("local_stopped");
    }
    catch (error) {
      if (error instanceof AnalyticalError)
        throw error;
      fail("policy_denied");
    }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    nonempty(prepared.policyDigest);
    const plan = await compileReadPlan(prepared.source, prepared.query);
    const source = this.#profiles.get(plan.sourceDigest);
    if (source === undefined)
      fail("source_ineligible");
    return {
      plan, policyDigest: prepared.policyDigest, source
    };
  }
  async #reauthorize(preview: Preview, signal?: AbortSignal, deadline = this.#clock.now() + preview.bounds.httpMs): Promise<void> { const prepared = await this.#prepared(signal, deadline); if (prepared.plan.digest !== preview.plan.digest || prepared.policyDigest !== preview.policyDigest)
    fail("approval_changed"); }
  async #load(id: string): Promise<RunRecord> { return this.#ledger.update(state => { const record = state.runs[id]; if (record === undefined)
    fail("cursor_invalid"); return record; }); }
  async #mutate<T>(id: string, fn: (record: RunRecord) => T): Promise<T> { return this.#ledger.update(state => { const record = state.runs[id]; if (record === undefined)
    fail("cursor_invalid"); return fn(record); }); }
  #scope(preview: Preview, id: string | undefined, options: OperationOptions = {}, result = false): OperationScope {
    let bytes = 0;
    const now = this.#clock.now();
    const deadline = id === undefined ? now + preview.bounds.wallMs : Date.parse(preview.createdAt); // replaced by trusted run below.
    let runDeadline = deadline;
    let runPrincipal = preview.execution.principal;
    const scope: OperationScope = {
      bounds: preview.bounds, get executionDeadline(){return runDeadline;},get principal(){return runPrincipal;}, ...options, ...(result && id!==undefined?{beforeDispatch:()=>this.#chargePage(id)}:{}),
      remaining: async () => { if (id === undefined)
        return preview.bounds.totalResponseBytes - bytes; const record = await this.#load(id); runDeadline = Date.parse(record.receipt.executionDeadline);runPrincipal=record.activePrincipal; return record.receipt.bounds.totalResponseBytes - record.receipt.counters.bytes; },
      debit: async (length) => {
        if (id === undefined) {
          bytes += length;
          if (bytes > preview.bounds.totalResponseBytes)
            fail("response_limit");
          return;
        }
        let exceeded = false;
        await this.#mutate(id, record => { const counters = {
          ...record.receipt.counters, bytes: record.receipt.counters.bytes + length
        }; exceeded = counters.bytes > record.receipt.bounds.totalResponseBytes; record.receipt = {
          ...record.receipt, counters, ...(exceeded ? {
            localStopped: true, reason: "response_limit"
          } : {})
        }; });
        if (exceeded)
          fail("response_limit");
      },
    };
    return scope;
  }
  async #observe(source: SourceProfile, scope: OperationScope): Promise<Observation> {
    const path = `projects/${source.sourceProject}/datasets/${source.datasetId}`;
    const dataset = await this.#transport.call(scope, "GET", path, {});
    validateDataset(dataset, source);
    const table = await this.#transport.call(scope, "GET", `${path}/tables/${source.tableId}`, {});
    return validateTable(table, source, this.#clock.now());
  }
  async #estimate(plan: ReadPlan, execution: Execution, limits: Bounds, location: string, scope: OperationScope): Promise<string> {
    const response = object(await this.#transport.call(scope, "POST", `projects/${execution.jobProject}/queries`, {}, queryRequest(plan, execution, limits, location, true)));
    if (Object.hasOwn(response, "errors") && warnings(response.errors).length > 0)
      fail("remote_failed");
    if (!Object.hasOwn(response, "totalBytesProcessed"))
      fail("estimate_missing");
    const estimate = integerText(response.totalBytesProcessed, "estimate_missing");
    if (BigInt(estimate) > BigInt(execution.maximumBytesBilled))
      fail("cap_exceeded");
    return estimate;
  }
  public async preview(execution: Execution, requestedBounds: Partial<Bounds> = {}, options: OperationOptions = {}): Promise<Preview> {
    validateExecution(execution);
    const safeExecution = cloneFrozen(execution);
    const limits = bounds(requestedBounds);
    const prepared = await this.#prepared(options.signal, Math.min(this.#clock.now() + limits.httpMs, options.callerDeadline ?? Number.MAX_SAFE_INTEGER));
    const createdAt = timestamp(this.#clock.now());
    const draft: Preview = {
      nonce: opaqueID(), plan: prepared.plan, observation: {
        table: {
          projectId: prepared.source.sourceProject, datasetId: prepared.source.datasetId, tableId: prepared.source.tableId
        }, location: prepared.source.location, type: "TABLE", config: {}, schema: prepared.source.schema, digest: "", observedAt: createdAt
      }, policyDigest: prepared.policyDigest, execution: safeExecution, bounds: limits, estimatedBytes: "0", createdAt, expiresAt: timestamp(Date.parse(createdAt) + 300000), approvalDigest: ""
    };
    const scope = this.#scope(draft, undefined, options);
    const observation = await this.#observe(prepared.source, scope);
    const estimatedBytes = await this.#estimate(prepared.plan, safeExecution, limits, observation.location, scope);
    const result = {
      ...draft, observation, estimatedBytes
    };
    result.approvalDigest = await digest("Approval", approvalPayload(result));
    await this.#ledger.update(state => { state.previews[result.nonce] = {
      preview: result, used: false
    }; });
    return cloneFrozen(result);
  }
  public async approve(preview: Preview, approvedDigest: string): Promise<Approval> {
    const stored = await this.#ledger.update(state => state.previews[preview.nonce]);
    if (stored === undefined || stored.used)
      fail("approval_required");
    if (approvedDigest !== stored.preview.approvalDigest || !same(preview, stored.preview) || this.#clock.now() >= Date.parse(stored.preview.expiresAt))
      fail("approval_changed");
    const approval = Approval.mint();
    this.#approvals.set(approval, {
      nonce: preview.nonce, digest: approvedDigest
    });
    return approval;
  }
  #session(id: string, accessPrincipal: Execution["principal"]): Session { return {
    id, accessPrincipal:cloneFrozen(accessPrincipal), emptyDelivered: false, controller: new AbortController(), rows: [], index: 0, loaded: false, done: false, mode: "", digest: ""
  }; }
  #run(session: Session): AnalyticalRun { return new AnalyticalRun({
    receipt: async () => cloneFrozen((await this.#load(session.id)).receipt), schema: async () => cloneFrozen((await this.#load(session.id)).schema), next: (mode, options) => this.#read(session, mode, options), close: async () => { session.controller.abort(); session.rows = []; await this.#mutate(session.id, r => { r.receipt = {
      ...r.receipt, localStopped: true, reason: "local_stopped"
    }; }); }
  }); }
  public async execute(approval: Approval, options: OperationOptions = {}): Promise<AnalyticalRun> {
    const capability = this.#approvals.get(approval);
    if (capability === undefined)
      fail("approval_required");
    const id = opaqueID();
    const record = await this.#ledger.update(state => {
      const stored = state.previews[capability.nonce];
      if (stored === undefined || stored.used)
        fail("approval_required");
      const preview = stored.preview;
      if (this.#clock.now() >= Date.parse(preview.expiresAt) || preview.approvalDigest !== capability.digest)
        fail("approval_changed");
      let reserved = 0n;
      const budget = BigInt(preview.execution.sessionBudgetBytes);
      for (const run of Object.values(state.runs))
        if (budgetKey(run.preview) === budgetKey(preview)) {
          if (run.preview.execution.sessionBudgetBytes !== preview.execution.sessionBudgetBytes)
            fail("budget_exhausted");
          reserved += BigInt(run.reservation);
        }
      if (reserved + BigInt(preview.execution.maximumBytesBilled) > budget)
        fail("budget_exhausted");
      const now = this.#clock.now();
      stored.used = true;
      const receipt: Receipt = {
        version: 1, runId: id, approvalDigest: capability.digest, sourceDigest: preview.plan.sourceDigest, observationDigest: preview.observation.digest, schemaDigest: "", principal: preview.execution.principal, state: "reserved", runStartedAt: timestamp(now), executionDeadline: timestamp(now + preview.bounds.wallMs), bounds: preview.bounds, counters: {
          bytes: 0, rows: 0, pages: 0
        }, localStopped: false, warnings: [], residualSourceReplacementRace: true
      };
      const record: RunRecord = {
        receipt, preview, activePrincipal: preview.execution.principal, reservation: preview.execution.maximumBytesBilled, pageToken: null, nextToken: null, pageDigest: "", offset: 0, pageOrdinal: 0, pageDone: false, schema: [], seenTokens: [], cursor: null
      };
      state.runs[id] = record;
      return record;
    });
    const session = this.#session(id,record.activePrincipal);
    const run = this.#run(session);
    const scope = this.#scope(record.preview, id, options);
    let dispatched = false;
    try {
      await this.#ledger.withLease(id, options.signal, async () => {
        await this.#reauthorize(record.preview, options.signal, Math.min(Date.parse(record.receipt.executionDeadline), this.#clock.now() + record.receipt.bounds.httpMs, options.callerDeadline ?? Number.MAX_SAFE_INTEGER));
        const source = this.#profiles.get(record.preview.plan.sourceDigest) as SourceProfile;
        let observation = await this.#observe(source, scope);
        const estimate = await this.#estimate(record.preview.plan, record.preview.execution, record.preview.bounds, observation.location, scope);
        if (await digest("Approval", approvalPayload({
          ...record.preview, observation, estimatedBytes: estimate
        })) !== capability.digest)
          fail("approval_changed");
        observation = await this.#observe(source, scope);
        if (observation.digest !== record.preview.observation.digest)
          fail("source_changed");
        await this.#reauthorize(record.preview, options.signal, Math.min(Date.parse(record.receipt.executionDeadline), this.#clock.now() + record.receipt.bounds.httpMs, options.callerDeadline ?? Number.MAX_SAFE_INTEGER));
        await this.#mutate(id, r => { r.receipt = {
          ...r.receipt, state: "submitting"
        }; });
        const raw = object(await this.#transport.call(this.#scope(record.preview,id,options,true), "POST", `projects/${record.preview.execution.jobProject}/queries`, {}, queryRequest(record.preview.plan, record.preview.execution, record.preview.bounds, observation.location, false), false, false, () => { dispatched = true; }));
        const job = parseJob(raw.jobReference);
        if (job.projectId !== record.preview.execution.jobProject || job.location !== observation.location)
          fail("malformed_wire");
        await this.#mutate(id, r => { r.receipt = {
          ...r.receipt, job, state: "running"
        }; });
        await this.#install(session, raw, null, false);
      });
      return run;
    }
    catch (error) {
      await this.#mutate(id, r => { r.receipt = {
        ...r.receipt, ...(dispatched ? {
          state: r.receipt.job === undefined ? "submission_unknown" : r.receipt.state, localStopped: true
        } : {
          state: "failed"
        }), reason: codeOf(error)
      }; if (!dispatched)
        r.reservation = "0"; });
      throw new ExecutionFailure(error, await run.receipt(), run);
    }
  }
  async #chargePage(id:string):Promise<void> {
    await this.#mutate(id,r=>{if(r.receipt.counters.pages>=r.receipt.bounds.maxPages)fail("response_limit");r.receipt={...r.receipt,counters:{...r.receipt.counters,pages:r.receipt.counters.pages+1}};});
  }
  async #install(session: Session, response: Record<string, JsonValue>, token: string | null, refetch: boolean): Promise<void> {
    const record = await this.#load(session.id);
    if (record.receipt.job === undefined)
      fail("malformed_wire");
    exactKeys(response, ["jobComplete"], ["kind", "etag", "jobReference", "schema", "rows", "pageToken", "totalRows", "totalBytesProcessed", "totalBytesBilled", "cacheHit", "errors", "jobCreationReason", "creationTime", "startTime", "endTime", "location", "queryId", "statementType", "pageRowCount", "totalSlotMs"], "malformed_wire");
    if (Object.hasOwn(response, "jobReference") && !same(parseJob(response.jobReference), record.receipt.job))
      fail("malformed_wire");
    if (typeof response.jobComplete !== "boolean")
      fail("malformed_wire");
    let schema = record.schema;
    if (Object.hasOwn(response, "schema")) {
      const incoming = decodeSchema(response.schema as JsonValue);
      const profile = this.#profiles.get(record.preview.plan.sourceDigest) as SourceProfile;
      const expected = record.preview.plan.projection.map(name => profile.schema.find(field => field.name === name));
      if (!same(incoming, expected) || schema.length > 0 && !same(schema, incoming))
        fail("schema_changed");
      schema = incoming;
    }
    const rawRows = Object.hasOwn(response, "rows") ? response.rows : [];
    if (!Array.isArray(rawRows))
      fail("malformed_wire");
    const totalRows = Object.hasOwn(response, "totalRows") ? integerText(response.totalRows) : record.totalRows;
    const pageStart = record.receipt.counters.rows - (refetch ? record.offset : 0);
    if (pageStart < 0)
      fail("cursor_invalid");
    if (pageStart + rawRows.length > record.preview.plan.limit ||
        totalRows !== undefined && (BigInt(totalRows) > BigInt(record.preview.plan.limit) || BigInt(pageStart + rawRows.length) > BigInt(totalRows) ||
          record.totalRows !== undefined && totalRows !== record.totalRows))
      fail("malformed_wire");
    if (schema.length === 0) {
      if (rawRows.length > 0 || response.jobComplete)
        fail("malformed_wire");
      session.loaded = false;
      return;
    }
    const rows = decodeRows(encoded(rawRows), schema, record.receipt.bounds.responseBytes);
    if (rows.length > record.receipt.bounds.pageSize)
      fail("response_limit");
    for (const row of rows)
      row.forEach((cell, index) => { const field = schema[index]; if (field !== undefined && typeof cell.value === "string" && ["NUMERIC", "BIGNUMERIC"].includes(cell.type))
        checkDecimalConstraints(field, cell.value); });
    const pageDigest = await sha(canonicalJSON(encoded(rawRows)));
    let next: string | null = null;
    if (Object.hasOwn(response, "pageToken")) {
      if (typeof response.pageToken !== "string" || response.pageToken.length === 0 || response.pageToken.length > 16384)
        fail("malformed_wire");
      next = response.pageToken;
    }
    if (next !== null && (pageStart + rows.length >= record.preview.plan.limit || totalRows !== undefined && BigInt(pageStart + rows.length) >= BigInt(totalRows)))
      fail("malformed_wire");
    if (response.jobComplete && next === null && totalRows !== undefined && BigInt(pageStart + rows.length) !== BigInt(totalRows))
      fail("malformed_wire");
    if (refetch && (pageDigest !== record.pageDigest || next !== record.nextToken || response.jobComplete !== record.pageDone))
      fail("cursor_invalid");
    const schemaDigest = await sha(canonicalJSON(encoded(schema)));
    const processed = Object.hasOwn(response, "totalBytesProcessed") ? integerText(response.totalBytesProcessed) : undefined;
    const billed = Object.hasOwn(response, "totalBytesBilled") ? integerText(response.totalBytesBilled) : undefined;
    if (Object.hasOwn(response, "cacheHit") && typeof response.cacheHit !== "boolean")
      fail("malformed_wire");
    await this.#mutate(session.id, r => {
      if (!refetch) {
        if (next !== null && (r.seenTokens.includes(next) || token === next))
          fail("cursor_invalid");
        if (token !== null)
          r.seenTokens.push(token);
        r.pageOrdinal += 1;
        r.offset = 0;
        r.pageToken = token;
        r.nextToken = next;
        r.pageDigest = pageDigest;
        r.pageDone = response.jobComplete as boolean;
      }
      r.schema = schema;
      if (totalRows !== undefined)
        r.totalRows = totalRows;
      r.receipt = {
        ...r.receipt, schemaDigest, warnings: [...r.receipt.warnings, ...warnings(response.errors)], ...(processed === undefined ? {} : {
          processedBytes: processed
        }), ...(billed === undefined ? {} : {
          billedBytes: billed
        }), ...(response.cacheHit === undefined ? {} : {
          cacheHit: response.cacheHit as boolean
        })
      };
    });
    const loaded = await this.#load(session.id);
    if (loaded.offset > rows.length)
      fail("cursor_invalid");
    session.rows = rows;
    session.index = loaded.offset;
    session.digest = pageDigest;
    session.loaded = true;
    session.done = response.jobComplete && next === null;
  }
  async #fetchPage(session: Session, token: string | null, refetch: boolean, options: OperationOptions): Promise<void> {
    const record = await this.#load(session.id);
    if (record.receipt.counters.rows >= Math.min(record.preview.plan.limit, record.receipt.bounds.maxRows) || record.receipt.counters.pages >= record.receipt.bounds.maxPages)
      fail("response_limit");
    await this.#reauthorize(record.preview, options.signal, Math.min(Date.parse(record.receipt.executionDeadline), this.#clock.now() + record.receipt.bounds.httpMs, options.callerDeadline ?? Number.MAX_SAFE_INTEGER));
    const job = record.receipt.job;
    if (job === undefined)
      fail("submission_unknown");
    const query: Record<string, string> = {
      location: job.location, maxResults: String(record.receipt.bounds.pageSize), "formatOptions.useInt64Timestamp": "true", timeoutMs: "1000", ...(token === null ? {
        startIndex: "0"
      } : {
        pageToken: token
      })
    };
    const raw = object(await this.#transport.call(this.#scope(record.preview, session.id, options,true), "GET", `projects/${job.projectId}/queries/${encodeURIComponent(job.jobId)}`, query));
    await this.#install(session, raw, token, refetch);
  }
  async #read(session: Session, mode: "row" | "page", options: OperationOptions): Promise<Page | null> {
    if (session.mode !== "" && session.mode !== mode)
      fail("invalid_input");
    session.mode = mode;
    try {
      return await this.#ledger.withLease(session.id, options.signal, async () => {
        const abort = (): void => session.controller.abort();
        options.signal?.addEventListener("abort", abort, {
          once: true
        });
        const safeOptions = {
          ...options, signal: session.controller.signal
        };
        try {
          const initial = await this.#load(session.id);
          if(!same(initial.activePrincipal,session.accessPrincipal))fail("approval_changed");
          await this.#reauthorize(initial.preview, safeOptions.signal, Math.min(Date.parse(initial.receipt.executionDeadline), this.#clock.now() + initial.receipt.bounds.httpMs, options.callerDeadline ?? Number.MAX_SAFE_INTEGER));
          await this.#transport.verify(initial.activePrincipal, Math.min(Date.parse(initial.receipt.executionDeadline), this.#clock.now() + initial.receipt.bounds.httpMs, options.callerDeadline ?? Number.MAX_SAFE_INTEGER), safeOptions.signal);
          while (true) {
            const record = await this.#load(session.id);
            if (session.controller.signal.aborted || this.#clock.now() >= Date.parse(record.receipt.executionDeadline) || (options.callerDeadline !== undefined && this.#clock.now() >= options.callerDeadline))
              fail("local_stopped");
            if (session.loaded && (record.offset !== session.index || record.pageDigest !== session.digest))
              fail("cursor_invalid");
            if (session.loaded && session.index < session.rows.length)
              break;
            if (session.loaded && session.done) {
              if (session.rows.length === 0 && !session.emptyDelivered) {
                session.emptyDelivered = true;
                const cursor = await this.#delivery(session, 0);
                const current = await this.#load(session.id);
                return cloneFrozen({
                  schema: current.schema, rows: [], cursor, receipt: current.receipt
                });
              }
              return null;
            }
            if (record.receipt.counters.rows >= Math.min(record.preview.plan.limit, record.receipt.bounds.maxRows) || record.receipt.counters.pages >= record.receipt.bounds.maxPages)
              fail("response_limit");
            await this.#fetchPage(session, session.loaded ? record.nextToken : record.pageToken, false, safeOptions);
            if (!session.loaded) {
              await this.#clock.sleep(100, safeOptions.signal);
            }
          }
          const record = await this.#load(session.id);
          let amount = mode === "row" ? 1 : session.rows.length - session.index;
          amount = Math.min(amount, Math.min(record.preview.plan.limit, record.receipt.bounds.maxRows) - record.receipt.counters.rows);
          if (amount < 1)
            fail("response_limit");
          const rows = cloneFrozen(session.rows.slice(session.index, session.index + amount));
          const offset = session.index + amount;
          const cursor = await this.#delivery(session, amount);
          session.index = offset;
          const current = await this.#load(session.id);
          return cloneFrozen({
            schema: current.schema, rows, cursor, receipt: current.receipt
          });
        }
        finally {
          options.signal?.removeEventListener("abort", abort);
        }
      });
    }
    catch (error) {
      await this.#mutate(session.id, r => { r.receipt = {
        ...r.receipt, localStopped: true, reason: codeOf(error)
      }; });
      throw new ExecutionFailure(error, (await this.#load(session.id)).receipt, this.#run(session));
    }
  }
  async #delivery(session: Session, amount: number): Promise<string> {
    const offset = session.index + amount;
    const cursor = await this.#mutate(session.id, r => {
      if (r.receipt.counters.rows + amount > Math.min(r.preview.plan.limit, r.receipt.bounds.maxRows))
        fail("response_limit");
      r.offset = offset;
      r.receipt = {
        ...r.receipt, localStopped: false, counters: {
          ...r.receipt.counters, rows: r.receipt.counters.rows + amount
        }
      };
      const boundary = offset === session.rows.length && r.nextToken !== null;
      const cursor: CursorState = {
        version: 1, runId: session.id, job: r.receipt.job as JobRef, planDigest: r.preview.plan.digest, schemaDigest: r.receipt.schemaDigest, principal: r.activePrincipal, pageToken: boundary ? r.nextToken : r.pageToken, pageSize: r.receipt.bounds.pageSize, offset: boundary ? 0 : offset, pageDigest: boundary ? "" : r.pageDigest, ordinal: r.pageOrdinal + (boundary ? 1 : 0), counters: r.receipt.counters, ledgerRef: opaqueID()
      };
      r.cursor = cursor;
      return cursor;
    });
    return encodeCursor(cursor);
  }
  public async resume(receipt: Receipt, cursor: string, options: OperationOptions = {}): Promise<AnalyticalRun> {
    const decoded = decodeCursor(cursor);
    const record = await this.#load(receipt.runId);
    if (!same(decoded, record.cursor) || !receiptMatches(receipt, record.receipt))
      fail("cursor_invalid");
    const session = this.#session(receipt.runId,record.activePrincipal);
    const run = this.#run(session);
    if (this.#clock.now() >= Date.parse(record.receipt.executionDeadline)) {
      await this.#mutate(session.id, r => { r.receipt = {
        ...r.receipt, localStopped: true, reason: "local_stopped"
      }; });
      throw new ExecutionFailure(new AnalyticalError("local_stopped"), await run.receipt(), run);
    }
    await this.#ledger.withLease(session.id, options.signal, async () => { const current = await this.#load(session.id); if (!same(decoded, current.cursor))
      fail("cursor_invalid"); await this.#reauthorize(current.preview, options.signal, Math.min(Date.parse(current.receipt.executionDeadline), this.#clock.now() + current.receipt.bounds.httpMs, options.callerDeadline ?? Number.MAX_SAFE_INTEGER)); const partial = decoded.pageDigest !== ""; if (!partial)
      await this.#mutate(session.id, r => { r.pageToken = decoded.pageToken; r.offset = 0; }); await this.#fetchPage(session, decoded.pageToken, partial, options); });
    return run;
  }
  /** Explicit reconnect of an existing known job after the trusted provider has
   * verified the same stable subject. Keeps original approval, budget and deadline;
   * invalidates old cursors and never submits a query. Approval principal provenance
   * remains immutable; only the separately persisted access generation changes.
   */
  public async rebind(receipt: Receipt, cursor: string | null, options: OperationOptions = {}): Promise<{
    receipt: Receipt;
    cursor: string | null;
  }> {
    options = {
      ...options, callerDeadline: Math.min(options.callerDeadline ?? Number.MAX_SAFE_INTEGER, this.#clock.now() + Math.min(15000, receipt.bounds.httpMs))
    };
    return this.#ledger.withLease(receipt.runId, options.signal, async () => {
      const current = await this.#load(receipt.runId);
      if (!receiptMatches(receipt, current.receipt) || current.receipt.job === undefined || (cursor === null ? current.cursor !== null : !same(decodeCursor(cursor), current.cursor)))
        fail("cursor_invalid");
      await this.#reauthorize(current.preview, options.signal, options.callerDeadline);
      const principal = await this.#transport.verify(current.activePrincipal, Math.min(this.#clock.now() + 15000, options.callerDeadline ?? Number.MAX_SAFE_INTEGER), options.signal, true);
      if (principal.generation === current.activePrincipal.generation)
        fail("approval_changed");
      const result = await this.#mutate(receipt.runId, r => { if (!same(r.activePrincipal, current.activePrincipal) || !same(r.cursor, current.cursor))
        fail("cursor_invalid"); r.activePrincipal = principal; if (r.cursor !== null)
        r.cursor = {
          ...r.cursor, principal, ledgerRef: opaqueID()
        }; return {
        receipt: r.receipt, cursor: r.cursor === null ? null : encodeCursor(r.cursor)
      }; });
      return cloneFrozen(result);
    });
  }
  public async status(receipt: Receipt, options: OperationOptions = {}): Promise<JobStatus> {
    options = {
      ...options, callerDeadline: Math.min(options.callerDeadline ?? Number.MAX_SAFE_INTEGER, this.#clock.now() + Math.min(15000, receipt.bounds.httpMs))
    };
    return this.#ledger.withLease(receipt.runId, options.signal, async () => {
      const record = await this.#load(receipt.runId);
      if (!receiptMatches(receipt, record.receipt) || record.receipt.job === undefined)
        fail("cursor_invalid");
      await this.#reauthorize(record.preview, options.signal, options.callerDeadline);
      const job = record.receipt.job;
      const raw = object(await this.#transport.call(this.#scope(record.preview, receipt.runId, options), "GET", `projects/${job.projectId}/jobs/${encodeURIComponent(job.jobId)}`, {
        location: job.location
      }, undefined, true));
      if (!same(parseJob(raw.jobReference), job))
        fail("malformed_wire");
      exactKeys(raw, ["jobReference", "status"], ["kind", "etag", "id", "selfLink", "user_email", "principal_subject", "configuration", "statistics", "jobCreationReason"], "malformed_wire");
      const status = object(raw.status);
      exactKeys(status, ["state"], ["errorResult", "errors"], "malformed_wire");
      if (!["PENDING", "RUNNING", "DONE"].includes(String(status.state)))
        fail("malformed_wire");
      let state: JobStatus["state"] = "running";
      const reasons = warnings(status.errors);
      let billedBytes: string | undefined;
      if (status.state === "DONE") {
        state = "completed";
        if (Object.hasOwn(status, "errorResult") && status.errorResult !== null) {
          const error = object(status.errorResult);
          if (typeof error.reason !== "string" || error.reason === "")
            fail("malformed_wire");
          state = error.reason === "cancelled" ? "cancelled" : "failed";
          reasons.push(...warnings([error]));
        }
        if (raw.statistics !== undefined) {
          const statistics = object(raw.statistics);
          if (statistics.query !== undefined) {
            const query = object(statistics.query);
            if (Object.hasOwn(query, "totalBytesBilled"))
              billedBytes = integerText(query.totalBytesBilled);
          }
        }
      }
      await this.#mutate(receipt.runId, r => { if (status.state === "DONE") {
        if (r.receipt.state === "cancel_requested" && state === "completed")
          reasons.push("completed_before_cancel");
        r.receipt = {
          ...r.receipt, state, ...(billedBytes === undefined ? {} : {
            billedBytes
          })
        };
        if (billedBytes !== undefined)
          r.reservation = billedBytes;
      } r.receipt = {
        ...r.receipt, warnings: [...r.receipt.warnings, ...reasons]
      }; });
      return cloneFrozen({
        job, state, warnings: reasons, ...(billedBytes === undefined ? {} : {
          billedBytes
        })
      });
    });
  }
  public async cancel(receipt: Receipt, options: OperationOptions = {}): Promise<CancelResult> {
    options = {
      ...options, callerDeadline: Math.min(options.callerDeadline ?? Number.MAX_SAFE_INTEGER, this.#clock.now() + Math.min(15000, receipt.bounds.httpMs))
    };
    return this.#ledger.withLease(receipt.runId, options.signal, async () => {
      const record = await this.#load(receipt.runId);
      if (!receiptMatches(receipt, record.receipt) || record.receipt.job === undefined)
        fail("cursor_invalid");
      await this.#reauthorize(record.preview, options.signal, options.callerDeadline);
      const job = record.receipt.job;
      const raw = object(await this.#transport.call(this.#scope(record.preview, receipt.runId, options), "POST", `projects/${job.projectId}/jobs/${encodeURIComponent(job.jobId)}/cancel`, {
        location: job.location
      }, undefined, true, true));
      const returned = parseJob(object(raw.job).jobReference);
      if (!same(returned, job))
        fail("cancellation_unknown");
      await this.#mutate(receipt.runId, r => { if (!["completed", "failed", "cancelled"].includes(r.receipt.state))
        r.receipt = {
          ...r.receipt, state: "cancel_requested"
        }; });
      return cloneFrozen({
        job, state: "cancel_requested" as const
      });
    });
  }
}
/** Failed operations expose the existing sanitized receipt and recoverable run;
 * the message/code never includes query values, OAuth tokens or provider bodies.
 */
export class ExecutionFailure extends AnalyticalError {
  public readonly receipt: Receipt;
  public readonly run: AnalyticalRun;
  public constructor(error: unknown, receipt: Receipt, run: AnalyticalRun) { super(error instanceof AnalyticalError ? error.code : "remote_failed"); this.receipt = cloneFrozen(receipt); this.run = run; }
}
function receiptMatches(a: Receipt, b: Receipt): boolean { return same([a.version, a.runId, a.approvalDigest, a.sourceDigest, a.observationDigest, a.schemaDigest, a.principal, a.job, a.bounds, a.runStartedAt, a.executionDeadline], [b.version, b.runId, b.approvalDigest, b.sourceDigest, b.observationDigest, b.schemaDigest, b.principal, b.job, b.bounds, b.runStartedAt, b.executionDeadline]); }
function encodeCursor(cursor: CursorState): string { const bytes = encoded(cursor); let binary = ""; for (const byte of bytes)
  binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function decodeCursor(value: string): CursorState { if (typeof value !== "string" || value.length > 45000 || !/^[A-Za-z0-9_-]+$/u.test(value))
  fail("cursor_invalid"); try {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  parseJSON(bytes, 32768);
  const text = new TextDecoder("utf-8", {
    fatal: true
  }).decode(bytes);
  const cursor = JSON.parse(text) as CursorState;
  if (encodeCursor(cursor) !== value)
    fail("cursor_invalid");
  return cursor;
}
catch {
  return fail("cursor_invalid");
} }
