import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BigQueryAnalyticalClient, ExecutionFailure, MemoryLedger, IndexedDBLedger, compileReadPlan, type Ledger, type LedgerState, type Bounds, type Clock, type Execution, type Page, type ReadQuery, type SourceProfile, type TrustedIdentity } from "../src/analytical.js";
const source: SourceProfile = {
  version: 1, sourceId: "fixture", descriptorDigest: "revision1", logicalCollection: "sample", sourceProject: "source-project", datasetId: "ds", tableId: "tbl", location: "EU", schema: [{
      name: "n", type: "INTEGER", mode: "NULLABLE"
    }], publisherReviewRef: "review:publisher", rightsReviewRef: "review:rights", use: "connection-test"
};
const query: ReadQuery = {
  from: "sample", projection: ["n"], where: null, order: [], limit: 100
};
const execution: Execution = {
  jobProject: "job-project", principal: {
    kind: "workload", subject: "operator:fixture", generation: "1"
  }, maximumBytesBilled: "1000", sessionBudgetBytes: "3000"
};
const job = {
  projectId: "job-project", jobId: "j", location: "EU"
};
const dataset = {
  datasetReference: {
    projectId: "source-project", datasetId: "ds"
  }, location: "EU"
};
const table = {
  tableReference: {
    projectId: "source-project", datasetId: "ds", tableId: "tbl"
  }, type: "TABLE", schema: {
    fields: source.schema
  }
};
const schema = {
  fields: source.schema
};
const rows = (...values: (string | null)[]): unknown[] => values.map(v => ({
  f: [{
      v
    }]
}));
const complete = (values: (string | null)[], next?: string): unknown => ({
  jobReference: job, jobComplete: true, schema, rows: rows(...values), ...(next === undefined ? {} : {
    pageToken: next
  })
});
interface Step {
  body?: unknown;
  raw?: string;
  status?: number;
  headers?: Record<string, string>;
  transportError?: boolean;
  inspect?: (url: URL, init: RequestInit) => void;
  advance?: number;
}
function fixture(steps: Step[], limitOverrides: Partial<Bounds> = {}, ledger: Ledger = new MemoryLedger()) {
  let now = Date.UTC(2026, 9, 5);
  const calls: {
    url: URL;
    init: RequestInit;
  }[] = [];
  let identity: TrustedIdentity = {
    principal: execution.principal, accessToken: "test-token", expiresAt: now + 1000000, read: true, cancel: true
  };
  let policy = "policy1";
  let activeQuery = query;
  let prepareAdvance = 0;
  let identityAdvance = 0;
  const clock: Clock = {
    now: () => now, sleep: async (ms, signal) => { if (signal?.aborted)
      throw new Error("stopped"); now += ms; }
  };
  const create = (storage: Ledger = ledger) => BigQueryAnalyticalClient.create({
    profiles: [source], ledger: storage, clock, prepare: async () => { now += prepareAdvance; return {
      source, query: activeQuery, policyDigest: policy
    }; }, provider: {
      authorize: async () => { now += identityAdvance; return identity; }
    }, fetch: async (url, init) => {
      const next = steps.shift();
      if (next === undefined)
        throw new Error("unexpected request");
      const parsed = new URL(url);
      calls.push({
        url: parsed, init
      });
      expect(parsed.origin).toBe("https://bigquery.googleapis.com");
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      next.inspect?.(parsed, init);
      now += next.advance ?? 0;
      if (next.transportError)
        throw new Error("secret raw transport details");
      return new Response(next.raw ?? JSON.stringify(next.body ?? {}), {
        status: next.status ?? 200, headers: next.headers ?? {}
      });
    }
  });
  const previewSteps = [{
      body: dataset
    }, {
      body: table
    }, {
      body: {
        totalBytesProcessed: "100"
      }
    }];
  const executionSteps = [...previewSteps, {
      body: dataset
    }, {
      body: table
    }];
  return {
    prepareAdvance: (ms: number) => { prepareAdvance = ms; }, identityAdvance: (ms: number) => { identityAdvance = ms; }, ledger, clock, calls, steps, create, previewSteps, executionSteps, limits: {
      pageSize: 2, ...limitOverrides
    }, advance: (ms: number) => { now += ms; }, identity: (value: Partial<TrustedIdentity>) => { identity = {
      ...identity, ...value
    }; }, policy: () => { policy = "changed"; }, query: (value: ReadQuery) => { activeQuery = value; }
  };
}
async function start(f: ReturnType<typeof fixture>, initial: Step = {
  body: complete(["1", "1"], "p2")
}) { f.steps.push(...f.previewSteps, ...f.executionSteps, initial); const client = await f.create(); const preview = await client.preview(execution, f.limits); const approval = await client.approve(preview, preview.approvalDigest); return {
  client, preview, approval, run: await client.execute(approval)
}; }
/** Trusted-storage completion hooks, including callbacks after the lease releases. */
class CompletionLedger implements Ledger {
  readonly base = new MemoryLedger();
  afterCommit: ((before: LedgerState, after: LedgerState) => void) | undefined;
  afterLease: (() => void | Promise<void>) | undefined;
  async update<T>(mutator: (state: LedgerState) => T): Promise<T> {
    let before: LedgerState;
    let after: LedgerState;
    const result = await this.base.update(state => {
      before = structuredClone(state);
      const value = mutator(state);
      after = structuredClone(state);
      return value;
    });
    this.afterCommit?.(before!, after!);
    return result;
  }
  async withLease<T>(id: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const result = await this.base.withLease(id, signal, operation);
    await this.afterLease?.();
    return result;
  }
  stopAt(boundary: "commit" | "read" | "lease", action: () => void): void {
    let delivered = false;
    const fire = (): void => { this.afterCommit = undefined; this.afterLease = undefined; action(); };
    this.afterCommit = (before, after) => {
      const previous = Object.values(before.runs)[0];
      const current = Object.values(after.runs)[0];
      const delivery = current?.cursor !== null && current?.cursor !== undefined && current.cursor.ledgerRef !== previous?.cursor?.ledgerRef;
      if (delivery) {
        delivered = true;
        if (boundary === "commit") fire();
      } else if (delivered && boundary === "read") fire();
    };
    if (boundary === "lease") this.afterLease = fire;
  }
}
afterEach(() => vi.unstubAllGlobals());
describe("bounded analytical production execution", () => {
  for (const boundary of ["commit", "read", "lease"] as const) {
    for (const mode of ["row", "page", "empty"] as const) {
      it.each(["caller", "caller-deadline", "execution-deadline"] as const)(`does not acknowledge late ${mode} delivery after ${boundary}: %s`, async stop => {
        const ledger = new CompletionLedger();
        const f = fixture([], {}, ledger);
        const { run } = await start(f, { body: complete(mode === "empty" ? [] : ["1", "2"]) });
        const original = await ledger.base.update(state => Object.values(state.runs)[0]);
        if (original === undefined) throw new Error("missing run");
        const calls = f.calls.length;
        const controller = new AbortController();
        const callerDeadline = f.clock.now() + 5000;
        ledger.stopAt(boundary, () => {
          if (stop === "caller") controller.abort("synthetic-secret");
          else f.advance(stop === "caller-deadline" ? 5000 : 120001);
        });
        const options = { signal: controller.signal, ...(stop === "caller-deadline" ? { callerDeadline } : {}) };
        const failure = await (mode === "row" ? run.nextRow(options) : run.nextPage(options)).then(() => { throw new Error("late delivery succeeded"); }, error => error as ExecutionFailure);
        expect(failure).toBeInstanceOf(ExecutionFailure);
        expect(failure.code).toBe("local_stopped");
        expect(failure.message).not.toContain("synthetic-secret");
        const stopped = await ledger.base.update(state => Object.values(state.runs)[0]);
        expect(stopped?.offset).toBe(original.offset);
        expect(stopped?.cursor).toEqual(original.cursor);
        expect(stopped?.receipt.counters).toEqual(original.receipt.counters);
        expect(stopped?.receipt.localStopped).toBe(true);
        expect(stopped?.reservation).toBe(original.reservation);
        expect(stopped?.receipt.job).toEqual(original.receipt.job);
        expect(stopped?.receipt.executionDeadline).toBe(original.receipt.executionDeadline);
        expect(stopped?.activePrincipal).toEqual(original.activePrincipal);
        if (stop === "execution-deadline") {
          await expect(mode === "row" ? failure.run.nextRow() : failure.run.nextPage()).rejects.toThrow("local_stopped");
        } else {
          const recovered = mode === "row" ? await failure.run.nextRow() : await failure.run.nextPage();
          expect(recovered?.rows.map(row => row[0]?.value)).toEqual(mode === "empty" ? [] : mode === "row" ? ["1"] : ["1", "2"]);
          expect(recovered?.receipt.counters.rows).toBe(mode === "empty" ? 0 : mode === "row" ? 1 : 2);
        }
        expect(f.calls).toHaveLength(calls);
        expect(f.calls.filter(call => call.init.method === "POST" && JSON.parse(call.init.body as string).dryRun === false)).toHaveLength(1);
      });
    }
  }
  it("keeps an acknowledged partial cursor and buffer when the next row is cancelled", async () => {
    const ledger = new CompletionLedger();
    const f = fixture([], {}, ledger);
    const { client, run } = await start(f, { body: complete(["1", "2"]) });
    const first = await run.nextRow() as Page;
    const original = await ledger.base.update(state => Object.values(state.runs)[0]);
    const controller = new AbortController();
    ledger.stopAt("read", () => controller.abort());
    const failure = await run.nextRow({ signal: controller.signal }).catch(error => error as ExecutionFailure);
    expect(failure).toBeInstanceOf(ExecutionFailure);
    const stopped = await ledger.base.update(state => Object.values(state.runs)[0]);
    expect(stopped?.cursor).toEqual(original?.cursor);
    expect(stopped?.offset).toBe(1);
    expect(stopped?.receipt.counters).toEqual(original?.receipt.counters);
    // The returned fresh handle must keep the existing partial buffer, not
    // perform an ordinary fetch that resets offset zero and repeats row one.
    const count = f.calls.length;
    const next = await (failure as ExecutionFailure).run.nextRow();
    expect(next?.rows[0]?.[0]?.value).toBe("2");
    expect(next?.receipt.counters.rows).toBe(2);
    expect(f.calls).toHaveLength(count);
    expect(await (failure as ExecutionFailure).run.nextRow()).toBeNull();
    await expect(client.resume(first.receipt, first.cursor as string)).rejects.toThrow("cursor_invalid");
  });
  it("retains transport charges and the preceding cursor when a later fetched page is not delivered", async () => {
    const ledger = new CompletionLedger();
    const f = fixture([], {}, ledger);
    const { client, run } = await start(f, { body: complete(["1"], "p2") });
    const first = await run.nextPage() as Page;
    const original = await ledger.base.update(state => Object.values(state.runs)[0]);
    f.steps.push({ body: { jobComplete: true, rows: rows("2") } });
    const controller = new AbortController();
    ledger.stopAt("lease", () => controller.abort());
    await expect(run.nextPage({ signal: controller.signal })).rejects.toThrow("local_stopped");
    const stopped = await ledger.base.update(state => Object.values(state.runs)[0]);
    expect(stopped?.cursor).toEqual(original?.cursor);
    expect(stopped?.offset).toBe(0);
    expect(stopped?.receipt.counters.rows).toBe(1);
    expect(stopped?.receipt.counters.bytes).toBeGreaterThan(original?.receipt.counters.bytes ?? 0);
    expect(stopped?.receipt.counters.pages).toBe((original?.receipt.counters.pages ?? 0) + 1);
    expect(stopped?.reservation).toBe("1000");
    expect(stopped?.receipt.executionDeadline).toBe(original?.receipt.executionDeadline);
    expect(stopped?.receipt.job).toEqual(job);
    f.steps.push({ body: { jobComplete: true, rows: rows("2") } });
    const resumed = await client.resume(first.receipt, first.cursor as string);
    const second = await resumed.nextPage();
    expect(second?.rows[0]?.[0]?.value).toBe("2");
    expect(second?.receipt.counters.rows).toBe(2);
    expect(f.calls.filter(call => call.init.method === "POST" && JSON.parse(call.init.body as string).dryRun === false)).toHaveLength(1);
  });
  it("checks clock-triggered caller abort and a late null after the final lease callback", async () => {
    const ledger = new CompletionLedger();
    const f = fixture([], {}, ledger);
    const { run } = await start(f, { body: complete([]) });
    await run.nextPage();
    const controller = new AbortController();
    const now = f.clock.now;
    let finalClock = false;
    f.clock.now = () => { const value = now(); if (finalClock) controller.abort(); return value; };
    ledger.afterLease = () => { finalClock = true; };
    await expect(run.nextPage({ signal: controller.signal })).rejects.toThrow("local_stopped");
    expect((await ledger.base.update(state => Object.values(state.runs)[0]))?.receipt.counters.rows).toBe(0);
  });
  it.each(["caller", "caller-deadline", "execution-deadline"] as const)("rejects a terminal null whose final lease callback stops the read: %s", async stop => {
    const ledger = new CompletionLedger();
    const f = fixture([], {}, ledger);
    const { run } = await start(f, { body: complete([]) });
    await run.nextPage();
    const before = await ledger.base.update(state => Object.values(state.runs)[0]);
    const count = f.calls.length;
    const controller = new AbortController();
    const callerDeadline = f.clock.now() + 5000;
    ledger.afterLease = () => {
      ledger.afterLease = undefined;
      if (stop === "caller") controller.abort();
      else f.advance(stop === "caller-deadline" ? 5000 : 120001);
    };
    await expect(run.nextPage({ signal: controller.signal, ...(stop === "caller-deadline" ? { callerDeadline } : {}) })).rejects.toThrow("local_stopped");
    const after = await ledger.base.update(state => Object.values(state.runs)[0]);
    expect(after?.cursor).toEqual(before?.cursor);
    expect(after?.receipt.counters).toEqual(before?.receipt.counters);
    expect(f.calls).toHaveLength(count);
  });
  it.each(["ledgerRef", "offset", "rows"] as const)("never rolls back a superseding delivery when its %s no longer matches", async field => {
    const ledger = new CompletionLedger();
    const f = fixture([], {}, ledger);
    const { run } = await start(f, { body: complete(["1", "2"]) });
    const controller = new AbortController();
    let newer: unknown;
    ledger.afterLease = async () => {
      ledger.afterLease = undefined;
      newer = await ledger.base.update(state => {
        const current = Object.values(state.runs)[0];
        if (current === undefined || current.cursor === null) throw new Error("missing delivery");
        if (field === "ledgerRef") current.cursor = { ...current.cursor, ledgerRef: "superseding-cursor" };
        else if (field === "offset") current.offset += 1;
        else current.receipt = { ...current.receipt, counters: { ...current.receipt.counters, rows: current.receipt.counters.rows + 1 } };
        return { offset: current.offset, rows: current.receipt.counters.rows, cursor: current.cursor };
      });
      controller.abort();
    };
    await expect(run.nextRow({ signal: controller.signal })).rejects.toThrow("local_stopped");
    expect(await ledger.base.update(state => { const current = Object.values(state.runs)[0]; return { offset: current?.offset, rows: current?.receipt.counters.rows, cursor: current?.cursor }; })).toEqual(newer);
  });
  it("uses source!=job project, one capped submit, same-job schema reuse and authoritative billing", async () => {
    const f = fixture([]);
    const { client, run, approval } = await start(f);
    const first = await run.nextPage() as Page;
    expect(first.rows.map(row => row[0]?.value)).toEqual(["1", "1"]);
    expect(first.receipt.state).toBe("running");
    expect(first.receipt.residualSourceReplacementRace).toBe(true);
    f.steps.push({
      body: {
        jobReference: job, jobComplete: true, rows: rows("9223372036854775807")
      }, inspect: (url, init) => { expect(init.method).toBe("GET"); expect(url.searchParams.get("pageToken")).toBe("p2"); expect(url.searchParams.get("formatOptions.useInt64Timestamp")).toBe("true"); }
    });
    const second = await run.nextPage() as Page;
    expect(second.rows[0]?.[0]?.value).toBe("9223372036854775807");
    expect(second.schema).toEqual(source.schema);
    f.steps.push({
      body: {
        jobReference: job, status: {
          state: "DONE"
        }, statistics: {
          query: {
            totalBytesBilled: "80"
          }
        }
      }
    });
    expect((await client.status(second.receipt)).state).toBe("completed");
    expect((await run.receipt()).billedBytes).toBe("80");
    const submits = f.calls.filter(call => call.init.method === "POST" && JSON.parse(call.init.body as string).dryRun === false);
    expect(submits).toHaveLength(1);
    expect(JSON.parse(submits[0]?.init.body as string)).toMatchObject({
      maximumBytesBilled: "1000", jobCreationMode: "JOB_CREATION_REQUIRED", useLegacySql: false, formatOptions: {
        useInt64Timestamp: true
      }
    });
    await expect(client.execute(approval)).rejects.toThrow("approval_required");
    expect(f.steps).toHaveLength(0);
  });
  it("persists partial offset and rejects stale cursor, changed content and mixed modes", async () => {
    const f = fixture([]);
    const { client, run } = await start(f);
    const first = await run.nextRow() as Page;
    expect(first.rows[0]?.[0]?.value).toBe("1");
    await expect(run.nextPage()).rejects.toThrow("invalid_input");
    await run.close();
    f.steps.push({
      body: complete(["1", "1"], "p2"), inspect: url => { expect(url.searchParams.get("startIndex")).toBe("0"); expect(url.searchParams.has("pageToken")).toBe(false); }
    });
    const another = await f.create();
    const resumed = await another.resume(first.receipt, first.cursor as string);
    const last = await resumed.nextRow() as Page;
    expect(last.rows.map(row => row[0]?.value)).toEqual(["1"]);
    expect(last.receipt.counters.rows).toBe(2);
    await expect(client.resume(first.receipt, first.cursor as string)).rejects.toThrow("cursor_invalid");
    f.steps.push({
      body: {
        jobComplete: true, rows: rows("9")
      }
    });
    const next = await another.resume(last.receipt, last.cursor as string);
    expect((await next.nextRow())?.rows[0]?.[0]?.value).toBe("9");
  });
  it("119-second stop/121-second Resume makes zero requests and retains original counters/deadline", async () => {
    const f = fixture([]);
    const { client, run } = await start(f);
    const first = await run.nextRow() as Page;
    f.advance(119000);
    await run.close();
    const original = await run.receipt();
    f.advance(2000);
    const count = f.calls.length;
    let failure: ExecutionFailure | undefined;
    try {
      await client.resume(first.receipt, first.cursor as string);
    }
    catch (error) {
      failure = error as ExecutionFailure;
    }
    expect(failure).toBeInstanceOf(ExecutionFailure);
    expect(failure?.code).toBe("local_stopped");
    expect(f.calls).toHaveLength(count);
    expect(failure?.receipt.counters).toEqual(original.counters);
    expect(failure?.receipt.executionDeadline).toBe(original.executionDeadline);
    expect(failure?.receipt.job).toEqual(job);
    f.steps.push({
      body: {
        jobReference: job, status: {
          state: "DONE"
        }
      }
    });
    await client.status(original);
    const state = await f.ledger.update(state => Object.values(state.runs)[0]);
    expect(state?.reservation).toBe("1000");
  });
  it.each(["VIEW", "EXTERNAL", "MATERIALIZED_VIEW", "SNAPSHOT", "CLONE", "unknown"])("rejects native eligibility %s before dry-run", async (type) => {
    const f = fixture([{
        body: dataset
      }, {
        body: {
          ...table, type
        }
      }]);
    const client = await f.create();
    await expect(client.preview(execution)).rejects.toThrow("source_ineligible");
    expect(f.calls.every(call => call.init.method === "GET")).toBe(true);
  });
  it("rejects unsupported configurations and changed metadata without paid dispatch", async () => {
    for (const config of ["externalDataConfiguration", "view", "biglakeConfiguration", "unknownExecution"]) {
      const f = fixture([{
          body: dataset
        }, {
          body: {
            ...table, [config]: {}
          }
        }]);
      await expect((await f.create()).preview(execution)).rejects.toThrow("source_ineligible");
    }
    const f = fixture([]);
    f.steps.push(...f.previewSteps, ...f.previewSteps, {
      body: dataset
    }, {
      body: {
        ...table, type: "VIEW"
      }
    });
    const client = await f.create();
    const preview = await client.preview(execution);
    const approval = await client.approve(preview, preview.approvalDigest);
    await expect(client.execute(approval)).rejects.toThrow("source_ineligible");
    expect(f.calls.filter(call => call.init.method === "POST" && JSON.parse(call.init.body as string).dryRun === false)).toHaveLength(0);
  });
  it.each([true, false])("rejects conflicting partition filters before preview and submit: deprecated=%s", async deprecated => {
    const conflicting = { ...table, timePartitioning: { type: "DAY", requirePartitionFilter: deprecated }, requirePartitionFilter: !deprecated };
    const first = fixture([{ body: dataset }, { body: conflicting }]);
    await expect((await first.create()).preview(execution)).rejects.toThrow("source_ineligible");
    expect(first.calls.every(call => call.init.method === "GET")).toBe(true);

    const beforeSubmit = fixture([]);
    beforeSubmit.steps.push(...beforeSubmit.previewSteps, ...beforeSubmit.previewSteps, { body: dataset }, { body: conflicting });
    const client = await beforeSubmit.create();
    const preview = await client.preview(execution);
    await expect(client.execute(await client.approve(preview, preview.approvalDigest))).rejects.toThrow("source_ineligible");
    expect(beforeSubmit.calls.filter(call => call.init.method === "POST" && JSON.parse(call.init.body as string).dryRun === false)).toHaveLength(0);
  });
  it.each([true, false])("binds matching current and deprecated partition filters: %s", async required => {
    const configured = { ...table, timePartitioning: { type: "DAY", requirePartitionFilter: required }, requirePartitionFilter: required };
    const f = fixture([{ body: dataset }, { body: configured }, { body: { totalBytesProcessed: "100" } }]);
    const preview = await (await f.create()).preview(execution);
    expect(preview.observation.config).toEqual({ timePartitioning: { type: "DAY", requirePartitionFilter: required }, requirePartitionFilter: required });
  });
  it("refuses an initial result page exceeding approved LIMIT while retaining the known job and reservation", async () => {
    const f = fixture([]);
    f.query({ ...query, limit: 1 });
    f.steps.push(...f.previewSteps, ...f.executionSteps, { body: complete(["1", "2"]) });
    const client = await f.create();
    const preview = await client.preview(execution, f.limits);
    await expect(client.execute(await client.approve(preview, preview.approvalDigest))).rejects.toThrow("malformed_wire");
    const record = await f.ledger.update(state => Object.values(state.runs)[0]);
    expect(record?.receipt.job).toEqual(job);
    expect(record?.receipt.counters.rows).toBe(0);
    expect(record?.reservation).toBe("1000");
  });
  it("refuses split-page LIMIT contradictions without delivering extra rows or releasing the reservation", async () => {
    const f = fixture([]);
    f.query({ ...query, limit: 2 });
    const { run } = await start(f, { body: complete(["1"], "p2") });
    expect((await run.nextPage())?.rows).toHaveLength(1);
    f.steps.push({ body: { jobComplete: true, rows: rows("2", "3") } });
    await expect(run.nextPage()).rejects.toThrow("malformed_wire");
    expect((await run.receipt()).counters.rows).toBe(1);
    expect((await f.ledger.update(state => Object.values(state.runs)[0]))?.reservation).toBe("1000");
  });
  it("retains the LIMIT and consumed offset across partial-page Resume", async () => {
    const f = fixture([], { pageSize: 3 });
    f.query({ ...query, limit: 2 });
    const { client, run } = await start(f, { body: { ...(complete(["1", "2"]) as object), totalRows: "2" } });
    const first = await run.nextRow() as Page;
    await run.close();
    f.steps.push({ body: { ...(complete(["1", "2"]) as object), totalRows: "2" } });
    const resumed = await client.resume(first.receipt, first.cursor as string);
    const last = await resumed.nextRow();
    expect(last?.rows[0]?.[0]?.value).toBe("2");
    expect(last?.receipt.counters.rows).toBe(2);
    const count = f.calls.length;
    expect(await resumed.nextRow()).toBeNull();
    expect(f.calls).toHaveLength(count);
    expect((await f.ledger.update(state => Object.values(state.runs)[0]))?.reservation).toBe("1000");
  });
  it("rejects an oversized partial-page refetch before it can deliver beyond LIMIT", async () => {
    const f = fixture([], { pageSize: 3 });
    f.query({ ...query, limit: 2 });
    const { client, run } = await start(f, { body: complete(["1", "2"]) });
    const first = await run.nextRow() as Page;
    await run.close();
    f.steps.push({ body: complete(["1", "2", "3"]) });
    await expect(client.resume(first.receipt, first.cursor as string)).rejects.toThrow("malformed_wire");
    expect((await run.receipt()).counters.rows).toBe(1);
    expect((await f.ledger.update(state => Object.values(state.runs)[0]))?.reservation).toBe("1000");
  });
  it.each(["3", "0", 2, "2.0"])("rejects malformed or contradictory totalRows: %s", async totalRows => {
    const f = fixture([]);
    f.query({ ...query, limit: 2 });
    f.steps.push(...f.previewSteps, ...f.executionSteps, { body: { ...(complete(["1"]) as object), totalRows } });
    const client = await f.create();
    const preview = await client.preview(execution, f.limits);
    await expect(client.execute(await client.approve(preview, preview.approvalDigest))).rejects.toThrow("malformed_wire");
    expect((await f.ledger.update(state => Object.values(state.runs)[0]))?.receipt.counters.rows).toBe(0);
  });
  it("rejects changed totalRows on later pages of the same job", async () => {
    const f = fixture([]);
    const { run } = await start(f, { body: { ...(complete(["1"], "p2") as object), totalRows: "3" } });
    await run.nextPage();
    f.steps.push({ body: { jobComplete: true, rows: rows("2"), totalRows: "2" } });
    await expect(run.nextPage()).rejects.toThrow("malformed_wire");
    expect((await run.receipt()).counters.rows).toBe(1);
  });
  it("rejects terminal totalRows contradicting missing continuation", async () => {
    const f = fixture([]);
    f.steps.push(...f.previewSteps, ...f.executionSteps, { body: { ...(complete(["1"]) as object), totalRows: "2" } });
    const client = await f.create();
    const preview = await client.preview(execution, f.limits);
    await expect(client.execute(await client.approve(preview, preview.approvalDigest))).rejects.toThrow("malformed_wire");
    expect((await f.ledger.update(state => Object.values(state.runs)[0]))?.receipt.counters.rows).toBe(0);
  });
  it("caps delivery to the stricter maxRows even when the approved LIMIT is higher", async () => {
    const f = fixture([], { maxRows: 1 });
    f.query({ ...query, limit: 2 });
    const { run } = await start(f, { body: complete(["1", "2"]) });
    expect((await run.nextPage())?.rows).toHaveLength(1);
    const count = f.calls.length;
    await expect(run.nextPage()).rejects.toThrow("response_limit");
    expect((await run.receipt()).counters.rows).toBe(1);
    expect(f.calls).toHaveLength(count);
  });
  it.each([{
      transportError: true
    }, {
      status: 503, raw: "provider secret"
    }, {
      raw: '{"jobReference":{"projectId":"job-project","jobId":"j","location":"EU"},"jobComplete":true,"jobComplete":false}'
    }])("never retries ambiguous submission %#", async (failure) => {
    const f = fixture([]);
    f.steps.push(...f.previewSteps, ...f.executionSteps, failure);
    const client = await f.create();
    const preview = await client.preview(execution);
    const approval = await client.approve(preview, preview.approvalDigest);
    let error: ExecutionFailure | undefined;
    try {
      await client.execute(approval);
    }
    catch (caught) {
      error = caught as ExecutionFailure;
    }
    expect(error?.receipt.state).toBe("submission_unknown");
    expect(error?.message).not.toContain("secret");
    expect(f.calls.filter(call => call.init.method === "POST" && JSON.parse(call.init.body as string).dryRun === false)).toHaveLength(1);
    expect((await f.ledger.update(state => Object.values(state.runs)[0]))?.reservation).toBe("1000");
    await expect(client.execute(approval)).rejects.toThrow("approval_required");
  });
  it("captures known job before malformed cell and retains reservation", async () => {
    const f = fixture([]);
    f.steps.push(...f.previewSteps, ...f.executionSteps, {
      body: {
        jobReference: job, jobComplete: true, schema, rows: [{
            f: [{}]
          }]
      }
    });
    const client = await f.create();
    const preview = await client.preview(execution);
    try {
      await client.execute(await client.approve(preview, preview.approvalDigest));
      throw new Error("accepted");
    }
    catch (error) {
      expect(error).toBeInstanceOf(ExecutionFailure);
      expect((error as ExecutionFailure).receipt.job).toEqual(job);
      expect((error as ExecutionFailure).code).toBe("malformed_wire");
    }
  });
  it("refuses changed policy and identity generation, expiry and absent cancellation scope", async () => {
    const f = fixture([]);
    const { client, run } = await start(f);
    const page = await run.nextRow() as Page;
    f.policy();
    const before = f.calls.length;
    await expect(client.status(page.receipt)).rejects.toThrow("approval_changed");
    expect(f.calls).toHaveLength(before);
    const f2 = fixture([]);
    const state = await start(f2);
    const receipt = await state.run.receipt();
    f2.identity({
      principal: {
        ...execution.principal, generation: "2"
      }
    });
    await expect(state.client.status(receipt)).rejects.toThrow("approval_changed");
    f2.identity({
      principal: execution.principal, expiresAt: 0
    });
    await expect(state.client.status(receipt)).rejects.toThrow("auth_expired");
    f2.identity({
      expiresAt: Date.UTC(2027, 0, 1), cancel: false
    });
    await expect(state.client.cancel(receipt)).rejects.toThrow("scope_missing");
  });
  it("retains cancel_requested until terminal evidence and distinguishes stopped from cancelled", async () => {
    const f = fixture([]);
    const { client, run } = await start(f);
    const receipt = await run.receipt();
    f.steps.push({
      body: {
        job: {
          jobReference: job
        }
      }
    }, {
      body: {
        jobReference: job, status: {
          state: "DONE", errorResult: {
            reason: "stopped"
          }
        }
      }
    });
    expect((await client.cancel(receipt)).state).toBe("cancel_requested");
    expect((await client.status(receipt)).state).toBe("failed");
    expect((await f.ledger.update(state => Object.values(state.runs)[0]))?.reservation).toBe("1000");
  });
  it("charges retry bodies/backoff and enforces cumulative bytes on control", async () => {
    const f = fixture([]);
    const { client, run } = await start(f);
    const receipt = await run.receipt();
    f.steps.push({
      status: 503, raw: '{"error":"redacted"}', headers: {
        "Retry-After": "1"
      }
    }, {
      body: {
        jobReference: job, status: {
          state: "RUNNING"
        }
      }
    });
    const before = (await run.receipt()).counters.bytes;
    expect((await client.status(receipt)).state).toBe("running");
    expect((await run.receipt()).counters.bytes).toBeGreaterThan(before);
    await f.ledger.update(state => { const record = Object.values(state.runs)[0]; if (record)
      record.receipt = {
        ...record.receipt, counters: {
          ...record.receipt.counters, bytes: record.receipt.bounds.totalResponseBytes
        }
      }; });
    const count = f.calls.length;
    await expect(client.status(receipt)).rejects.toThrow("response_limit");
    expect(f.calls).toHaveLength(count);
    expect((await f.ledger.update(state => Object.values(state.runs)[0]))?.reservation).toBe("1000");
  });
  it("guards unsupported whole query and normalizes explicit parameters", async () => {
    const f = fixture([]);
    f.query({
      ...query, sql: "SELECT raw"
    } as ReadQuery);
    await expect((await f.create()).preview(execution)).rejects.toThrow("unsupported_query");
    expect(f.calls).toHaveLength(0);
    const plan = await compileReadPlan(source, {
      ...query, where: {
        op: "IN", column: "n", value: []
      }, order: [{
          column: "n", direction: "ASC"
        }]
    });
    expect(plan.sql).toBe("SELECT `n` FROM `source-project.ds.tbl` WHERE FALSE ORDER BY `n` ASC LIMIT 100");
    expect(plan.where).toEqual({
      op: "IN", column: "n", parameter: "p0"
    });
    expect(plan.parameters).toEqual([{
        name: "p0", type: "ARRAY<INT64>", value: []
      }]);
    await expect(compileReadPlan(source, {
      ...query, where: {
        op: "=", column: "n", value: 9007199254740992
      }
    })).rejects.toThrow("malformed_wire");
  });
  it("returns schema for empty completed results once without another query", async () => {
    const f = fixture([]);
    const { run } = await start(f, {
      body: complete([])
    });
    const count = f.calls.length;
    const page = await run.nextPage();
    expect(page?.schema).toEqual(source.schema);
    expect(page?.rows).toEqual([]);
    expect(page?.receipt.counters.rows).toBe(0);
    expect(await run.nextPage()).toBeNull();
    expect(f.calls).toHaveLength(count);
  });
  it("rebinds only a verified stable subject to the existing job without resetting its budget", async () => {
    const f = fixture([]);
    const { client, run } = await start(f);
    const page = await run.nextRow() as Page;
    const before = f.calls.length;
    f.identity({
      principal: {
        ...execution.principal, generation: "2"
      }
    });
    await expect(run.nextRow()).rejects.toThrow("approval_changed");
    const rebound = await client.rebind(page.receipt, page.cursor as string);
    expect(rebound.receipt.job).toEqual(page.receipt.job);
    expect(rebound.receipt.executionDeadline).toEqual(page.receipt.executionDeadline);
    expect(rebound.receipt.counters).toEqual(page.receipt.counters);
    expect(rebound.receipt.principal).toEqual(page.receipt.principal);
    expect((await f.ledger.update(state => Object.values(state.runs)[0]))?.activePrincipal.generation).toBe("2");
    expect(f.calls).toHaveLength(before);
    await expect(client.resume(page.receipt, page.cursor as string)).rejects.toThrow("cursor_invalid");
    f.steps.push({
      body: complete(["1", "1"], "p2")
    });
    const resumed = await client.resume(rebound.receipt, rebound.cursor as string);
    const latest = await resumed.nextRow() as Page;
    expect(latest.receipt.counters.rows).toBe(2);
    await expect(client.rebind(latest.receipt, latest.cursor as string)).rejects.toThrow("approval_changed");
    f.identity({
      principal: {
        ...execution.principal, subject: "other", generation: "3"
      }
    });
    await expect(client.rebind(latest.receipt, latest.cursor as string)).rejects.toThrow("approval_changed");
    expect((await f.ledger.update(state => Object.values(state.runs)[0]))?.reservation).toBe("1000");
  });
  it("rejects duplicate-key opaque cursor bytes before HTTP", async () => {
    const f = fixture([]);
    const { client, run } = await start(f);
    const first = await run.nextRow() as Page;
    const text = atob((first.cursor as string).replace(/-/g, "+").replace(/_/g, "/"));
    const duplicate = btoa(text.replace('{', '{"version":1,')).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    const count = f.calls.length;
    await expect(client.resume(first.receipt, duplicate)).rejects.toThrow("cursor_invalid");
    expect(f.calls).toHaveLength(count);
  });
  it("persists nonce, partial cursor, cap and deadline across IndexedDB clients", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const held = new Set<string>();
    vi.stubGlobal("navigator", {
      locks: {
        request: async (name: string, _options: unknown, callback: (lock: object | null) => Promise<unknown>) => { if (held.has(name))
          return callback(null); held.add(name); try {
          return await callback({
            name
          });
        }
        finally {
          held.delete(name);
        } }
      }
    });
    const firstLedger = new IndexedDBLedger("durable-test");
    const f = fixture([], {}, firstLedger);
    const resultSentinel = "9223372036854775719";
    const { client, run, approval } = await start(f, { body: complete([resultSentinel, resultSentinel], "p2") });
    const first = await run.nextRow() as Page;
    expect(first.rows[0]?.[0]?.value).toBe(resultSentinel);
    await run.close();
    const before = await firstLedger.update(state => Object.values(state.runs)[0]);
    const secondLedger = new IndexedDBLedger("durable-test");
    expect(await secondLedger.update(state => Object.values(state.runs)[0])).toEqual(before);
    const another = await f.create(secondLedger);
    await expect(another.execute(approval)).rejects.toThrow("approval_required");
    f.steps.push({
      body: complete([resultSentinel, resultSentinel], "p2")
    });
    const resumed = await another.resume(first.receipt, first.cursor as string);
    expect((await resumed.nextRow())?.receipt.counters.rows).toBe(2);
    const after = await secondLedger.update(state => Object.values(state.runs)[0]);
    expect(after?.reservation).toBe("1000");
    expect(after?.receipt.executionDeadline).toBe(before?.receipt.executionDeadline);
    expect(after?.receipt.counters.bytes).toBeGreaterThan(before?.receipt.counters.bytes ?? 0);
    const persisted = JSON.stringify(await secondLedger.update(state => state));
    expect(persisted).not.toContain("test-token");
    expect(persisted).not.toContain(resultSentinel);
    expect(persisted).not.toContain('"rows":[');
    expect(persisted).not.toContain('"f":[');
    expect(persisted).not.toContain('"accessToken"');
    await expect(client.resume(first.receipt, first.cursor as string)).rejects.toThrow("cursor_invalid");
    await expect(firstLedger.update(state => { state.version = 2 as 1; throw new Error("rollback"); })).rejects.toThrow("rollback");
    expect(await secondLedger.update(state => state.version)).toBe(1);
    await Promise.all(Array.from({
      length: 10
    }, () => secondLedger.update(state => { const r = Object.values(state.runs)[0]; if (r)
      r.pageOrdinal += 1; })));
    expect((await firstLedger.update(state => Object.values(state.runs)[0]))?.pageOrdinal).toBe((after?.pageOrdinal ?? 0) + 10);
    await firstLedger.withLease(first.receipt.runId, undefined, async () => { await expect(secondLedger.withLease(first.receipt.runId, undefined, async () => undefined)).rejects.toThrow("local_stopped"); });
  });
  it("expired reconnect preserves result deadline and bounded control preparation", async () => {
    const f = fixture([]);
    const { client, run } = await start(f);
    const page = await run.nextRow() as Page;
    f.advance(121000);
    f.identity({
      principal: {
        ...execution.principal, generation: "2"
      }
    });
    const count = f.calls.length;
    const rebound = await client.rebind(page.receipt, page.cursor as string);
    expect(rebound.receipt.counters).toEqual(page.receipt.counters);
    await expect(client.resume(rebound.receipt, rebound.cursor as string)).rejects.toThrow("local_stopped");
    expect(f.calls).toHaveLength(count);
    f.prepareAdvance(14900);
    f.identityAdvance(200);
    await expect(client.status(rebound.receipt)).rejects.toThrow("local_stopped");
    expect(f.calls).toHaveLength(count);
    expect((await f.ledger.update(state => Object.values(state.runs)[0]))?.reservation).toBe("1000");
    f.prepareAdvance(0);
    f.identityAdvance(0);
    f.steps.push({
      body: {
        jobReference: job, status: {
          state: "RUNNING"
        }
      }
    });
    expect((await client.status(rebound.receipt)).state).toBe("running");
  });
});
