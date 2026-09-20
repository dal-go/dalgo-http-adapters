import { collection } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { BigQueryDatabase, type BigQueryDatabaseOptions } from "../src/index.js";

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function database(responses: readonly Response[], calls: Call[], overrides: Partial<BigQueryDatabaseOptions> = {}): BigQueryDatabase {
  const options: BigQueryDatabaseOptions = {
    projectId: "example-project",
    location: "EU",
    maximumBytesBilled: "1000000",
    timeoutMs: 1000,
    initialWaitMs: 1,
    pageSize: 1,
    maxRows: 10,
    accessToken: () => "rotating-token",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const next = responses[calls.length - 1];
      if (next === undefined) throw new Error("unexpected fetch");
      return next;
    },
    tables: {
      items: {
        datasetId: "app_data",
        tableId: "items",
        keyColumn: { column: "id", type: "STRING", nullable: false },
        columns: {
          title: { column: "title", type: "STRING" },
          done: { column: "done", type: "BOOL", nullable: false },
          rank: { column: "rank", type: "INT64", nullable: false },
        },
      },
    },
    ...overrides,
  };
  return new BigQueryDatabase(options);
}

const schema = { fields: [{ name: "__dalgo_key", type: "STRING" }, { name: "title", type: "STRING" }, { name: "done", type: "BOOL" }, { name: "rank", type: "INT64" }] };
const firstRow = { f: [{ v: "one" }, { v: "Milk" }, { v: "false" }, { v: "10" }] };
const secondRow = { f: [{ v: "two" }, { v: "Tea" }, { v: "false" }, { v: "11" }] };

describe("BigQueryDatabase", () => {
  it("polls an unfinished query, reads result pages, and returns a usable cursor", async () => {
    const calls: Call[] = [];
    const db = database([
      response({ jobComplete: false, jobReference: { jobId: "job-1", location: "EU" } }),
      response({ jobComplete: true, schema, rows: [firstRow], pageToken: "page-2", totalBytesProcessed: "99", totalBytesBilled: "100", cacheHit: false }),
      response({ jobComplete: true, schema, rows: [secondRow] }),
    ], calls);
    const items = collection<{ title: string; done: string; rank: string }>("items");
    const page = await db.query(items.query().where("done", "==", false).orderBy("rank").limit(1).build());

    expect(page.records).toEqual([{ key: items.key("one"), exists: true, data: { title: "Milk", done: "false", rank: "10" }, metadata: { jobId: "job-1", totalBytesProcessed: "99", totalBytesBilled: "100", cacheHit: false } }]);
    expect(page.nextCursor).toEqual({ values: ["10", "one"] });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe("https://bigquery.googleapis.com/bigquery/v2/projects/example-project/queries");
    expect(calls[1]?.url).toContain("/queries/job-1?maxResults=1&location=EU");
    expect(calls[2]?.url).toContain("pageToken=page-2");
    const initial = JSON.parse(String(calls[0]?.init?.body)) as { query: string; queryParameters: unknown[]; maximumBytesBilled: string };
    expect(initial.query).toContain("`done` = @p0");
    expect(initial.queryParameters).toEqual([{ name: "p0", parameterType: { type: "BOOL" }, parameterValue: { value: "false" } }]);
    expect(initial.maximumBytesBilled).toBe("1000000");
    expect(calls.every((call) => call.init?.redirect === "error" && call.init.headers instanceof Object)).toBe(true);
  });

  it("returns a missing snapshot and rejects unprovable mutation semantics", async () => {
    const getCalls: Call[] = [];
    const getDb = database([response({ jobComplete: true, jobReference: { jobId: "get-1" }, schema, rows: [] })], getCalls);
    const items = collection<{ title: string }>("items");
    await expect(getDb.get(items.key("absent"))).resolves.toEqual({ key: items.key("absent"), exists: false });

    await expect(getDb.update(items.key("one"), { title: "Oat milk" })).rejects.toThrow("unique-key");
    await expect(getDb.delete(items.key("one"))).rejects.toThrow("unique-key");
  });

  it("rejects callback transactions, unprovable inserts, and redacts HTTP response bodies", async () => {
    const calls: Call[] = [];
    const db = database([response({ secret: "never surface" }, 403)], calls);
    const items = collection<{ title: string }>("items");
    await expect(db.insert(items.key("one"), { title: "Milk" })).rejects.toThrow("unique-key");
    await expect(db.runReadwriteTransaction(async () => "nope")).rejects.toThrow("callback transactions");
    await expect(db.get(items.key("one"))).rejects.toEqual(expect.objectContaining({ name: "BigQueryHttpError", status: 403 }));
  });

  it("rejects result-page cycles but permits documented completed-job warnings", async () => {
    const pageCalls: Call[] = [];
    const pageDb = database([
      response({ jobComplete: true, jobReference: { jobId: "cycle" }, schema, rows: [], pageToken: "again" }),
      response({ jobComplete: true, schema, rows: [], pageToken: "again" }),
    ], pageCalls);
    const items = collection<{ title: string }>("items");
    await expect(pageDb.get(items.key("one"))).rejects.toThrow("repeated a page token");

    const warningCalls: Call[] = [];
    const warningDb = database([response({ jobComplete: true, errors: [{ message: "warning" }], schema, rows: [firstRow] })], warningCalls);
    await expect(warningDb.get(items.key("one"))).resolves.toMatchObject({ exists: true, data: { title: "Milk" } });
  });

  it("copies mappings, validates the exact result projection, and treats an empty page token as terminal", async () => {
    const mappedTables: BigQueryDatabaseOptions["tables"] = {
      items: {
        datasetId: "app_data",
        tableId: "items",
        keyColumn: { column: "id", type: "STRING", nullable: false },
        columns: { title: { column: "title", type: "STRING" }, done: { column: "done", type: "BOOL", nullable: false }, rank: { column: "rank", type: "INT64", nullable: false } },
      },
    };
    const calls: Call[] = [];
    const db = database([response({ jobComplete: true, schema, rows: [], pageToken: "" })], calls, { tables: mappedTables });
    (mappedTables.items?.keyColumn as { column: string }).column = "id`; DROP TABLE x; --";
    const items = collection<{ title: string }>("items");
    await expect(db.get(items.key("one"))).resolves.toEqual({ key: items.key("one"), exists: false });
    expect(String(calls[0]?.init?.body)).toContain("t.`id` = @key");
    expect(calls).toHaveLength(1);

    const malformedCalls: Call[] = [];
    const malformedDb = database([response({ jobComplete: true, schema: { fields: [{ name: "title", type: "STRING" }] }, rows: [] })], malformedCalls);
    await expect(malformedDb.get(items.key("one"))).rejects.toThrow("projection");
  });

  it("round-trips BigQuery BOOL and FLOAT64 wire cursor values into typed parameters", async () => {
    const boolCalls: Call[] = [];
    const boolDb = database([
      response({ jobComplete: true, jobReference: { jobId: "bool" }, schema, rows: [firstRow, secondRow] }),
      response({ jobComplete: true, jobReference: { jobId: "bool-2" }, schema, rows: [] }),
    ], boolCalls);
    const items = collection<{ done: string }>("items");
    const first = await boolDb.query(items.query().orderBy("done").limit(1).build());
    await boolDb.query(items.query().orderBy("done").startAfter(...(first.nextCursor?.values ?? [])).limit(1).build());
    const boolRequest = JSON.parse(String(boolCalls[1]?.init?.body)) as { queryParameters: readonly { name: string; parameterValue: { value: string } }[] };
    expect(boolRequest.queryParameters).toContainEqual({ name: "c0", parameterType: { type: "BOOL" }, parameterValue: { value: "false" } });

    const floatTables: BigQueryDatabaseOptions["tables"] = {
      items: {
        datasetId: "app_data", tableId: "items", keyColumn: { column: "id", type: "STRING", nullable: false },
        columns: { title: { column: "title", type: "STRING" }, done: { column: "done", type: "BOOL", nullable: false }, rank: { column: "rank", type: "FLOAT64", nullable: false } },
      },
    };
    const floatCalls: Call[] = [];
    const floatDb = database([
      response({ jobComplete: true, jobReference: { jobId: "float" }, schema: { fields: [{ name: "__dalgo_key", type: "STRING" }, { name: "title", type: "STRING" }, { name: "done", type: "BOOL" }, { name: "rank", type: "FLOAT64" }] }, rows: [{ f: [{ v: "one" }, { v: "Milk" }, { v: "false" }, { v: "1.5" }] }, { f: [{ v: "two" }, { v: "Tea" }, { v: "false" }, { v: "2.5" }] }] }),
      response({ jobComplete: true, jobReference: { jobId: "float-2" }, schema: { fields: [{ name: "__dalgo_key", type: "STRING" }, { name: "title", type: "STRING" }, { name: "done", type: "BOOL" }, { name: "rank", type: "FLOAT64" }] }, rows: [] }),
    ], floatCalls, { tables: floatTables });
    const floatFirst = await floatDb.query(items.query().orderBy("rank").limit(1).build());
    await floatDb.query(items.query().orderBy("rank").startAfter(...(floatFirst.nextCursor?.values ?? [])).limit(1).build());
    const floatRequest = JSON.parse(String(floatCalls[1]?.init?.body)) as { queryParameters: readonly { name: string; parameterValue: { value: string } }[] };
    expect(floatRequest.queryParameters).toContainEqual({ name: "c0", parameterType: { type: "FLOAT64" }, parameterValue: { value: "1.5" } });
  });
});
