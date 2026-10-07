import {
  Key, UnsupportedError, collection, executeSourceComposedJoinedDTQLQuery,
  type QueryExecutor, type QueryPage, type StructuredQuery,
} from "@dalgo/core";
import { describe, expect, it, vi } from "vitest";
import { ImmutableDescriptors, descriptors, joinedQuery, joinOptions, materialize,
  syntheticExecutor, syntheticPlan, syntheticXML, unsupportedSink, viewSnapshot } from "./browser-fixture.js";
import { parser } from "./fixture.js";

async function fixture(text = syntheticXML) {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(text, { headers: { "Content-Type": "text/xml" } })));
  return { ...await syntheticExecutor({ fetch: fetcher, parser: new parser() }), fetcher };
}

describe("exact immutable synthetic descriptor scan", () => {
  it("detaches nested literals and freezes returned records and rows", async () => {
    const input = structuredClone(descriptors);
    const executor = new ImmutableDescriptors(input);
    Object.assign(input[0]?.note ?? {}, { text: "changed" });
    Object.assign(input[0] ?? {}, { currency: "BBB" });
    const query = executor.admittedInput().scanQuery;
    const page = await executor.query(query);
    expect(page.records[0]?.data).toEqual(descriptors[0]);
    expect(page.records[0]?.key).toBeInstanceOf(Key);
    expect(Object.isFrozen(page.records)).toBe(true);
    expect(Object.isFrozen(page.records[0])).toBe(true);
    expect(Object.isFrozen(page.records[0]?.data)).toBe(true);
    expect(Object.isFrozen((page.records[0]?.data as typeof descriptors[number]).note)).toBe(true);
    expect(() => Object.assign(page.records[0]?.data ?? {}, { name: "changed" })).toThrow();
    expect(page).not.toHaveProperty("nextCursor");
    expect(page).not.toHaveProperty("sourceRights");
  });
  it("keeps a positive exact limit on empty arrays", async () => {
    const executor = new ImmutableDescriptors([]);
    expect(executor.admittedInput().scope).toMatchObject({ requestedLimit: 1, maxRows: 0 });
    expect(await executor.query(executor.admittedInput().scanQuery)).toEqual({ records: [] });
  });
  it("rejects a smaller positive limit and never revisits detached row getters", () => {
    const name = vi.fn(() => "Invented Alpha");
    const executor = new ImmutableDescriptors([
      { currency: "AAA", get name() { return name(); }, note: { text: "unknown" } },
      { currency: "ZZZ", name: "Invented Omega", note: { text: "unknown" } },
    ]);
    expect(name).toHaveBeenCalledTimes(1); // construction captures and removes accessors
    expect(() => executor.query({ ...executor.admittedInput().scanQuery, limit: 1 })).toThrow(UnsupportedError);
    expect(name).toHaveBeenCalledTimes(1);
  });
  it("rejects every unadmitted query shape without returning any records", () => {
    const executor = new ImmutableDescriptors(descriptors);
    const scan = executor.admittedInput().scanQuery;
    const invalid: StructuredQuery<Record<string, unknown>>[] = [
      { ...scan, source: { kind: "collection-group", name: "descriptors" } },
      { ...scan, source: { kind: "collection", name: "other" } },
      { ...scan, source: { ...scan.source, parent: new Key("parent", "1") } },
      { ...scan, source: { ...scan.source, codec: { decode: vi.fn(), encode: vi.fn() } } },
      { ...scan, filters: [{ field: "currency", operator: "==", value: "AAA" }] },
      { ...scan, orders: [{ field: "currency", direction: "asc" }] },
      { ...scan, offset: 1 }, { ...scan, limit: 0 }, { ...scan, limit: 2 },
      ...["startAt", "startAfter", "endAt", "endBefore"].map((name) => ({ ...scan, [name]: { values: ["AAA"] } })),
    ];
    const noLimit = { ...scan }; delete (noLimit as { limit?: number }).limit;
    invalid.push(noLimit);
    for (const query of invalid) expect(() => executor.query(query)).toThrow(UnsupportedError);
    expect(() => executor.query({ ...scan, offset: 0 })).not.toThrow();
  });
});

describe("actual ECB executor with materialized source composition", () => {
  it("joins native strings and retains original GET evidence and unknown local status", async () => {
    const { executor, plan, fetcher } = await fixture();
    const page = await materialize(executor, plan);
    const view = viewSnapshot(page);
    expect(view.rows).toEqual([{ currency: "AAA", time: "2037-02-03", rate: "001.23000", name: "Invented Alpha" }]);
    expect(view.notices.map((notice) => notice.rightsStatus)).toEqual(["provided", "unknown"]);
    expect(view.metadata.sourceComposition?.inputs[0]?.metadata).toMatchObject({ sourceRights: plan.sourceRights,
      providerReads: { execution: plan.execution, bindings: plan.bindings,
        reads: [{ status: 200, referenceDate: "2037-02-03", bytes: new TextEncoder().encode(syntheticXML).length }] } });
    expect(view.metadata.sourceComposition?.inputs[1]?.metadata).toEqual({});
    expect(page).not.toHaveProperty("providerReads");
    expect(page.records[0]?.key).toBeInstanceOf(Key);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["projected", "empty-local", "where", "left"] as const)("retains both dependencies for %s", async (kind) => {
    const { executor, plan } = await fixture();
    const page = await materialize(executor, plan, kind === "empty-local" ? [] : descriptors,
      joinedQuery(kind === "left" ? "left" : "inner", kind === "projected", kind === "where"));
    const view = viewSnapshot(page);
    expect(view.notices).toHaveLength(2);
    expect(view.notices[0]?.declarations).toEqual(["Fabricated permission\n preserve whitespace"]);
    expect(view.notices[1]?.rightsStatus).toBe("unknown");
    expect(view.metadata.sourceComposition?.inputs[0]?.metadata.providerReads?.reads).toHaveLength(1);
    if (kind === "empty-local" || kind === "where") expect(view.rows).toEqual([]);
    if (kind === "projected") expect(view.rows).toEqual([{ name: "Invented Alpha" }]);
    if (kind === "left") expect(view.rows).toContainEqual({ currency: "ZZZ", time: "2037-02-03", rate: "0.00001", name: null });
  });
  it("captures mutable admissions before I/O and validates all later inputs first", async () => {
    const { executor, plan, fetcher } = await fixture();
    const pending = materialize(executor, plan);
    Object.assign(plan.sourceRights[0]?.declaration ?? {}, { text: "changed" });
    expect(viewSnapshot(await pending).notices[0]?.declarations[0]).toBe("Fabricated permission\n preserve whitespace");
    const options = joinOptions(executor, await syntheticPlan(), new ImmutableDescriptors(descriptors));
    const resolved = options.resolveInput;
    await expect(executeSourceComposedJoinedDTQLQuery(joinedQuery(), { ...options, resolveInput: (relation, path) => {
      const input = resolved(relation, path);
      return relation.name === "descriptors" ? { ...input, scanQuery: { ...input.scanQuery, limit: 2 } } : input;
    } })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["missing", "changed"])("refuses %s evidence before record getters", async (kind) => {
    const { executor, plan } = await fixture();
    const records = vi.fn(() => { throw new Error("records must not be read"); });
    const broken: QueryExecutor = { query: async <T>(query: StructuredQuery<T>): Promise<QueryPage<T>> => {
      const original = await executor.query(query);
      const providerReads = structuredClone(original.providerReads);
      if (providerReads === undefined) throw new Error("fixture must contain original evidence");
      Object.assign(providerReads.reads[0] ?? {}, { sha256: "f".repeat(64) });
      return { sourceRights: original.sourceRights ?? [], usedSourceIds: original.usedSourceIds ?? [],
        ...(kind === "changed" ? { providerReads } : {}), get records() { return records(); } };
    } };
    await expect(materialize(broken, plan)).rejects.toThrow();
    expect(records).not.toHaveBeenCalled();
  });
  it("refuses mismatched rights and invalid later preflight before Fetch", async () => {
    const { executor, plan, fetcher } = await fixture();
    Object.assign(plan.sourceRights[0]?.declaration ?? {}, { text: "changed" });
    await expect(materialize(executor, plan)).rejects.toThrow("rights digest");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses malformed XML and fetched/result/metadata/retained bounds", async () => {
    const bad = await fixture("<bad");
    await expect(materialize(bad.executor, bad.plan)).rejects.toThrow();
    const { executor, plan } = await fixture();
    const options = joinOptions(executor, plan, new ImmutableDescriptors(descriptors));
    for (const override of [{ maxFetchedRows: 1 }, { maxResultRows: 1 }, { maxMetadataBytes: 1 }, { maxRetainedBytes: 1 }]) {
      await expect(executeSourceComposedJoinedDTQLQuery(joinedQuery("left"), { ...options, ...override })).rejects.toThrow();
    }
  });
  it("direct filtered empty ECB pages retain fresh leaf evidence", async () => {
    const { executor } = await fixture();
    const page = await executor.query(collection("daily").query().where("currency", "==", "BBB").build());
    expect(page.records).toEqual([]);
    expect(page.providerReads?.reads).toHaveLength(1);
  });
  it.each([null, undefined, {}, { format: "bogus" }])("raw unsupported sink refuses %j before rows/dispatch", (composition) => {
    const records = vi.fn(() => { throw new Error("row access"); });
    const dispatch = vi.fn();
    const page = { sourceComposition: composition, get records() { return records(); } };
    expect(() => { unsupportedSink(page, dispatch); }).toThrow(UnsupportedError);
    expect(dispatch).not.toHaveBeenCalled(); expect(records).not.toHaveBeenCalled();
    expect(() => viewSnapshot(page as unknown as QueryPage<Record<string, unknown>>)).toThrow();
    expect(records).not.toHaveBeenCalled();
  });
});
