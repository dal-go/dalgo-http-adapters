import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClickHouseNativeError, NativeClickHouseDatabase } from "../src/index.js";
import { binary, text, uint } from "./helpers/binary.js";

const wire = binary(["same", "same"], ["UInt64", "String"], [[...uint(18446744073709551615n, 8), 1, 120]]);
const request = { kind: "native" as const, sql: "SELECT 1" };
const options = { serverUrl: "https://click.example", tables: {}, allowNativeSql: true };
const responseHeaders = { "x-clickhouse-format": "RowBinaryWithNamesAndTypes", "x-clickhouse-exception-tag": "abcdefghijklmnop" };
function response(bytes = wire): Response { return new Response(bytes.slice().buffer, { headers: responseHeaders }); }
afterEach(() => { vi.useRealTimers(); });

describe("NativeClickHouseDatabase", () => {
  it("uses an anonymous ordinal result, mandatory read bounds, exact bindings and refreshed credentials", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response()));
    const headers = vi.fn(() => ({ "X-ClickHouse-User": "reader", "X-ClickHouse-Key": "synthetic" }));
    const db = new NativeClickHouseDatabase({ ...options, fetch: fetcher, headers, maxRows: 2 });
    const sql = " SELECT {id:UInt64} AS same, 'x' AS same\n";
    const result = await db.queryOrdinal({ kind: "native", sql, parameters: [{ name: "id", nativeType: "UInt64", value: { kind: "integer", value: "18446744073709551615" } }] });
    expect(result.rows).toEqual([[{ kind: "integer", value: "18446744073709551615" }, "x"]]);
    expect(result.columns.map((column) => column.name)).toEqual(["same", "same"]);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    const params = new URL(url).searchParams;
    expect(params.get("param_id")).toBe("18446744073709551615");
    expect(params.get("readonly")).toBe("1"); expect(params.get("result_overflow_mode")).toBe("throw");
    expect(params.get("max_result_rows")).toBe("2"); expect(params.get("max_execution_time")).toBe("30");
    expect(params.get("query_id")).toMatch(/^dalgo-[0-9a-f-]{36}$/u);
    expect(init).toMatchObject({ body: sql, method: "POST", redirect: "error", credentials: "omit", cache: "no-store" });
    expect(init.headers).toMatchObject({ "x-clickhouse-user": "reader", "x-clickhouse-format": "RowBinaryWithNamesAndTypes" });
    await db.queryOrdinal(request);
    expect(headers).toHaveBeenCalledTimes(2);
    expect(db).not.toHaveProperty("append"); expect(db).not.toHaveProperty("get"); expect(db).not.toHaveProperty("query");
  });

  it("rejects malformed configuration and unauthorized requests before fetch", async () => {
    for (const serverUrl of ["http://remote.example", "https://user:password@click.example", "https://click.example/path", "https://click.example/?readonly=0", "invalid"]) {
      expect(() => new NativeClickHouseDatabase({ ...options, serverUrl })).toThrow();
    }
    expect(() => new NativeClickHouseDatabase({ ...options, maxRows: 0 })).toThrow();
    expect(() => new NativeClickHouseDatabase({ ...options, tables: { unsafe: { database: "explore", table: "events;DROP", columns: {} } } })).toThrow();
    const fetcher = vi.fn();
    const db = new NativeClickHouseDatabase({ ...options, fetch: fetcher, allowNativeSql: false });
    await expect(db.queryOrdinal(request)).rejects.toThrow("permission");
    expect(fetcher).not.toHaveBeenCalled();
    const small = new NativeClickHouseDatabase({ ...options, fetch: fetcher, maxRequestBytes: 10 });
    await expect(small.queryOrdinal(request)).rejects.toThrow("bounds");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("redacts credentials, provider failures, status bodies and poisoned header providers", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("secret-transport"));
    const db = new NativeClickHouseDatabase({ ...options, fetch: fetcher });
    await expect(db.queryOrdinal(request)).rejects.toThrow("transport failure");
    const failed = new NativeClickHouseDatabase({ ...options, fetch: vi.fn().mockResolvedValue(new Response("secret-body", { status: 403 })) });
    const error: unknown = await failed.queryOrdinal(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClickHouseNativeError); expect(String(error)).not.toContain("secret");
    expect(error).not.toHaveProperty("cause");
    for (const headers of [() => ({ "X-ClickHouse-Format": "JSON" }), () => ({ Authorization: "secret\n" }), () => { throw new Error("secret-provider"); }]) {
      const guarded = new NativeClickHouseDatabase({ ...options, fetch: fetcher, headers });
      await expect(guarded.queryOrdinal(request)).rejects.toBeInstanceOf(ClickHouseNativeError);
    }
  });

  it("bounds advertised and streamed response bytes and refuses in-band errors", async () => {
    const responses = [new Response("too large", { headers: { ...responseHeaders, "content-length": "999" } }), new Response("more than cap", { headers: responseHeaders }),
      new Response(wire.slice().buffer, { headers: { ...responseHeaders, "x-clickhouse-exception-code": "secret" } })];
    for (const returned of responses) {
      const db = new NativeClickHouseDatabase({ ...options, maxResponseBytes: 2, fetch: vi.fn().mockResolvedValue(returned) });
      await expect(db.queryOrdinal(request)).rejects.toBeInstanceOf(ClickHouseNativeError);
    }
    const broken = new NativeClickHouseDatabase({ ...options, fetch: vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.error(new Error("secret-stream")); } }), { headers: responseHeaders })) });
    await expect(broken.queryOrdinal(request)).rejects.toThrow("transport failure");
  });

  it("rejects a nonce-bound late HTTP200 exception before UInt8 bytes become fabricated rows", async () => {
    const message = new TextEncoder().encode("Code: 395. DB::Exception: synthetic π failure\n");
    const beginning = binary(["n"], ["UInt8"], [[7]]);
    const prefix = new TextEncoder().encode("\r\n__exception__\r\nabcdefghijklmnop\r\n");
    const footer = new TextEncoder().encode(`${String(message.length)} abcdefghijklmnop\r\n__exception__\r\n`);
    const bytes = Uint8Array.from([...beginning, ...prefix, ...message, ...footer]);
    const db = new NativeClickHouseDatabase({ ...options, fetch: vi.fn().mockResolvedValue(response(bytes)) });
    const error: unknown = await db.queryOrdinal(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClickHouseNativeError);
    expect(String(error)).toBe("ClickHouseNativeError: ClickHouse framing failure");
    expect(error).toMatchObject({ code: "framing", framing: { actualFormat: "RowBinaryWithNamesAndTypes", tagLength: 16, prefixPresent: true, bodyBytes: bytes.length, frameBytes: prefix.length + message.length + footer.length, completeBody: true } });
    expect(String(error)).not.toContain("synthetic");
  });

  it("refuses malformed or truncated same-nonce exception tails instead of UInt8 success", async () => {
    for (const tail of ["\r\n__exception__\r\nabcdefghijklmnop\r\n", "\r\n__exception__\r\nabcdefghijklmnop\r\nCode: synthetic\nwrong-length abcdefghijklmnop\r\n__exception__\r\n"]) {
      const bytes = Uint8Array.from([...binary(["n"], ["UInt8"], [[7]]), ...new TextEncoder().encode(tail)]);
      const db = new NativeClickHouseDatabase({ ...options, fetch: vi.fn().mockResolvedValue(response(bytes)) });
      await expect(db.queryOrdinal(request)).rejects.toMatchObject({ code: "framing", framing: { prefixPresent: true } });
    }
  });

  it("attributes captured late framing when the server subsequently breaks the HTTP stream", async () => {
    const prefix = new TextEncoder().encode("\r\n__exception__\r\nabcdefghijklmnop\r\n");
    const bytes = Uint8Array.from([...binary(["n"], ["UInt8"], [[7]]), ...prefix]);
    let emitted = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (!emitted) { emitted = true; controller.enqueue(bytes); }
      else controller.error(new Error("secret connection failure"));
    } });
    const db = new NativeClickHouseDatabase({ ...options, fetch: vi.fn().mockResolvedValue(new Response(stream, { headers: responseHeaders })) });
    await expect(db.queryOrdinal(request)).rejects.toMatchObject({ code: "framing", framing: { actualFormat: "RowBinaryWithNamesAndTypes", tagLength: 16, prefixPresent: true, bodyBytes: bytes.length, frameBytes: prefix.length, completeBody: false } });
  });

  it("preserves healthy arbitrary bytes and ordinary error-looking text", async () => {
    const ordinary = "Code: 395. DB::Exception: ordinary data\n__exception__\nabcdefghijklmnop";
    const healthy = binary(["text", "byte"], ["String", "UInt8"], [[...text(ordinary), 255]]);
    const db = new NativeClickHouseDatabase({ ...options, fetch: vi.fn().mockResolvedValue(response(healthy)) });
    await expect(db.queryOrdinal(request)).resolves.toMatchObject({ rows: [[ordinary, { kind: "integer", value: "255" }]] });
    const otherTagFrame = "\r\n__exception__\r\nponmlkjihgfedcba\r\nx\n2 ponmlkjihgfedcba\r\n__exception__\r\n";
    const arbitrary = Uint8Array.from([...binary(["n"], ["UInt8"]), ...new TextEncoder().encode(otherTagFrame)]);
    const byteReader = new NativeClickHouseDatabase({ ...options, fetch: vi.fn().mockResolvedValue(response(arbitrary)) });
    const result = await byteReader.queryOrdinal(request);
    expect(result.rows).toHaveLength(new TextEncoder().encode(otherTagFrame).length);
  });

  it("fails closed when the response exception nonce is absent, invalid or hidden by CORS", async () => {
    for (const tag of [undefined, "invalid", "ABCDEFGHIJKLMNOP", "abcdefghijklmnop,abcdefghijklmnop"]) {
      const headers = { "x-clickhouse-format": "RowBinaryWithNamesAndTypes", ...(tag === undefined ? {} : { "x-clickhouse-exception-tag": tag }) };
      const db = new NativeClickHouseDatabase({ ...options, fetch: vi.fn().mockResolvedValue(new Response(wire.slice().buffer, { headers })) });
      await expect(db.queryOrdinal(request)).rejects.toThrow("unsupported");
    }
  });

  it("cancels before credentials or fetch and never emits a late page", async () => {
    const controller = new AbortController(); controller.abort(new Error("secret-reason"));
    const fetcher = vi.fn();
    const db = new NativeClickHouseDatabase({ ...options, fetch: fetcher });
    await expect(db.queryOrdinal(request, controller.signal)).rejects.toMatchObject({ reason: "caller" });
    expect(fetcher).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const blocked = new NativeClickHouseDatabase({ ...options, timeoutMs: 10, fetch: fetcher, headers: () => new Promise(() => undefined) });
    const result = blocked.queryOrdinal(request); const assertion = expect(result).rejects.toBeInstanceOf(QueryCancelledError);
    await vi.advanceTimersByTimeAsync(10); await assertion;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("aborts a hostile pending fetch promptly and attempts a separately bounded own-ID KILL", async () => {
    vi.useFakeTimers();
    let complete: ((response: Response) => void) | undefined;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; })).mockImplementation(() => Promise.resolve(response()));
    const db = new NativeClickHouseDatabase({ ...options, timeoutMs: 10, fetch: fetcher });
    const result = db.queryOrdinal(request); const assertion = expect(result).rejects.toMatchObject({ reason: "deadline" });
    await vi.advanceTimersByTimeAsync(10); await assertion;
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const original = new URL(fetcher.mock.calls[0]?.[0] as string).searchParams.get("query_id");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ body: `KILL QUERY WHERE query_id = '${original ?? ""}' SYNC` });
    complete?.(response()); await vi.advanceTimersByTimeAsync(1);
    expect(db.serverCancellation).toBe("best-effort-kill-query");
  });

  it("aborts a pending body read even when cancel itself never settles", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(stream, { headers: responseHeaders })).mockImplementation(() => Promise.resolve(response()));
    const db = new NativeClickHouseDatabase({ ...options, fetch: fetcher });
    const result = db.queryOrdinal(request, controller.signal);
    // Flush credential acquisition and fetch without a wall-clock wait.
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    controller.abort(new Error("secret"));
    await expect(result).rejects.toMatchObject({ reason: "caller" });
    expect(cancel).toHaveBeenCalled();
  });
});
