import { collection, providerEvidenceDigest, type StructuredQuery } from "@dalgo/core";
import { parse } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenVaultDbDTQLQueryExecutor, createOpenVaultDbExecutionBudget, createOpenVaultDbExecutionId,
  assertOpenVaultDbExecutionBudget, raceOpenVaultDbExecutionBudget, validateOpenVaultDbDTQLEvidence, validateOpenVaultDbDTQLPlan,
  type OpenVaultDbExecutionOwner } from "../src/dtql/index.js";
import { fixture, response, rows } from "./dtql-fixture.js";
const owners: OpenVaultDbExecutionOwner[] = [];
function owner(): OpenVaultDbExecutionOwner { const handle = createOpenVaultDbExecutionBudget(); owners.push(handle); return handle; }
afterEach(() => { owners.splice(0).forEach(handle => { handle.dispose(); }); vi.restoreAllMocks(); vi.useRealTimers(); });
const query = (): StructuredQuery<{ time: string; currency: string; rate: string }> => collection<{ time: string; currency: string; rate: string }>("daily").query().build();

async function setup() {
  const handle = owner(), f = await fixture(createOpenVaultDbExecutionId(handle.budget));
  const captured = structuredClone(f.metadata);
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(response(captured)));
  const executor = new OpenVaultDbDTQLQueryExecutor({ ...f.config, providerReadPlan: f.plan, budget: handle.budget, fetch: fetcher });
  return { ...f, handle, fetcher, executor };
}
describe("completed native DTQL executor", () => {
  it("POSTs once with exact nonce/YAML/privacy options and preserves lexical rows and detached evidence", async () => {
    const s = await setup();
    const page = await s.executor.query(query());
    expect(page).toMatchObject({ ...s.metadata, complete: true });
    expect(page.records[0]?.data.rate).toBe("001.23000");
    expect(page.records[0]?.key.path).toBe("daily/AAA");
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = s.fetcher.mock.calls[0] ?? [];
    expect(url).toBe(s.config.endpoint);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", mode: "cors", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: s.handle.budget.signal,
      headers: { "Content-Type": "application/yaml", Accept: "application/json", "OVDB-Execution-ID": s.plan.execution.id } });
    expect(parse(init?.body as string)).toEqual({ from: { name: "daily" }, limit: 50 });
    Object.assign(s.plan.execution, { id: "mutation" });
    expect(page.providerReads?.execution.id).toMatch(/^[0-9a-f]{32}$/u);
    await expect(s.executor.query(query())).rejects.toThrow("already used");
  });
  it("preserves mandatory evidence on zero results", async () => {
    const s = await setup(); s.fetcher.mockResolvedValueOnce(response(s.metadata, []));
    expect(await s.executor.query(query())).toEqual({ ...s.metadata, records: [], complete: true });
  });
  it("captures config, plan, query and default limit across asynchronous admission", async () => {
    const s = await setup(), q = query();
    const pending = s.executor.query(q);
    Object.assign(q, { limit: 1 }); Object.assign(s.plan.execution, { id: "changed" }); Object.assign(s.config.admission, { paidAccess: true });
    expect((await pending).records).toHaveLength(1);
    expect(parse(s.fetcher.mock.calls[0]?.[1]?.body as string)).toMatchObject({ limit: 50 });
  });
  it("encodes zero, one and ten flat comparisons with exact string/UTF-8 scalar semantics", async () => {
    for (const values of [[], [""], ["001.23", "2037-02-03", "a: b", "a\nb", "é", "null", "true", "[x]", "# comment", "é".repeat(64)]]) {
      const s = await setup(), q = query(); s.fetcher.mockResolvedValueOnce(response(s.metadata, [])); Object.assign(q, { filters: values.map(value => ({ field: "rate", operator: "==", value })) });
      await s.executor.query(q);
      const parsed = parse(s.fetcher.mock.calls[0]?.[1]?.body as string) as { where?: { right?: { value: unknown }; and?: { right: { value: unknown } }[] } };
      const actual = values.length === 0 ? [] : values.length === 1 ? [parsed.where?.right?.value] : parsed.where?.and?.map(comparison => comparison.right.value);
      expect(actual).toEqual(values);
    }
  });
  it("refuses unsupported/extra query shapes, codecs and signals before Fetch", async () => {
    const mutations = [
      (q: object) => Object.assign(q, { limit: 51 }), (q: object) => Object.assign(q, { limit: 0 }),
      (q: object) => Object.assign(q, { offset: 1 }), (q: object) => Object.assign(q, { extra: true }),
      (q: object) => Object.assign(q, { filters: Array.from({ length: 11 }, () => ({ field: "rate", operator: "==", value: "1" })) }),
      (q: object) => Object.assign(q, { filters: [{ field: "rate", operator: "==", value: "é".repeat(65) }] }),
      (q: object) => Object.assign(q, { filters: [{ field: "rate", operator: "==", value: "x", extra: true }] }),
      (q: object) => Object.assign(q, { filters: [{ field: "currency", operator: "!=", value: "AAA" }] }),
      (q: object) => Object.assign(q, { source: { kind: "collection", name: "daily", codec: { decode: vi.fn(), encode: vi.fn() } } }),
      (q: object) => Object.assign(q, { source: { kind: "collection", name: "daily", extra: true } }),
      (q: object) => Object.assign(q, { startAt: { values: ["x"] } }),
    ];
    for (const mutate of mutations) { const s = await setup(), q = query(); mutate(q); await expect(s.executor.query(q)).rejects.toThrow(); expect(s.fetcher).not.toHaveBeenCalled(); }
    const s = await setup(); await expect(s.executor.query(query(), { signal: new AbortController().signal })).rejects.toThrow("unbound"); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it("rejects changed endpoint/origin/admission/pins and rights before Fetch", async () => {
    for (const kind of ["endpoint", "query", "origin", "expired", "window", "paid", "rights", "execution", "request", "decoder"] as const) {
      const handle = owner(), f = await fixture(createOpenVaultDbExecutionId(handle.budget)), fetcher = vi.fn<typeof fetch>();
      if (kind === "endpoint") Object.assign(f.config, { endpoint: f.config.endpoint + "/" });
      if (kind === "query") Object.assign(f.config, { endpoint: f.config.endpoint + "?" });
      if (kind === "origin") Object.assign(f.config, { origin: "https://other.example" });
      if (kind === "expired") Object.assign(f.config.admission, { expiresAt: new Date(0).toISOString() });
      if (kind === "window") Object.assign(f.config.admission, { expiresAt: new Date(Date.now() + 31 * 86400_000).toISOString() });
      if (kind === "paid") Object.assign(f.config.admission, { paidAccess: true });
      if (kind === "rights") Object.assign(f.plan.sourceRights[0]?.attribution ?? {}, { text: "changed" });
      if (kind === "execution") Object.assign(f.plan.execution, { id: "A".repeat(32) });
      if (kind === "request") Object.assign(f.plan.requests[0] ?? {}, { upstreamUrl: "https://other.example" });
      if (kind === "decoder") Object.assign(f.plan.bindings[0] ?? {}, { decoderDigest: "a".repeat(64) });
      const executor = new OpenVaultDbDTQLQueryExecutor({ ...f.config, providerReadPlan: f.plan, budget: handle.budget, fetch: fetcher });
      await expect(executor.query(query())).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it("refuses any missing/false footer, extra terminal members, changed evidence and invalid native rows", async () => {
    for (const extra of [{ complete: false }, { complete: undefined }, { error: null }, { cursor: null }, { sourceComposition: null }, { nextCursor: null }, { providerReads: undefined }]) {
      const s = await setup(); s.fetcher.mockResolvedValueOnce(response(s.metadata, rows, extra)); await expect(s.executor.query(query())).rejects.toThrow();
    }
    for (const records of [[{ ...rows[0], key: "daily/AAA/child/id" }], [{ ...rows[0], key: "daily/BBB" }], [{ key: "daily/AAA", data: { time: "2037-02-03", currency: "AAA", rate: 1 } }], Array.from({ length: 51 }, () => rows[0])]) {
      const s = await setup(); s.fetcher.mockResolvedValueOnce(response(s.metadata, records)); await expect(s.executor.query(query())).rejects.toThrow("refused");
    }
    const s = await setup(); Object.assign(s.metadata.providerReads?.reads[0] ?? {}, { requestDigest: "b".repeat(64) }); s.fetcher.mockResolvedValueOnce(response(s.metadata)); await expect(s.executor.query(query())).rejects.toThrow();
  });
  it("refuses a second executor on the same owner budget before another POST", async () => {
    const s = await setup(); await s.executor.query(query());
    const second = new OpenVaultDbDTQLQueryExecutor({ ...s.config, providerReadPlan: s.plan, budget: s.handle.budget, fetch: s.fetcher });
    await expect(second.query(query())).rejects.toThrow(); expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it("rechecks admission expiry after body/evidence and honors a captured explicit limit", async () => {
    const s = await setup(); const future = Date.now() + 2 * 86400_000;
    s.fetcher.mockImplementationOnce(() => { vi.spyOn(Date, "now").mockReturnValue(future); return Promise.resolve(response(s.metadata)); });
    await expect(s.executor.query(query())).rejects.toThrow();
    vi.restoreAllMocks();
    const s2 = await setup(); s2.fetcher.mockResolvedValueOnce(response(s2.metadata, [...rows, ...rows]));
    await expect(s2.executor.query(collection("daily").query().limit(1).build())).rejects.toThrow();
  });
  it("refuses zero/nonpositive rates, EUR, duplicate currencies, invalid dates and mismatched equality output", async () => {
    for (const records of [
      [{ key: "daily/AAA", data: { ...rows[0]?.data, rate: "0" } }],
      [{ key: "daily/AAA", data: { ...rows[0]?.data, rate: "0.000" } }],
      [{ key: "daily/EUR", data: { ...rows[0]?.data, currency: "EUR" } }],
      [...rows, ...rows],
      [{ key: "daily/AAA", data: { ...rows[0]?.data, time: "0000-02-03" } }],
      [{ key: "daily/AAA", data: { ...rows[0]?.data, time: "2037-02-04" } }],
    ]) {
      const s = await setup(); s.fetcher.mockResolvedValueOnce(response(s.metadata, records)); await expect(s.executor.query(query())).rejects.toThrow();
    }
    const s = await setup(); const q = collection("daily").query().where("currency", "==", "ZZZ").build();
    await expect(s.executor.query(q)).rejects.toThrow();
    const s2 = await setup(), q2 = collection("daily").query().where("rate", "==", "1.23").build();
    await expect(s2.executor.query(q2)).rejects.toThrow();
  });
  it("requires validated native reference dates and upstream byte bounds even for zero rows", async () => {
    for (const kind of ["missing", "year0", "invalid", "bytes"] as const) {
      const s = await setup(), envelope = s.metadata.providerReads;
      const read = envelope?.reads[0], binding = envelope?.bindings[0];
      if (envelope === undefined || read === undefined || binding === undefined) throw new Error("fixture missing");
      const observation = Object.fromEntries(Object.entries(read).filter(([key]) => key !== "observationId"));
      if (kind === "missing") delete observation.referenceDate;
      if (kind === "year0") observation.referenceDate = "0000-02-03";
      if (kind === "invalid") observation.referenceDate = "2037-02-30";
      if (kind === "bytes") observation.bytes = 2 * 1024 * 1024 + 1;
      const id = await providerEvidenceDigest({ format: "ovdb-read-observation-id/1", execution: envelope.execution, binding, read: observation });
      Object.assign(envelope, { reads: [{ ...observation, observationId: id }], usage: [{ providerSourceId: binding.providerSourceId, rightsSourceId: binding.rightsSourceId, observationIds: [id] }] });
      s.fetcher.mockResolvedValueOnce(response(s.metadata, [])); await expect(s.executor.query(query())).rejects.toThrow();
    }
  });
  it("rejects a copied plan nonce under a second genuine owner before Fetch", async () => {
    const s = await setup(); await s.executor.query(query());
    const h = owner(); createOpenVaultDbExecutionId(h.budget);
    const fetcher = vi.fn<typeof fetch>();
    const copy = new OpenVaultDbDTQLQueryExecutor({ ...s.config, providerReadPlan: structuredClone(s.plan), budget: h.budget, fetch: fetcher });
    await expect(copy.query(query())).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    expect(() => { createOpenVaultDbExecutionId(h.budget); }).toThrow("already issued");
    expect(() => { Object.assign(h.budget, { deadlineAt: Infinity }); }).toThrow();
  });
  it("cannot reset a late populated or zero-row evidence handoff under a second owner", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    for (const records of [rows, []]) {
      const s = await setup(); s.fetcher.mockResolvedValueOnce(response(s.metadata, records));
      const page = await s.executor.query(query());
      now += 10001;
      const next = owner(); createOpenVaultDbExecutionId(next.budget);
      await expect(validateOpenVaultDbDTQLEvidence(page, s.plan, next.budget)).rejects.toThrow("refused");
      await expect(validateOpenVaultDbDTQLEvidence(page, s.plan, s.handle.budget)).rejects.toMatchObject({ name: "TimeoutError" });
    }
  });
  it("waits for EOF and refuses late invalid terminal without returning records", async () => {
    const s = await setup(); let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('{"records":[],')); } });
    s.fetcher.mockResolvedValueOnce(new Response(stream, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }));
    let settled = false; const pending = s.executor.query(query()).finally(() => { settled = true; });
    await vi.waitFor(() => { expect(s.fetcher).toHaveBeenCalledTimes(1); });
    expect(settled).toBe(false); controller?.enqueue(new TextEncoder().encode('"complete":false}')); controller?.close();
    await expect(pending).rejects.toThrow();
  });
  it("rejects oversized chunks/aggregate, invalid UTF-8 and unsafe response properties", async () => {
    for (const body of [new Uint8Array(65537), new Uint8Array([255]), new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(40000)); c.enqueue(new Uint8Array(30000)); c.close(); } })]) {
      const s = await setup(); s.fetcher.mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })); await expect(s.executor.query(query())).rejects.toThrow();
    }
    for (const property of ["redirected", "url", "type", "status"] as const) {
      const s = await setup(), r = response(s.metadata); Object.defineProperty(r, property, { value: { redirected: true, url: "https://wrong.example", type: "opaque", status: 201 }[property] });
      s.fetcher.mockResolvedValueOnce(r); await expect(s.executor.query(query())).rejects.toThrow();
    }
  });
  it("aborts generic callers, stalled readers, hung Fetch and cancels late bodies", async () => {
    const s = await setup(); let resolve: ((r: Response) => void) | undefined;
    s.fetcher.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
    const pending = s.executor.query(query()); await vi.waitFor(() => { expect(s.fetcher).toHaveBeenCalled(); });
    s.handle.cancel(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const cancel = vi.fn(); resolve?.(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await vi.waitFor(() => { expect(cancel).toHaveBeenCalled(); });
    const s2 = await setup(), cancel2 = vi.fn();
    s2.fetcher.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ cancel: cancel2 }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }));
    const stalled = s2.executor.query(query()); await vi.waitFor(() => { expect(s2.fetcher).toHaveBeenCalled(); }); s2.handle.cancel();
    await expect(stalled).rejects.toMatchObject({ name: "AbortError" }); expect(cancel2).toHaveBeenCalled();
  });
  it("checks evidence before reading records", async () => {
    const s = await setup(), access = vi.fn(() => { throw new Error("records accessed"); });
    const raw = { complete: true, ...s.metadata }; Object.defineProperty(raw, "records", { enumerable: true, get: access });
    Object.assign(s.metadata.providerReads?.execution ?? {}, { id: "changed" });
    vi.spyOn(JSON, "parse").mockReturnValueOnce(raw);
    await expect(s.executor.query(query())).rejects.toThrow(); expect(access).not.toHaveBeenCalled();
  });
});
describe("absolute owner execution budget", () => {
  it("generates fresh IDs and rejects counterfeit or cancelled budget views", () => {
    expect(new Set(Array.from({ length: 3 }, () => createOpenVaultDbExecutionId(owner().budget))).size).toBe(3);
    const h = owner(); expect(Object.isFrozen(h.budget)).toBe(true);
    expect(() => { assertOpenVaultDbExecutionBudget({ ...h.budget }); }).toThrow("unbound"); h.cancel(); expect(() => { assertOpenVaultDbExecutionBudget(h.budget); }).toThrow("cancelled");
  });
  it("consumes admission time and refuses deadline crossing before delayed timers run", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now); const h = owner(), f = await fixture(createOpenVaultDbExecutionId(h.budget));
    now = 9000; await validateOpenVaultDbDTQLPlan(f.config, f.plan, h.budget);
    const fetcher = vi.fn<typeof fetch>(() => { now = 10001; return Promise.resolve(response(f.metadata)); });
    const executor = new OpenVaultDbDTQLQueryExecutor({ ...f.config, providerReadPlan: f.plan, budget: h.budget, fetch: fetcher });
    await expect(executor.query(query())).rejects.toMatchObject({ name: "TimeoutError" });
    expect(h.budget.signal.aborted).toBe(false);
  });
  it("keeps the owner alive after adapter return for evidence and guarded detached render handoff", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now); const h = owner(), f = await fixture(createOpenVaultDbExecutionId(h.budget));
    const executor = new OpenVaultDbDTQLQueryExecutor({ ...f.config, providerReadPlan: f.plan, budget: h.budget, fetch: () => Promise.resolve(response(f.metadata)) });
    const page = await executor.query(query()); expect(h.budget.signal.aborted).toBe(false);
    now = 10001; await expect(validateOpenVaultDbDTQLEvidence(page, f.plan, h.budget)).rejects.toMatchObject({ name: "TimeoutError" });
    const commit = vi.fn(); expect(() => { assertOpenVaultDbExecutionBudget(h.budget); commit(page); }).toThrow(); expect(commit).not.toHaveBeenCalled();
    h.dispose(); expect(h.budget.signal.aborted).toBe(true);
  });
  it("races hung operations at remaining time and cleans waiter listeners", async () => {
    vi.useFakeTimers(); const h = owner(); const pending = raceOpenVaultDbExecutionBudget(h.budget, new Promise<never>(() => undefined));
    const caught = pending.catch((e: unknown) => e); await vi.advanceTimersByTimeAsync(10000);
    expect(await caught).toMatchObject({ name: "TimeoutError" }); h.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
});
