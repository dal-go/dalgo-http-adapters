import type { StructuredQuery } from "@dalgo/core";
import { compile, sourceCopy, type ReadPlan } from "./compiler.js";
import { fail } from "./errors.js";
import { encode, utf8 } from "./json.js";
import { integer, Manager, now, type Operation } from "./operation.js";
import { authority, call, execution, page, preflight, sameAuthority, type PendingPage } from "./protocol.js";
import type { AthenaAuthority, AthenaCounters, AthenaCursor, AthenaNativePage, AthenaOptions, AthenaReadOptions, AthenaSource, AthenaTransport, AthenaTable } from "./types.js";
import { array, field, hash, opaque, text } from "./validation.js";

interface Journey {
  readonly plan: ReadPlan; readonly started: number; readonly expires: number; readonly pageSize: number;
  readonly budget: AthenaCounters; readonly scope: string; readonly submission: string; principal: AthenaAuthority; submit: AthenaAuthority;
  queryId: string; completed: boolean; cancelStarted: boolean; scanned?: string; token?: string; header: boolean;
  columns?: PendingPage["columns"]; batchRows?: (string | null)[][]; pending?: PendingPage; cursor?: string; busy: boolean; retired: boolean;
  bytes: number; nodes: number; executionRows: number; authorityLease: boolean; readonly seen: Set<string>;
}
// Includes the admitted Node credential tuple (32 KiB session token),
// attestation strings, object fields and conservative owned bookkeeping.
const authorityBytes = 65_536, authorityNodes = 64;
const initialCounters = (): AthenaCounters => ({ requests: 0, requestBytes: 0, bytes: 0, nodes: 0, pages: 0, fetchedRows: 0, rows: 0, attempts: 0 });
export class AthenaNativeClient {
  readonly #manager: Manager; readonly #source: AthenaSource; readonly #transport: AthenaTransport;
  readonly #journeys = new Set<Journey>(); readonly #handles = new Map<string, Journey>();
  #bytes = 0; #nodes = 0;
  public constructor(options: AthenaOptions) {
    this.#manager = new Manager(options);
    const candidate: unknown = options.transport;
    if (candidate === null || typeof candidate !== "object") throw fail("configuration");
    try { const transport = candidate as AthenaTransport; if (typeof transport.authorize !== "function" || typeof transport.request !== "function") throw fail("configuration"); this.#transport = transport; }
    catch { throw fail("configuration"); }
    const op = this.#manager.begin();
    try { this.#source = sourceCopy(options.source, op); op.prepareDelivery(); }
    catch (error) { throw op.failure(error); } finally { op.finish(); }
  }
  public close(): void {
    this.#manager.close();
    for (const state of this.#journeys) { state.retired = true; if (state.cursor !== undefined) this.#handles.delete(state.cursor); if (!state.busy) this.#drop(state); }
  }
  #drop(state: Journey): void {
    if (!this.#journeys.delete(state)) return;
    if (state.cursor !== undefined) this.#handles.delete(state.cursor);
    this.#bytes -= state.bytes; this.#nodes -= state.nodes;
    state.bytes = 0; state.nodes = 0; delete state.pending; state.seen.clear();
  }
  #prune(): void {
    const time = now();
    for (const state of this.#journeys) if (state.expires <= time) { state.retired = true; if (state.cursor !== undefined) this.#handles.delete(state.cursor); if (!state.busy) this.#drop(state); }
  }
  #quota(state: Journey, bytes: number, nodes: number): void {
    const limits = this.#manager.limits;
    if (bytes < 0 || nodes < 0 || this.#bytes - state.bytes + bytes > limits.maxCursorBytes || this.#nodes - state.nodes + nodes > limits.maxCursorNodes) throw fail("bounds");
    this.#bytes += bytes - state.bytes; this.#nodes += nodes - state.nodes; state.bytes = bytes; state.nodes = nodes;
  }
  #baseCharge(state: Journey, columns = state.columns, nextToken?: string): { bytes: number; nodes: number } {
    let bytes = 8192 + authorityBytes * (state.authorityLease ? 2 : 1) + utf8(state.submission) + utf8(state.plan.sql) + state.plan.parameters.reduce((sum, value) => sum + utf8(value) + 16, 0);
    let nodes = 64 + authorityNodes * (state.authorityLease ? 2 : 1) + state.plan.parameters.length;
    for (const token of state.seen) { bytes += utf8(token) + 64; nodes++; }
    if (nextToken !== undefined && !state.seen.has(nextToken)) { bytes += utf8(nextToken) + 64; nodes++; }
    if (columns !== undefined) { bytes += utf8(JSON.stringify(columns)); nodes += columns.length * 12; }
    if (state.batchRows !== undefined) { bytes += utf8(JSON.stringify(state.batchRows)); for (const row of state.batchRows) { nodes += row.length + 1; bytes += row.length * 8 + 24; } }
    return { bytes, nodes };
  }
  #reserve(state: Journey): void {
    const base = this.#baseCharge(state), limits = this.#manager.limits;
    this.#quota(state, base.bytes + limits.maxPageBytes + limits.maxPageNodes * 16 + 2048, base.nodes + limits.maxPageNodes + limits.maxColumns * 12 + 16);
  }
  #successorCharge(state: Journey, pending: PendingPage): { bytes: number; nodes: number } {
    // Replace metadata, include the newly retained native token and opaque
    // handle. Use this same model for admission and the eventual ACK.
    const base = this.#baseCharge(state, pending.columns, pending.next);
    return { bytes: base.bytes + (pending.next === undefined ? 0 : 128), nodes: base.nodes + (pending.next === undefined ? 0 : 2) };
  }
  #retainPending(state: Journey, pending = state.pending): void {
    const base = this.#baseCharge(state); let bytes = base.bytes, nodes = base.nodes;
    if (pending !== undefined) {
      bytes += utf8(JSON.stringify(pending)); nodes += pending.columns.length * 12 + 16;
      for (const row of pending.rows) { nodes += row.length + 1; bytes += row.length * 8 + 24; }
      const successor = this.#successorCharge(state, pending);
      bytes = Math.max(bytes, successor.bytes); nodes = Math.max(nodes, successor.nodes);
    }
    this.#quota(state, bytes, nodes);
  }
  #own(state: Journey, op: Operation): void {
    if (state.busy || state.retired) throw fail("busy");
    state.busy = true;
    op.afterSettled(() => {
      state.busy = false;
      if (state.retired || this.#manager.closed) this.#drop(state);
      else if (state.authorityLease) { state.authorityLease = false; this.#retainPending(state); }
    });
    if (state.queryId !== "") {
      // The original submit credential remains captured for owned Stop. A
      // resumed request can additionally retain its newly admitted tuple.
      this.#quota(state, state.bytes + authorityBytes, state.nodes + authorityNodes);
      state.authorityLease = true;
    }
    op.budget = state.budget; if (++state.budget.attempts > this.#manager.limits.maxRequests) throw fail("bounds");
  }
  async #identity(op: Operation): Promise<{ admitted: AthenaAuthority; binding: AthenaAuthority }> {
    const original = await op.io(() => this.#transport.authorize(op.signal));
    const binding = op.call(() => Object.freeze(authority(original)));
    const capture = op.call(() => this.#transport.captureAuthority);
    if (capture !== undefined) {
      if (typeof capture !== "function") throw fail("configuration");
      await op.io(() => capture.call(this.#transport, original, binding));
    }
    return { admitted: binding, binding };
  }
  #wire(input: unknown, op: Operation): string { return encode(input, op.limits.maxRequestBytes, op); }
  #submission(plan: ReadPlan, op: Operation): string {
    const source = this.#source;
    return this.#wire({ ClientRequestToken: opaque(), QueryString: plan.sql, WorkGroup: source.workGroup,
      QueryExecutionContext: { Catalog: source.catalog, Database: source.database },
      ResultConfiguration: { OutputLocation: source.outputLocation, ExpectedBucketOwner: source.expectedBucketOwner,
        EncryptionConfiguration: { EncryptionOption: source.encryption.option, ...(source.encryption.kmsKey === undefined ? {} : { KmsKey: source.encryption.kmsKey }) } },
      ResultReuseConfiguration: { ResultReuseByAgeConfiguration: { Enabled: false } }, ...(plan.parameters.length === 0 ? {} : { ExecutionParameters: plan.parameters }) }, op);
  }
  async #submit(state: Journey, op: Operation): Promise<void> {
    const source = this.#source;
    preflight(await call(this.#transport, "GetWorkGroup", this.#wire({ WorkGroup: source.workGroup }, op), state.submit, op), source);
    const response = await call(this.#transport, "StartQueryExecution", state.submission, state.submit, op);
    state.queryId = text(response.QueryExecutionId, 128); if (/\s/u.test(state.queryId)) throw fail("protocol");
    for (let i = 0; i < op.limits.maxPolls; i++) {
      const observed = execution(await call(this.#transport, "GetQueryExecution", this.#wire({ QueryExecutionId: state.queryId }, op), state.submit, op), source, state.plan, state.queryId);
      if (observed.scanned !== undefined) state.scanned = observed.scanned;
      if (observed.state === "SUCCEEDED") { state.completed = true; return; }
      if (observed.state === "FAILED" || observed.state === "CANCELLED") { state.completed = true; throw fail("transport"); }
      await op.io(() => new Promise<void>(resolve => { setTimeout(resolve, Math.min(op.limits.pollIntervalMs, Math.max(0, op.expires - now()))); }));
    }
    throw fail("bounds");
  }
  #cancel(state: Journey, original: Operation): void {
    if (state.completed || state.cancelStarted || state.queryId === "") return;
    state.cancelStarted = true;
    const cleanup = original.control();
    // Start this task before finishing the original operation; all nested
    // physical work also retains its parent even after the two-second wait.
    void original.retain(async () => {
      try { await call(this.#transport, "StopQueryExecution", this.#wire({ QueryExecutionId: state.queryId }, cleanup), state.submit, cleanup, true); }
      catch { /* Accepted stop is not terminal observation. Unknown stays unknown. */ }
      finally { cleanup.finish(); }
    });
  }
  async #read(state: Journey, credential: AthenaAuthority, op: Operation): Promise<void> {
    if (state.pending !== undefined) return;
    this.#reserve(state); if (++state.budget.pages > op.limits.maxPages) throw fail("bounds");
    const raw = await call(this.#transport, "GetQueryResults", this.#wire({ QueryExecutionId: state.queryId, MaxResults: state.pageSize, QueryResultType: "DATA_ROWS", ...(state.token === undefined ? {} : { NextToken: state.token }) }, op), credential, op);
    const result = page(raw, state.plan, state.columns, state.header, op);
    if (result.rows.length + (state.header || !result.header ? 0 : 1) > state.pageSize) throw fail("protocol");
    if (result.next !== undefined && state.seen.has(result.next)) throw fail("protocol");
    state.budget.fetchedRows += result.rows.length;
    if (state.budget.rows + result.rows.length > op.limits.maxRows || state.executionRows + result.rows.length > state.plan.limit) throw fail("bounds");
    // Admission must succeed before publishing a pending page into a journal.
    this.#retainPending(state, result); state.pending = result;
  }
  #pageValue(state: Journey, nextCursor: AthenaCursor | undefined): AthenaNativePage {
    const pending = state.pending; if (pending === undefined) throw fail("protocol");
    return {
      columns: pending.columns.map(value => ({ ...value })), rows: pending.rows.map(row => [...row]), ordinalStart: state.budget.rows,
      hasMore: pending.next !== undefined, ...(nextCursor === undefined ? {} : { nextCursor }),
      receipt: { sourceId: this.#source.sourceId, queryId: state.queryId, state: "SUCCEEDED", complete: pending.next === undefined,
        counters: { ...state.budget, rows: state.budget.rows + pending.rows.length }, ...(state.scanned === undefined ? {} : { dataScannedBytes: state.scanned }) }
    };
  }
  #ack(state: Journey, old: string | undefined, next: AthenaCursor | undefined, op: Operation): void {
    const pending = state.pending; if (pending === undefined) throw fail("protocol");
    // All allocation/codec/serialization/cleanup happens before this final
    // freshness+membership+original-expiry fence and atomic local commit.
    op.check(state.expires);
    if (state.retired || old !== undefined && this.#handles.get(old) !== state || old !== state.cursor) throw fail("cursor");
    if (state.cursor !== undefined) this.#handles.delete(state.cursor);
    state.header = pending.header; state.columns = pending.columns; state.budget.rows += pending.rows.length; state.executionRows += pending.rows.length;
    if (pending.next !== undefined && next !== undefined) {
      state.seen.add(pending.next); state.token = pending.next; state.cursor = next; this.#handles.set(next, state);
    } else { delete state.cursor; delete state.token; state.retired = true; }
    delete state.pending;
  }
  async #deliver<T>(state: Journey, old: string | undefined, op: Operation, factory: (page: AthenaNativePage, check: () => void) => T | PromiseLike<T>): Promise<T> {
    const pending = state.pending; if (pending === undefined) throw fail("protocol");
    // Hold the greater of the complete pending page and its successor
    // BEFORE a caller response factory can run. Empty/short pages still
    // require native-token and opaque-handle bookkeeping at ACK.
    this.#retainPending(state);
    const successor = this.#successorCharge(state, pending);
    const nextBytes = successor.bytes, nextNodes = successor.nodes;
    const next = pending.next === undefined ? undefined : opaque() as AthenaCursor;
    const value = this.#pageValue(state, next);
    const result = await op.io(() => factory(value, () => { op.check(); }));
    if (nextBytes > state.bytes || nextNodes > state.nodes) throw fail("bounds");
    op.prepareDelivery(); this.#ack(state, old, next, op);
    // Owned-only accounting; no foreign callbacks or clock reads after ACK.
    this.#bytes += nextBytes - state.bytes; this.#nodes += nextNodes - state.nodes; state.bytes = nextBytes; state.nodes = nextNodes;
    return result;
  }
  public queryPage(query: StructuredQuery<unknown>, options: AthenaReadOptions = {}): Promise<AthenaNativePage> { return this.mapQueryPage(query, options, value => value); }
  public async mapQueryPage<T>(query: StructuredQuery<unknown>, options: AthenaReadOptions, factory: (page: AthenaNativePage, check: () => void) => T | PromiseLike<T>, deadlineAt?: number): Promise<T> {
    const op = this.#manager.begin(options.signal, deadlineAt); let state: Journey | undefined;
    try {
      this.#prune(); if (this.#journeys.size >= op.limits.maxCursors) throw fail("bounds");
      const offset = integer(field(options, "offset") ?? 0, 0, 100_000), pageSize = integer(field(options, "pageSize") ?? 100, 1, 1000);
      if (field(options, "offset") !== undefined && field(query, "offset") !== undefined && field(query, "offset") !== offset) throw fail("input");
      const projection = field(options, "projection");
      const plan = compile(query, this.#source, offset, op, projection === undefined ? undefined : array(projection, op.limits.maxColumns).map(value => text(value))); const wire = this.#wire(plan, op);
      const scope = await hash(wire + "\0" + this.#source.sourceId, op);
      const submission = this.#submission(plan, op);
      state = { plan, started: op.started, expires: op.expires, pageSize, budget: initialCounters(), scope, submission,
        principal: { principal: "", generation: "" }, submit: { principal: "", generation: "" }, queryId: "", completed: false, cancelStarted: false, header: false, busy: false, retired: false, bytes: 0, nodes: 0, executionRows: 0, authorityLease: false, seen: new Set() };
      this.#journeys.add(state); this.#own(state, op); this.#reserve(state);
      const principal = await this.#identity(op); state.principal = principal.binding; state.submit = principal.admitted;
      await this.#submit(state, op); await this.#read(state, principal.admitted, op);
      return await this.#deliver(state, undefined, op, factory);
    } catch (error) {
      if (state !== undefined) { state.retired = true; this.#cancel(state, op); }
      throw op.failure(error);
    } finally { op.finish(); }
  }
  public nextPage(cursor: AthenaCursor, signal?: AbortSignal): Promise<AthenaNativePage> { return this.mapNextPage(cursor, signal, value => value); }
  public async mapNextPage<T>(cursor: AthenaCursor, signal: AbortSignal | undefined, factory: (page: AthenaNativePage, check: () => void) => T | PromiseLike<T>, deadlineAt?: number): Promise<T> {
    const state = typeof cursor === "string" ? this.#handles.get(cursor) : undefined; const op = this.#manager.begin(signal, Math.min(state?.expires ?? Infinity, deadlineAt ?? Infinity));
    try {
      this.#prune(); if (state === undefined || state.cursor !== cursor || state.retired) throw fail("cursor");
      this.#own(state, op);
      const principal = await this.#identity(op); if (!sameAuthority(principal.binding, state.principal)) throw fail("permission");
      await this.#read(state, principal.admitted, op); return await this.#deliver(state, cursor, op, factory);
    } catch (error) { throw op.failure(error); }
    finally { op.finish(); }
  }
  /** A configured mapping copy, never mutable authority or discovered schema. */
  public configuredTable(collection: string): AthenaTable {
    if (!Object.hasOwn(this.#source.tables, collection)) throw fail("input");
    const table = this.#source.tables[collection]; if (table === undefined) throw fail("input");
    return { table: table.table, columns: { ...table.columns }, ...(table.idColumn === undefined ? {} : { idColumn: table.idColumn }) };
  }
  /** Core facade batch: one original scope and aggregate budget, no successful prefix. */
  public async mapQueries<T>(admit: (check: () => void) => readonly StructuredQuery<unknown>[], factory: (pages: readonly AthenaNativePage[], check: () => void) => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    const op = this.#manager.begin(signal); const states: Journey[] = [];
    try {
      this.#prune(); const queries = op.call(() => admit(() => { op.check(); }));
      if (!Array.isArray(queries) || queries.length > 100 || this.#journeys.size + queries.length > op.limits.maxCursors) throw fail("bounds");
      const plans = queries.map(query => compile(query, this.#source, 0, op));
      const submissions = plans.map(plan => this.#submission(plan, op));
      if (submissions.reduce((sum, wire) => sum + utf8(wire), 0) > op.limits.maxInputBytes) throw fail("bounds");
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i], submission = submissions[i]; if (plan === undefined || submission === undefined) throw fail("protocol");
        const state: Journey = { plan, started: op.started, expires: op.expires, pageSize: 100, budget: op.budget, scope: "core-batch", submission,
          principal: { principal: "", generation: "" }, submit: { principal: "", generation: "" }, queryId: "", completed: false, cancelStarted: false, header: false, busy: false, retired: false, bytes: 0, nodes: 0, executionRows: 0, authorityLease: false, seen: new Set() };
        this.#journeys.add(state); states.push(state); this.#own(state, op); const base = this.#baseCharge(state); this.#quota(state, base.bytes, base.nodes);
      }
      const first = states[0]; if (first !== undefined) this.#reserve(first);
      const principal = states.length === 0 ? undefined : await this.#identity(op); const values: AthenaNativePage[] = [];
      for (const state of states) {
        if (principal === undefined) throw fail("protocol"); state.principal = principal.binding; state.submit = principal.admitted;
        await this.#submit(state, op); state.batchRows = [];
        for (;;) {
          await this.#read(state, principal.admitted, op); const pending = state.pending; if (pending === undefined) throw fail("protocol");
          state.batchRows.push(...pending.rows); state.budget.rows += pending.rows.length; state.executionRows += pending.rows.length;
          state.header = pending.header; state.columns = pending.columns;
          if (pending.next === undefined) break;
          state.seen.add(pending.next); state.token = pending.next; delete state.pending; this.#retainPending(state);
        }
        values.push({ columns: state.columns ?? [], rows: state.batchRows.map(row => [...row]), ordinalStart: 0, hasMore: false,
          receipt: { sourceId: this.#source.sourceId, queryId: state.queryId, state: "SUCCEEDED", complete: true, counters: { ...state.budget }, ...(state.scanned === undefined ? {} : { dataScannedBytes: state.scanned }) } });
        delete state.pending; this.#retainPending(state);
      }
      const result = await op.io(() => factory(values, () => { op.check(); })); op.prepareDelivery();
      for (const state of states) state.retired = true;
      return result;
    } catch (error) { for (const state of states) { state.retired = true; this.#cancel(state, op); } throw op.failure(error); }
    finally { op.finish(); }
  }

}
