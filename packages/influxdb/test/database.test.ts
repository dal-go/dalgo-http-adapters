import { collection } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { InfluxDB3Database, type InfluxDB3DatabaseOptions } from "../src/index.js";

interface Call { readonly url: string; readonly init: RequestInit | undefined; }

function response(body: unknown, status = 200, headers: HeadersInit = { "content-type": "application/json" }): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const projection = ["__dalgo_key", "title", "done", "rank"];
const first = ["one", "Milk", false, 10];
const second = ["two", "Tea", false, 11];

function database(responses: readonly Response[], calls: Call[], overrides: Partial<InfluxDB3DatabaseOptions> = {}): InfluxDB3Database {
  return new InfluxDB3Database({
    database: "app_data",
    serverUrl: "https://influx.example.test",
    accessToken: () => "rotating-token",
    maxRows: 10,
    maxResponseBytes: 10000,
    maxWriteBytes: 10000,
    timeoutMs: 1000,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const next = responses[calls.length - 1];
      if (next === undefined) throw new Error("unexpected fetch");
      return next;
    },
    tables: {
      items: {
        table: "items",
        keyColumn: { column: "id", nullable: false },
        columns: {
          title: { column: "title" },
          done: { column: "done", nullable: false },
          rank: { column: "rank", nullable: false },
        },
      },
    },
    ...overrides,
  });
}

function rows(values: readonly (readonly unknown[])[]): unknown {
  return values.map((row) => Object.fromEntries(projection.map((name, index) => [name, row[index]])));
}

function envelope(values: readonly (readonly unknown[])[]): unknown {
  return { results: [{ series: [{ columns: projection, values }] }] };
}

describe("InfluxDB3Database", () => {
  it("uses native SQL POST with named WHERE parameters and returns a stable cursor", async () => {
    const calls: Call[] = [];
    const db = database([response(rows([first, second]))], calls);
    const items = collection<{ title: string; done: boolean; rank: number }>("items");
    const page = await db.query(items.query().where("done", "==", false).orderBy("rank").limit(1).build());

    expect(page.records).toEqual([{ key: items.key("one"), exists: true, data: { title: "Milk", done: false, rank: 10 } }]);
    expect(page.nextCursor).toEqual({ values: [10, "one"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://influx.example.test/api/v3/query_sql");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer rotating-token", "content-type": "application/json" });
    const body = JSON.parse(String(calls[0]?.init?.body)) as { db: string; q: string; params: Record<string, unknown>; format: string };
    expect(body).toMatchObject({ db: "app_data", format: "json", params: { p0: false } });
    expect(body.q).toContain('t."done" = $p0');
    expect(body.q).toContain('ORDER BY t."rank" ASC, t."id" ASC LIMIT 2');
  });

  it("supports point reads, missing snapshots, and bounded getMany", async () => {
    const calls: Call[] = [];
    const db = database([response(rows([first])), response({ results: [{}] }), response(rows([first])), response({ results: [{}] })], calls);
    const items = collection<{ title: string }>("items");
    await expect(db.get(items.key("one"))).resolves.toEqual({ key: items.key("one"), exists: true, data: { title: "Milk", done: false, rank: 10 } });
    await expect(db.get(items.key("none"))).resolves.toEqual({ key: items.key("none"), exists: false });
    await expect(db.getMany([items.key("one"), items.key("none")])).resolves.toEqual([
      { key: items.key("one"), exists: true, data: { title: "Milk", done: false, rank: 10 } },
      { key: items.key("none"), exists: false },
    ]);
  });

  it("rejects unsupported DALgo point mutation and transaction semantics before making a request", async () => {
    const calls: Call[] = [];
    const db = database([], calls);
    const items = collection<{ title: string }>("items");
    await expect(db.insert(items.key("one"), { title: "Milk" })).rejects.toThrow("insert semantics");
    await expect(db.set(items.key("one"), { title: "Milk" })).rejects.toThrow("replacement semantics");
    await expect(db.update(items.key("one"), { title: "Tea" })).rejects.toThrow("update semantics");
    await expect(db.delete(items.key("one"))).rejects.toThrow("delete semantics");
    await expect(db.runReadwriteTransaction(async () => "nope")).rejects.toThrow("callback transactions");
    expect(calls).toEqual([]);
  });

  it("appends bounded line protocol using the native write_lp endpoint", async () => {
    const calls: Call[] = [];
    const db = database([new Response(null, { status: 204 })], calls);
    await db.appendLineProtocol(["sensors,room=kitchen temp=21.5 1700000000"], "second");
    expect(calls[0]?.url).toBe("https://influx.example.test/api/v3/write_lp?db=app_data&precision=second");
    expect(calls[0]?.init).toMatchObject({ method: "POST", body: "sensors,room=kitchen temp=21.5 1700000000", redirect: "error" });
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer rotating-token", "content-type": "text/plain; charset=utf-8" });
    await expect(db.appendLineProtocol(["bad\nline"])).rejects.toThrow("without CR or LF");
  });

  it("validates mappings and response boundaries, and redacts HTTP response bodies", async () => {
    const calls: Call[] = [];
    const db = database([response({ secret: "must not surface" }, 403)], calls);
    const items = collection<{ title: string }>("items");
    await expect(db.get(items.key("one"))).rejects.toEqual(expect.objectContaining({ name: "InfluxDB3HttpError", status: 403 }));

    const badResponse = database([response([{ __dalgo_key: "one", title: "Milk", done: false, rank: 10, extra: "no" }])], []);
    await expect(badResponse.get(items.key("one"))).rejects.toThrow("projection");
    const missingField = database([response([{ __dalgo_key: "one", title: "Milk", done: false }])], []);
    await expect(missingField.get(items.key("one"))).rejects.toThrow("projection");

    const oversize = database([response(rows([first]), 200, { "content-length": "10001" })], []);
    await expect(oversize.get(items.key("one"))).rejects.toThrow("maxResponseBytes");
    const streamedOversize = database([new Response("x".repeat(10001), { status: 200, headers: { "content-type": "application/json" } })], []);
    await expect(streamedOversize.get(items.key("one"))).rejects.toThrow("maxResponseBytes");

    expect(() => database([], [], { serverUrl: "http://influx.example.test" })).toThrow("HTTPS");
    expect(() => database([], [], { tables: { items: { table: "items; DROP", keyColumn: { column: "id" }, columns: {} } } })).toThrow("identifier");
  });

  it("freezes mappings and rejects ambiguous paging and query forms", async () => {
    const tables: InfluxDB3DatabaseOptions["tables"] = { items: { table: "items", keyColumn: { column: "id", nullable: false }, columns: { title: { column: "title" }, done: { column: "done", nullable: false }, rank: { column: "rank", nullable: false } } } };
    const calls: Call[] = [];
    const db = database([response(rows([]))], calls, { tables });
    (tables.items?.keyColumn as { column: string }).column = "id\"; DROP TABLE x; --";
    const items = collection<{ title: string }>("items");
    await db.get(items.key("none"));
    expect(JSON.parse(String(calls[0]?.init?.body)) as { q: string }).toMatchObject({ q: expect.stringContaining('t."id" = $p0') });
    await expect(db.query(items.query().offset(1).build())).rejects.toThrow("offsets");
    await expect(db.query(items.query().orderBy("title").limit(1).build())).rejects.toThrow("nullable: false");
    await expect(db.query(items.query().limit(11).build())).rejects.toThrow("above configured maxRows");
    await expect(db.query(items.query().orderBy("rank").startAfter(1, 2).build())).rejects.toThrow("key cursor position must be a string");

    const numeric = collection<{ title: string }, number>("items");
    await expect(db.get(numeric.key(1))).rejects.toThrow("keys must be strings");
    await expect(db.query(items.query().where("__name__", "==", 1).build())).rejects.toThrow("require a string key");
  });

  it("accepts the generated-reference envelope only as compatibility", async () => {
    const calls: Call[] = [];
    const db = database([response(envelope([first]))], calls);
    const items = collection<{ title: string }>("items");
    await expect(db.get(items.key("one"))).resolves.toMatchObject({ exists: true, data: { title: "Milk" } });
  });
});
