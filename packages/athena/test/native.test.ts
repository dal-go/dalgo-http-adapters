import { afterEach, describe, expect, it, vi } from "vitest";
import { Key } from "@dalgo/core";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { AthenaNativeClient } from "../src/client.js";
import { AthenaDatabase } from "../src/database.js";
import type { AthenaOptions } from "../src/types.js";
import { Fixture, info, json, query, result, source } from "./fixture.js";
const client = (fixture: Fixture, limits: Partial<AthenaOptions> = {}) => new AthenaNativeClient({ source, transport: fixture, pollIntervalMs: 0, ...limits });
afterEach(() => { vi.restoreAllMocks(); });
describe("native same-query pages", () => {
  it("preserves exact native values, NULL/empty and original metadata without numeric coercion", async () => {
    const f = new Fixture(); f.pages = [result([["a", "9007199254740993.0001", ""], ["b", null, null]], undefined, true)];
    const c = client(f); const page = await c.queryPage(query());
    expect(page.rows).toEqual([["a", "9007199254740993.0001", ""], ["b", null, null]]);
    expect(page.columns[1]).toMatchObject({ type: "decimal", precision: 38, scale: 10 });
    expect(page.receipt.dataScannedBytes).toBe("9007199254740993"); expect(page.hasMore).toBe(false); c.close();
  });
  it("retains data equal to headers and pads omitted trailing cells with NULL", async () => {
    const f = new Fixture(); f.pages = [{ ResultSet: { ResultSetMetadata: { ColumnInfo: info.map(column => ({ ...column, Type: "varchar" })) }, Rows: [
      { Data: [{ VarCharValue: "id" }, { VarCharValue: "amount" }, { VarCharValue: "note" }] },
      { Data: [{ VarCharValue: "id" }, { VarCharValue: "amount" }, { VarCharValue: "note" }] }, { Data: [{ VarCharValue: "tail" }] }
    ] } }];
    const c = client(f, { source: { ...source, tables: { items: { table: "actual", columns: { id: "varchar", amount: "varchar", note: "varchar" } } } } }); expect((await c.queryPage(query())).rows).toEqual([["id", "amount", "note"], ["tail", null, null]]); c.close();
  });
  it("retains empty nonterminal and header-only pages, legitimate duplicate rows and contiguous ordinals", async () => {
    const f = new Fixture(); f.pages = [result([], "p1", true), result([], "p2"), result([["a", "1", null]], "p3"), result([["a", "1", null]])];
    const c = client(f); let page = await c.queryPage(query(2), { pageSize: 1 }); const rows: unknown[] = [], ordinals = [page.ordinalStart];
    while (page.nextCursor !== undefined) { rows.push(...page.rows); page = await c.nextPage(page.nextCursor); ordinals.push(page.ordinalStart); } rows.push(...page.rows);
    expect(rows).toEqual([["a", "1", null], ["a", "1", null]]); expect(ordinals).toEqual([0, 0, 0, 1]); expect(page.receipt.counters.rows).toBe(2);
    expect(f.calls.filter(v => v.action === "StartQueryExecution")).toHaveLength(1);
    expect(f.calls.find(v => v.action === "StartQueryExecution")?.input.QueryString).toContain(" OFFSET 2 LIMIT ");
    expect(f.calls.filter(v => v.action === "GetQueryResults").every(v => v.input.QueryExecutionId === "query-1" && v.input.MaxResults === 1)).toBe(true); c.close();
  });
  it("preserves old authority and pending page on failed factory, without refetch or mutable aliases", async () => {
    const f = new Fixture(); f.pages = [result([], "p1", true), result([["a", "1", null]])]; const c = client(f);
    const first = await c.queryPage(query(), { pageSize: 1 }); const cursor = first.nextCursor; if (cursor === undefined) throw new Error("cursor");
    await expect(c.mapNextPage(cursor, undefined, page => { (page.rows[0] as (string | null)[])[0] = "mutated-copy"; throw new Error("PRIVATE_SECRET"); })).rejects.toMatchObject({ code: "transport" });
    const page = await c.nextPage(cursor); expect(page.rows).toEqual([["a", "1", null]]); expect(page.ordinalStart).toBe(0); expect(f.calls.filter(v => v.action === "GetQueryResults")).toHaveLength(2);
    await expect(c.nextPage(cursor)).rejects.toMatchObject({ code: "cursor" }); c.close();
  });
  it("admits long-token empty successors before factories and replays the same staged page after failure", async () => {
    const f = new Fixture(), a = "A".repeat(1024), b = "B".repeat(1024);
    f.override = event => {
      if (event.action !== "GetQueryResults") return undefined;
      if (event.input.NextToken === undefined) return json(result([], a, true));
      if (event.input.NextToken === a) return json(result([], b));
      if (event.input.NextToken === b) return json(result([["a", "1", null]]));
      throw new Error("unexpected owned token");
    };
    const c = client(f); const first = await c.queryPage(query());
    const cursor = first.nextCursor; if (cursor === undefined) throw new Error("cursor"); let factories = 0;
    await expect(c.mapNextPage(cursor, undefined, page => { factories++; expect(page.rows).toEqual([]); throw new Error("PRIVATE_FACTORY"); })).rejects.toMatchObject({ code: "transport" });
    const second = await c.mapNextPage(cursor, undefined, page => { factories++; return page; });
    expect(second.rows).toEqual([]); expect(second.ordinalStart).toBe(0); expect(factories).toBe(2);
    expect(f.calls.filter(event => event.action === "GetQueryResults")).toHaveLength(2);
    if (second.nextCursor === undefined) throw new Error("cursor"); const last = await c.nextPage(second.nextCursor);
    expect(last.rows).toEqual([["a", "1", null]]); expect(last.ordinalStart).toBe(0); expect(last.hasMore).toBe(false);
    expect(f.calls.filter(event => event.action === "GetQueryResults")).toHaveLength(3); c.close();
  });
  it("binds cursors to the original client and principal without destroying retry authority", async () => {
    const f = new Fixture(); f.pages = [result([], "p1", true), result([["a", "1", null]])]; const c = client(f), other = client(f);
    const first = await c.queryPage(query()); const cursor = first.nextCursor; if (cursor === undefined) throw new Error("cursor");
    await expect(other.nextPage(cursor)).rejects.toMatchObject({ code: "cursor" }); f.identity = { principal: "other", generation: "one" };
    await expect(c.nextPage(cursor)).rejects.toMatchObject({ code: "permission" }); f.identity = { principal: "owned-reader", generation: "one" };
    expect((await c.nextPage(cursor)).rows).toHaveLength(1); c.close(); other.close();
  });
  it("refuses repeated tokens and metadata drift before consuming the input cursor", async () => {
    const f = new Fixture(); f.pages = [result([], "p1", true), result([["a", "1", null]], "p1")]; const c = client(f);
    const first = await c.queryPage(query()); const cursor = first.nextCursor; if (cursor === undefined) throw new Error("cursor");
    await expect(c.nextPage(cursor)).rejects.toMatchObject({ code: "protocol" });
    f.pages[1] = { ResultSet: { ResultSetMetadata: { ColumnInfo: [...info].reverse() }, Rows: [] } };
    await expect(c.nextPage(cursor)).rejects.toMatchObject({ code: "protocol" });
    f.pages[1] = result([["a", "1", null]]); expect((await c.nextPage(cursor)).rows).toHaveLength(1); c.close();
  });
  it("accepts RUNNING to QUEUED but never resubmits terminal FAILED", async () => {
    const f = new Fixture(); f.states = ["QUEUED", "RUNNING", "QUEUED", "SUCCEEDED"]; const c = client(f); await c.queryPage(query());
    expect(f.calls.filter(v => v.action === "GetQueryExecution")).toHaveLength(4); c.close();
    const failed = new Fixture(); failed.states = ["FAILED"]; const d = client(failed); await expect(d.queryPage(query())).rejects.toMatchObject({ code: "transport" });
    expect(failed.calls.filter(v => v.action === "StartQueryExecution")).toHaveLength(1); expect(failed.calls.filter(v => v.action === "StopQueryExecution")).toHaveLength(0); d.close();
  });
  it("refuses over-return and row overflow instead of successful client truncation", async () => {
    const f = new Fixture(); f.pages = [result([["a", "1", null], ["b", "2", null]], undefined, true)]; const c = client(f);
    await expect(c.queryPage(query(), { pageSize: 1 })).rejects.toMatchObject({ code: "protocol" }); c.close();
    const d = client(f, { maxRows: 1 }); await expect(d.queryPage(query())).rejects.toMatchObject({ code: "bounds" }); d.close();
  });
  it("refuses an explicit semantic LIMIT over-return before any response factory or ACK", async () => {
    const f = new Fixture(); f.pages = [result([["a", "1", null], ["b", "2", null]], undefined, true)];
    const c = client(f); let factories = 0;
    await expect(c.mapQueryPage({ ...query(), limit: 1 }, { pageSize: 100 }, () => { factories++; return "forbidden"; })).rejects.toMatchObject({ code: "bounds" });
    expect(factories).toBe(0); expect(f.calls.filter(v => v.action === "StartQueryExecution")).toHaveLength(1); c.close();
  });
  it("enforces semantic LIMIT across pages and preserves the earlier prefix and retry handle", async () => {
    const f = new Fixture(); f.pages = [result([["a", "1", null]], "p1", true), result([["b", "2", null]])];
    const c = client(f); const first = await c.queryPage({ ...query(), limit: 1 });
    expect(first.rows).toEqual([["a", "1", null]]); expect(first.receipt.complete).toBe(false);
    const cursor = first.nextCursor; if (cursor === undefined) throw new Error("cursor"); let factories = 0;
    await expect(c.mapNextPage(cursor, undefined, () => { factories++; return "forbidden"; })).rejects.toMatchObject({ code: "bounds" });
    expect(factories).toBe(0); expect(first.rows).toEqual([["a", "1", null]]);
    f.pages[1] = result([]); const last = await c.nextPage(cursor);
    expect(last.rows).toEqual([]); expect(last.ordinalStart).toBe(1); expect(last.receipt.counters.rows).toBe(1);
    expect(last.receipt.counters.fetchedRows).toBe(2); expect(last.hasMore).toBe(false); c.close();
  });
  it("keeps per-query semantic limits separate from the aggregate core batch row budget", async () => {
    const f = new Fixture(), c = client(f, { maxRows: 2 });
    const rows = await c.mapQueries(() => [{ ...query(), limit: 1 }, { ...query(), limit: 1 }], pages => pages.map(page => page.rows));
    expect(rows).toEqual([[["a", "9007199254740993.0001", ""]], [["a", "9007199254740993.0001", ""]]]); c.close();
  });
  it("keeps an earlier ACKed prefix explicitly incomplete when a later row budget fails", async () => {
    const f = new Fixture(); f.pages = [result([["a", "1", null]], "p1", true), result([["b", "2", null]])]; const c = client(f, { maxRows: 1 });
    const first = await c.queryPage(query()); expect(first.receipt.complete).toBe(false); if (first.nextCursor === undefined) throw new Error("cursor");
    await expect(c.nextPage(first.nextCursor)).rejects.toMatchObject({ code: "bounds" }); expect(first.rows).toEqual([["a", "1", null]]); c.close();
  });
  it("distinguishes absent VarCharValue, explicit null, empty string and literal null text", async () => {
    const f = new Fixture();
    f.pages = [{
      ResultSet: {
        ResultSetMetadata: { ColumnInfo: info },
        Rows: [
          { Data: [{ VarCharValue: "id" }, { VarCharValue: "amount" }, { VarCharValue: "note" }] },
          { Data: [{ VarCharValue: "absent" }, { VarCharValue: "1.0000000000" }, {}] },
          { Data: [{ VarCharValue: "explicit-null" }, { VarCharValue: "2.0000000000" }, { VarCharValue: null }] },
          { Data: [{ VarCharValue: "empty-text" }, { VarCharValue: "3.0000000000" }, { VarCharValue: "" }] },
          { Data: [{ VarCharValue: "literal-null" }, { VarCharValue: "4.0000000000" }, { VarCharValue: "null" }] },
          { Data: [{}, {}, {}] },
          { Data: [{ VarCharValue: null }, { VarCharValue: null }, { VarCharValue: null }] }
        ]
      }
    }];
    const c = client(f);
    const page = await c.queryPage(query());
    expect(page.rows).toEqual([
      ["absent", "1.0000000000", null],
      ["explicit-null", "2.0000000000", null],
      ["empty-text", "3.0000000000", ""],
      ["literal-null", "4.0000000000", "null"],
      [null, null, null],
      [null, null, null]
    ]);
    if (page.rows[0] === undefined || page.rows[1] === undefined || page.rows[2] === undefined || page.rows[3] === undefined) throw new Error("rows");
    expect(page.rows[0]?.[2]).toBeNull();
    expect(page.rows[1]?.[2]).toBeNull();
    expect(page.rows[2]?.[2]).toBe("");
    expect(page.rows[3]?.[2]).toBe("null");
    expect(page.rows[2]?.[2]).not.toBe(page.rows[1]?.[2]);
    expect(page.rows[3]?.[2]).not.toBe(page.rows[1]?.[2]);
    expect(page.rows[2]?.[2]).not.toBe(page.rows[3]?.[2]);
    expect(page.rows[4]).toEqual(page.rows[5]);
    c.close();
  });
  it.each([
    ["number", 123],
    ["boolean", true],
    ["object", {}],
    ["array", ["nested"]]
  ])("refuses whole page on malformed VarCharValue %s", async (_, bad) => {
    const f = new Fixture();
    f.pages = [{
      ResultSet: {
        ResultSetMetadata: { ColumnInfo: info },
        Rows: [
          { Data: [{ VarCharValue: "id" }, { VarCharValue: "amount" }, { VarCharValue: "note" }] },
          { Data: [{ VarCharValue: "a" }, { VarCharValue: "1.0000000000" }, { VarCharValue: "valid" }] },
          { Data: [{ VarCharValue: "b" }, { VarCharValue: "2.0000000000" }, { VarCharValue: bad }] }
        ]
      }
    }];
    const c = client(f);
    await expect(c.queryPage(query())).rejects.toMatchObject({ code: "protocol" });
    c.close();
  });
  it("refuses malformed VarCharValue on successor page while keeping earlier acknowledged rows and cursor accounting intact", async () => {
    const f = new Fixture();
    f.pages = [
      result([["a", "1.0000000000", "first"]], "p1", true),
      {
        ResultSet: {
          ResultSetMetadata: { ColumnInfo: info },
          Rows: [
            { Data: [{ VarCharValue: "b" }, { VarCharValue: 123 }, { VarCharValue: "malformed" }] }
          ]
        },
        NextToken: "p2"
      }
    ];
    const c = client(f);
    const first = await c.queryPage(query(), { pageSize: 2 });
    expect(first.rows).toEqual([["a", "1.0000000000", "first"]]);
    expect(first.ordinalStart).toBe(0);
    expect(first.receipt.complete).toBe(false);
    expect(first.receipt.counters.rows).toBe(1);
    expect(first.receipt.counters.fetchedRows).toBe(1);
    const cursor = first.nextCursor;
    if (cursor === undefined) throw new Error("cursor");

    // Successor page with number VarCharValue rejects whole page
    await expect(c.nextPage(cursor)).rejects.toMatchObject({ code: "protocol" });

    // Successor page with boolean VarCharValue also rejects whole page
    f.pages[1] = {
      ResultSet: {
        ResultSetMetadata: { ColumnInfo: info },
        Rows: [{ Data: [{ VarCharValue: "b" }, { VarCharValue: "2.0000000000" }, { VarCharValue: true }] }]
      },
      NextToken: "p2"
    };
    await expect(c.nextPage(cursor)).rejects.toMatchObject({ code: "protocol" });

    // Successor page with object VarCharValue also rejects whole page
    f.pages[1] = {
      ResultSet: {
        ResultSetMetadata: { ColumnInfo: info },
        Rows: [{ Data: [{ VarCharValue: "b" }, { VarCharValue: "2.0000000000" }, { VarCharValue: {} }] }]
      },
      NextToken: "p2"
    };
    await expect(c.nextPage(cursor)).rejects.toMatchObject({ code: "protocol" });

    // Earlier acknowledged rows and receipt counters remain intact throughout
    expect(first.rows).toEqual([["a", "1.0000000000", "first"]]);
    expect(first.receipt.counters.rows).toBe(1);

    // Cursor accounting is intact; retrying with valid explicit null / empty text succeeds
    f.pages[1] = {
      ResultSet: {
        ResultSetMetadata: { ColumnInfo: info },
        Rows: [{ Data: [{ VarCharValue: "b" }, { VarCharValue: "2.0000000000" }, { VarCharValue: null }] }]
      }
    };
    const second = await c.nextPage(cursor);
    expect(second.rows).toEqual([["b", "2.0000000000", null]]);
    expect(second.ordinalStart).toBe(1);
    expect(second.receipt.counters.rows).toBe(2);
    expect(second.receipt.counters.fetchedRows).toBe(2);
    expect(second.hasMore).toBe(false);
    expect(second.receipt.complete).toBe(true);
    c.close();
  });
  it("refuses explicit null in header row to preserve header validation", async () => {
    const f = new Fixture();
    f.pages = [{
      ResultSet: {
        ResultSetMetadata: { ColumnInfo: info },
        Rows: [
          { Data: [{ VarCharValue: null }, { VarCharValue: "amount" }, { VarCharValue: "note" }] },
          { Data: [{ VarCharValue: "1" }, { VarCharValue: "10.0000000000" }, { VarCharValue: "note" }] }
        ]
      }
    }];
    const c = client(f);
    await expect(c.queryPage(query())).rejects.toMatchObject({ code: "protocol" });
    c.close();
  });
});
describe("closed compiler and authority", () => {
  it.each([-1, 0.5, 100001, Number.MAX_SAFE_INTEGER + 1])("refuses invalid OFFSET %s before credentials", async value => {
    const f = new Fixture(), c = client(f); await expect(c.queryPage(query(), { offset: value })).rejects.toMatchObject({ code: "input" });
    expect(f.auth).toBe(0); expect(f.calls).toHaveLength(0); c.close();
  });
  it("uses ordered execution parameters and exact string/numeric quoting", async () => {
    const f = new Fixture(), c = client(f);
    await c.queryPage({ ...query(7), filters: [{ field: "id", operator: "==", value: "O'Reilly" }, { field: "amount", operator: ">=", value: "9007199254740993.0001" }] });
    const submit = f.calls.find(v => v.action === "StartQueryExecution")?.input;
    expect(submit?.ExecutionParameters).toEqual(["'O''Reilly'", "9007199254740993.0001"]);
    expect(submit?.QueryString).toContain('"id" = ? AND "amount" >= ? ORDER BY "id" ASC OFFSET 7 LIMIT ');
    expect(String(submit?.ClientRequestToken).length).toBeGreaterThanOrEqual(32); c.close();
  });
  it("does not reuse tokens or retry an unknown submission", async () => {
    const f = new Fixture(), c = client(f); await c.queryPage(query()); await c.queryPage(query());
    expect(new Set(f.calls.filter(v => v.action === "StartQueryExecution").map(v => v.input.ClientRequestToken)).size).toBe(2); c.close();
    const lost = new Fixture(); lost.override = e => e.action === "StartQueryExecution" ? Promise.reject(new Error("PRIVATE")) : undefined; const d = client(lost);
    await expect(d.queryPage(query())).rejects.toMatchObject({ code: "transport" }); expect(lost.calls.filter(v => v.action === "StartQueryExecution")).toHaveLength(1); d.close();
  });
  it("refuses getters and aggregate escaped parameter overflow with zero auth/IO", async () => {
    const f = new Fixture(), c = client(f); let getters = 0; const filter = { field: "id", operator: "==" as const, get value() { getters++; return "PRIVATE"; } };
    await expect(c.queryPage({ ...query(), filters: [filter] })).rejects.toMatchObject({ code: "input" }); expect(getters).toBe(0);
    await expect(c.queryPage({ ...query(), filters: [{ field: "id", operator: "in", value: Array(64).fill("\n".repeat(800)) }] })).rejects.toBeInstanceOf(Error);
    expect(f.auth).toBe(0); expect(f.calls).toHaveLength(0); c.close();
  });
  it("requires enforced compatible workgroup policy, without changing any settings", async () => {
    const f = new Fixture(); f.override = e => e.action === "GetWorkGroup" ? json({ WorkGroup: { Name: source.workGroup, State: "ENABLED", Configuration: { EnforceWorkGroupConfiguration: false } } }) : undefined;
    const c = client(f); await expect(c.queryPage(query())).rejects.toMatchObject({ code: "permission" }); expect(f.calls.map(v => v.action)).toEqual(["GetWorkGroup"]); c.close();
  });
  it("refuses changed execution identity and requests at most one owned cancel", async () => {
    const f = new Fixture(); f.override = e => e.action === "GetQueryExecution" ? json({ QueryExecution: { QueryExecutionId: "foreign", QueryExecutionContext: { Catalog: source.catalog, Database: source.database } } }) : undefined;
    const c = client(f); await expect(c.queryPage(query())).rejects.toMatchObject({ code: "protocol" }); await new Promise(resolve => setImmediate(resolve));
    expect(f.calls.filter(v => v.action === "StopQueryExecution")).toHaveLength(1); expect(f.calls.find(v => v.action === "StopQueryExecution")?.input).toEqual({ QueryExecutionId: "query-1" }); c.close();
  });
});
describe("configured native-key facade", () => {
  it("preserves duplicate/missing batch positions and reports an actual zero-row query as absent", async () => {
    const f = new Fixture(); let missing = false;
    f.override = event => {
      if (event.action === "StartQueryExecution") { missing = JSON.stringify(event.input.ExecutionParameters).includes("missing"); return undefined; }
      return event.action === "GetQueryResults" && missing ? json(result([], undefined, true)) : undefined;
    };
    const c = client(f), db = new AthenaDatabase(c);
    try {
      const values = await db.getMany([new Key("items", "a"), new Key("items", "missing"), new Key("items", "a")]);
      expect(values.map(value => value.exists)).toEqual([true, false, true]); expect(values.map(value => value.key.id)).toEqual(["a", "missing", "a"]);
      expect(values[0]?.data).not.toBe(values[2]?.data); expect(await db.exists(new Key("items", "missing"))).toBe(false);
    } finally { db.close(); }
  });
  it("captures all keys before callbacks, preserving duplicate order and exact map numbers", async () => {
    const f = new Fixture(), c = client(f), db = new AthenaDatabase(c); const keys: Key[] = [new Key("items", "a"), new Key("items", "a")];
    const codec = { encode: (v: unknown) => v, decode: (v: unknown) => { keys[1] = new Key("items", "changed"); return v; } };
    const values = await db.getMany(keys, codec); expect(values.map(v => v.key.id)).toEqual(["a", "a"]);
    expect(values[0]?.data).toMatchObject({ amount: "9007199254740993.0001" }); expect(values[0]?.data).not.toBe(values[1]?.data); db.close();
  });
  it("refuses duplicate configured keys, final codec cancellation and writes", async () => {
    const f = new Fixture(); f.pages = [result([["a", "1", null], ["a", "2", null]], undefined, true)]; const c = client(f), db = new AthenaDatabase(c);
    await expect(db.get(new Key("items", "a"))).rejects.toMatchObject({ code: "protocol" }); f.pages = [result([["a", "1", null]], undefined, true)];
    const controller = new AbortController(); await expect(db.getWithSignal(new Key("items", "a"), controller.signal, { encode: v => v, decode: v => { controller.abort(new Error("PRIVATE")); return v; } })).rejects.toBeInstanceOf(QueryCancelledError);
    let called = false; await expect(db.runReadwriteTransaction(async () => { called = true; })).rejects.toBeInstanceOf(Error); expect(called).toBe(false); db.close();
  });
});
