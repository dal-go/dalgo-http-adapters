import { collection } from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { TimestreamDatabase, type TimestreamDatabaseOptions } from "../src/index.js";

interface Call { readonly url: string; readonly init: RequestInit | undefined; }
function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/x-amz-json-1.0" } }); }
function query(rows: readonly unknown[], nextToken?: string): unknown { return { QueryId: "query123", ColumnInfo: [{ Name: "__dalgo_key", Type: { ScalarType: "VARCHAR" } }, { Name: "room", Type: { ScalarType: "VARCHAR" } }, { Name: "temperature", Type: { ScalarType: "DOUBLE" } }], Rows: rows, ...(nextToken === undefined ? {} : { NextToken: nextToken }) }; }
function row(id: string, room = "kitchen", temperature = "21.5"): unknown { return { Data: [{ ScalarValue: id }, { ScalarValue: room }, { ScalarValue: temperature }] }; }
function database(responses: readonly Response[], calls: Call[], overrides: Partial<TimestreamDatabaseOptions> = {}): TimestreamDatabase {
  return new TimestreamDatabase({ region: "eu-west-1", database: "sensors", credentials: () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" }), queryEndpoint: "http://127.0.0.1:4567", writeEndpoint: "http://127.0.0.1:4568", maxRows: 10, maxResponseBytes: 10000, timeoutMs: 1000, tables: { readings: { table: "readings", keyColumn: "reading_id", columns: { room: "room", temperature: "measure_value" } } }, fetch: async (input, init) => { calls.push({ url: String(input), init }); const next = responses[calls.length - 1]; if (next === undefined) throw new Error("unexpected fetch"); return next; }, ...overrides });
}

describe("TimestreamDatabase", () => {
  it("issues a SigV4 Query request and decodes mapped DALgo rows", async () => {
    const calls: Call[] = []; const db = database([response(query([row("a")]))], calls); const readings = collection<{ room: string; temperature: number }>("readings");
    await expect(db.query(readings.query().limit(1).build())).resolves.toEqual({ records: [{ key: readings.key("a"), exists: true, data: { room: "kitchen", temperature: 21.5 } }] });
    expect(calls[0]?.url).toBe("http://127.0.0.1:4567"); expect(calls[0]?.init?.headers).toMatchObject({ "x-amz-target": "Timestream_20181101.Query", "x-amz-content-sha256": expect.stringMatching(/^[a-f0-9]{64}$/u), authorization: expect.stringContaining("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/") });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ MaxRows: 1, QueryString: expect.stringContaining('FROM "sensors"."readings" LIMIT 1') });
  });

  it("exposes native service pagination and recursive Timestream type decoding", async () => {
    const calls: Call[] = []; const complex = { QueryId: "query123", NextToken: "token2", ColumnInfo: [{ Name: "big", Type: { ScalarType: "BIGINT" } }, { Name: "tags", Type: { ArrayColumnInfo: { Name: "", Type: { ScalarType: "VARCHAR" } } } }, { Name: "point", Type: { RowColumnInfo: [{ Name: "ok", Type: { ScalarType: "BOOLEAN" } }] } }], Rows: [{ Data: [{ ScalarValue: "9223372036854775807" }, { ArrayValue: [{ ScalarValue: "a" }, { NullValue: true }] }, { RowValue: { Data: [{ ScalarValue: "true" }] } }] }] };
    const page = await database([response(complex)], calls).querySql("SELECT * FROM readings", 1); expect(page).toEqual({ queryId: "query123", nextToken: "token2", columns: ["big", "tags", "point"], rows: [{ big: 9223372036854775807n, tags: ["a", null], point: { ok: true } }] });
    await expect(database([], []).querySql("DELETE FROM readings")).rejects.toThrow("read-only"); expect(calls).toHaveLength(1);
  });

  it("writes native records and rejects DALgo mutations before network access", async () => {
    const calls: Call[] = []; const db = database([response({ RecordsIngested: { Total: 1, MemoryStore: 1, MagneticStore: 0 } })], calls); await expect(db.writeRecords("readings", [{ MeasureName: "temperature", MeasureValue: "21.5", MeasureValueType: "DOUBLE" }])).resolves.toEqual({ recordsIngested: { Total: 1, MemoryStore: 1, MagneticStore: 0 } });
    expect(calls[0]?.url).toBe("http://127.0.0.1:4568"); expect(calls[0]?.init?.headers).toMatchObject({ "x-amz-target": "Timestream_20181101.WriteRecords" });
    const readings = collection<{ room: string }>("readings"); await expect(db.insert(readings.key("a"), { room: "kitchen" })).rejects.toThrow("insert semantics"); await expect(db.delete(readings.key("a"))).rejects.toThrow("delete semantics"); expect(calls).toHaveLength(1);
  });

  it("rejects ambiguous generic pagination, unsupported shapes, and oversized responses", async () => {
    const readings = collection<{ room: string }>("readings"); await expect(database([response(query([row("a")], "next"))], []).query(readings.query().limit(1).build())).rejects.toThrow("cannot expose");
    await expect(database([], []).query(readings.query().where("room", "==", "kitchen").build())).rejects.toThrow("filters");
    await expect(database([response(query([row("a")]), 200)], [], { maxResponseBytes: 2 }).querySql("SELECT * FROM readings")).rejects.toThrow("maxResponseBytes");
    expect(() => database([], [], { region: "eu-west-1;drop" })).toThrow("identifier"); expect(() => database([], [], { maxRows: 1001 })).toThrow("cannot exceed");
  });
});
