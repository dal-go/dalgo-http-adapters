import { collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";
import { KustoDatabase, KustoHttpError, KustoRequestError } from "../src/index.js";

function result(rows: unknown[][], columns = ["__dalgo_key", "title"]): Response {
  return new Response(JSON.stringify([{ FrameType: "DataSetHeader" }, { FrameType: "DataTable", TableId: 0, TableKind: "PrimaryResult", Columns: columns.map((ColumnName) => ({ ColumnName, ColumnType: "string" })), Rows: rows }, { FrameType: "DataSetCompletion", HasErrors: false, Cancelled: false }]), { status: 200 });
}
function database(fetch = vi.fn<typeof globalThis.fetch>(), options: Partial<ConstructorParameters<typeof KustoDatabase>[0]> = {}) { return { fetch, db: new KustoDatabase({ clusterUrl: "https://example.kusto.windows.net", database: "Logs", accessToken: () => "short-lived-token", fetch, tables: { items: { table: "Items", keyColumn: "Id", columns: { title: "Title" } } }, ...options }) }; }

describe("KustoDatabase", () => {
  it("maps get through the v2 HTTPS query endpoint with typed parameter and readonly header", async () => {
    const { db, fetch } = database(); fetch.mockResolvedValueOnce(result([["milk", "Buy milk"]]));
    await expect(db.get(key("items", "milk"))).resolves.toEqual({ key: key("items", "milk"), exists: true, data: { title: "Buy milk" } });
    expect(fetch.mock.calls[0]?.[0].toString()).toBe("https://example.kusto.windows.net/v2/rest/query");
    const init = fetch.mock.calls[0]?.[1]; expect((init?.headers as Record<string, string>)["x-ms-readonly"]).toBe("true");
    expect(JSON.parse(init?.body as string)).toMatchObject({ db: "Logs", properties: { Parameters: { __dalgo_key: "milk" } } });
    expect(JSON.parse(init?.body as string).csl).toContain("declare query_parameters(__dalgo_key:string)");
  });
  it("executes caller KQL only with declared parameters and validates a scalar primary table", async () => {
    const { db, fetch } = database(); fetch.mockResolvedValueOnce(result([["a", "b"]], ["left", "right"]));
    await expect(db.queryKql("print left = x, right = y", { x: { type: "string", value: "a" }, y: { type: "string", value: "b" } })).resolves.toEqual([{ left: "a", right: "b" }]);
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).csl).toContain("declare query_parameters(x:string, y:string)");
    fetch.mockResolvedValueOnce(result([["true", "1.5"]], ["flag", "value"]));
    await db.queryKql("print flag = enabled, value = threshold", { enabled: { type: "bool", value: true }, threshold: { type: "real", value: 1.5 } });
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string).properties.Parameters).toEqual({ enabled: "bool(true)", threshold: "real(1.5)" });
    await expect(db.queryKql(".drop table Items")).rejects.toThrow("non-management");
  });
  it("supports bounded mapped collection queries and rejects semantic mismatches before transport", async () => {
    const { db, fetch } = database(); const items = collection<{ title: string }>("items"); fetch.mockResolvedValueOnce(result([["milk", "Buy"]]));
    await expect(db.query(items.query().limit(1).build())).resolves.toMatchObject({ records: [{ key: key("items", "milk"), data: { title: "Buy" } }] });
    await expect(db.query(items.query().where("title", "==", "Buy").build())).rejects.toThrow("filters");
    fetch.mockResolvedValueOnce(result([["milk", "Buy"], ["eggs", "Buy"]]));
    await expect(db.query(items.query().limit(1).build())).rejects.toThrow("continuation");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("retains maxRows capacity and fetches exactly one sentinel row", async () => {
    const items = collection<{ title: string }>("items");
    const one = database(undefined, { maxRows: 1 }); one.fetch.mockResolvedValueOnce(result([["milk", "Buy"]]));
    await expect(one.db.query(items.query().build())).resolves.toMatchObject({ records: [{ key: key("items", "milk") }] });
    expect(JSON.parse(one.fetch.mock.calls[0]?.[1]?.body as string).csl).toContain("take 2");
    const exact = database(undefined, { maxRows: 2 }); exact.fetch.mockResolvedValueOnce(result([["milk", "Buy"], ["eggs", "Buy"]]));
    await expect(exact.db.query(items.query().build())).resolves.toMatchObject({ records: [{ key: key("items", "milk") }, { key: key("items", "eggs") }] });
    expect(JSON.parse(exact.fetch.mock.calls[0]?.[1]?.body as string).csl).toContain("take 3");
    const overfull = database(undefined, { maxRows: 1 }); overfull.fetch.mockResolvedValueOnce(result([["milk", "Buy"], ["eggs", "Buy"]]));
    await expect(overfull.db.query(items.query().build())).rejects.toThrow("continuation");
  });
  it("redacts HTTP, token, malformed, and response completion failures", async () => {
    const { db, fetch } = database(); fetch.mockResolvedValueOnce(new Response("secret", { status: 500 })); await expect(db.get(key("items", "x"))).rejects.toEqual(new KustoHttpError(500));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify([{ FrameType: "DataSetHeader" }, { FrameType: "DataSetCompletion", HasErrors: true, Cancelled: false }]), { status: 200 })); await expect(db.get(key("items", "x"))).rejects.toEqual(new KustoRequestError());
    const unsafe = new KustoDatabase({ clusterUrl: "https://example.kusto.windows.net", database: "Logs", accessToken: () => { throw new Error("token secret"); }, tables: { items: { table: "Items", keyColumn: "Id", columns: {} } } }); await expect(unsafe.get(key("items", "x"))).rejects.toEqual(new KustoRequestError());
  });
});
