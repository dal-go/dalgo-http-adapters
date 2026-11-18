import { describe, expect, it, vi } from "vitest";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { DuckDBExecutor, limits, type DuckDBSession } from "../src/executor.js";
import { DuckDBError } from "../src/errors.js";
import { nodeConfiguration } from "../src/node.js";
import { nodeValue } from "../src/values.js";
import { arrowValue, arrowNativeType } from "../src/arrow-values.js";
import { BrowserDuckDBDatabase } from "../src/browser.js";
import { readBrowserStream, type BrowserArrowStream } from "../src/browser-stream.js";

const result = { columns: [{ name: "n", nativeType: "BIGINT" }], rows: [[{ kind: "integer" as const, value: "9007199254740993" }]] };
function session(overrides: Partial<DuckDBSession> = {}): DuckDBSession {
  return { execute: vi.fn(async () => result), cancel: vi.fn(), close: vi.fn(), ...overrides };
}
describe("bounded isolated execution", () => {
  it("keeps exact ordinal integers and adds one overflow sentinel", async () => {
    const handle = session();
    const database = new DuckDBExecutor(async () => handle, { maxRows: 2 });
    expect(await database.queryOrdinal({ kind: "native", sql: "SELECT 9007199254740993::BIGINT AS n" })).toEqual(result);
    expect(handle.execute).toHaveBeenCalledWith(expect.stringContaining("LIMIT 3"), expect.objectContaining({ maxRows: 2 }));
    expect(handle.close).toHaveBeenCalledOnce();
  });
  it.each(["SELECT 1; DROP TABLE secrets", "SELECT 1 -- remove bound", "SELECT /* hidden */ 1", ""]) ("refuses a statement wrapper escape before opening", async sql => {
    const open = vi.fn(async () => session());
    await expect(new DuckDBExecutor(open).queryOrdinal({ kind: "native", sql })).rejects.toBeInstanceOf(DuckDBError);
    expect(open).not.toHaveBeenCalled();
  });
  it("rejects overflow rather than silently returning the first page", async () => {
    const handle = session({ execute: async () => ({ columns: result.columns, rows: [...result.rows, ...result.rows] }) });
    await expect(new DuckDBExecutor(async () => handle, { maxRows: 1 }).queryOrdinal({ kind: "native", sql: "SELECT 1" })).rejects.toMatchObject({ code: "bounds" });
    expect(handle.close).toHaveBeenCalledOnce();
  });
  it("refuses parameters instead of interpolating them", async () => {
    const open = vi.fn(async () => session());
    await expect(new DuckDBExecutor(open).queryOrdinal({ kind: "native", sql: "SELECT $p", parameters: [{ name: "p", nativeType: "BIGINT", value: 1 }] })).rejects.toMatchObject({ code: "unsupported" });
    expect(open).not.toHaveBeenCalled();
  });
  it("pre-abort starts no engine and never reveals a caller reason", async () => {
    const open = vi.fn(async () => session());
    const controller = new AbortController(); controller.abort("secret-token");
    await expect(new DuckDBExecutor(open).queryOrdinal({ kind: "native", sql: "SELECT 1" }, controller.signal)).rejects.toEqual(new QueryCancelledError("caller"));
    expect(open).not.toHaveBeenCalled();
  });
  it("interrupts promptly but keeps handles alive until outstanding native work settles", async () => {
    let finish: ((value: typeof result) => void) | undefined;
    const handle = session({ execute: () => new Promise(resolve => { finish = resolve; }) });
    const controller = new AbortController();
    const query = new DuckDBExecutor(async () => handle).queryOrdinal({ kind: "native", sql: "SELECT 1" }, controller.signal);
    await vi.waitFor(() => { expect(finish).toBeTypeOf("function"); });
    controller.abort("password");
    await expect(query).rejects.toEqual(new QueryCancelledError("caller"));
    expect(handle.cancel).toHaveBeenCalledOnce(); expect(handle.close).not.toHaveBeenCalled();
    finish?.(result);
    await vi.waitFor(() => { expect(handle.close).toHaveBeenCalledOnce(); });
  });
  it("refuses a late success when caller aborts during final close microtasks", async () => {
    const controller = new AbortController();
    const handle = session({
      close: () => Promise.resolve().then(() => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            queueMicrotask(() => controller.abort("synthetic-secret-reason"));
          });
        });
      }),
    });
    await expect(new DuckDBExecutor(async () => handle).queryOrdinal({ kind: "native", sql: "SELECT 1" }, controller.signal)).rejects.toEqual(new QueryCancelledError("caller"));
  });
  it("closes an engine that completes opening after cancellation", async () => {
    let opened: ((handle: DuckDBSession) => void) | undefined;
    const controller = new AbortController(); const handle = session();
    const query = new DuckDBExecutor(() => new Promise(resolve => { opened = resolve; })).queryOrdinal({ kind: "native", sql: "SELECT 1" }, controller.signal);
    await vi.waitFor(() => { expect(opened).toBeTypeOf("function"); }); controller.abort();
    await expect(query).rejects.toMatchObject({ reason: "caller" }); opened?.(handle);
    await vi.waitFor(() => { expect(handle.close).toHaveBeenCalledOnce(); }); expect(handle.execute).not.toHaveBeenCalled();
  });
  it("distinguishes deadline cancellation and redacts driver failures", async () => {
    await expect(new DuckDBExecutor(async () => session({ execute: () => new Promise(() => undefined) }), { timeoutMs: 1 }).queryOrdinal({ kind: "native", sql: "SELECT 1" })).rejects.toEqual(new QueryCancelledError("deadline"));
    await expect(new DuckDBExecutor(async () => { throw new Error("credential /private/path"); }).queryOrdinal({ kind: "native", sql: "SELECT 1" })).rejects.toEqual(new DuckDBError("query"));
  });
});
describe("asynchronous browser Arrow lifecycle", () => {
  const field = { name: "n", type: { typeId: 2, bitWidth: 64, toString: () => "Int64" } };
  it("awaits a delayed schema header before metadata or record batches", async () => {
    let finishHeader: (() => void) | undefined;
    const header = new Promise<void>(resolve => { finishHeader = resolve; });
    let ready = false;
    let iterated = false;
    const cancel = vi.fn(async () => undefined);
    const stream: BrowserArrowStream = {
      get schema() { if (!ready) throw new Error("schema accessed before header"); return { fields: [field] }; },
      async open() { await header; ready = true; },
      cancel,
      async *[Symbol.asyncIterator]() {
        iterated = true;
        yield { numRows: 1, getChildAt: () => ({ get: () => 9007199254740993n }) };
      },
    };
    const pending = readBrowserStream(stream, limits({}));
    await Promise.resolve();
    expect(iterated).toBe(false);
    finishHeader?.();
    expect(await pending).toEqual({ columns: [{ name: "n", nativeType: "Int64" }], rows: [[{ kind: "integer", value: "9007199254740993" }]] });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("releases a stream rejected by column or metadata byte bounds before iteration", async () => {
    for (const options of [{ maxColumns: 1 }, { maxResultBytes: 1 }]) {
      let iterated = false;
      const cancel = vi.fn(async () => undefined);
      const stream: BrowserArrowStream = {
        schema: { fields: [field, field] }, open: async () => undefined, cancel,
        async *[Symbol.asyncIterator]() { iterated = true; yield { numRows: 0, getChildAt: () => null }; },
      };
      await expect(readBrowserStream(stream, limits(options))).rejects.toMatchObject({ code: "bounds" });
      expect(iterated).toBe(false);
      expect(cancel).toHaveBeenCalledOnce();
    }
  });
  it("closes an active iterator on overflow without reading or returning excess rows", async () => {
    let returned = false;
    let valuesRead = 0;
    const cancel = vi.fn(async () => undefined);
    const stream: BrowserArrowStream = {
      schema: { fields: [field] }, open: async () => undefined, cancel,
      async *[Symbol.asyncIterator]() {
        try { yield { numRows: 3, getChildAt: () => ({ get: () => { valuesRead++; return 1n; } }) }; }
        finally { returned = true; }
      },
    };
    await expect(readBrowserStream(stream, limits({ maxRows: 1 }))).rejects.toMatchObject({ code: "bounds" });
    expect(valuesRead).toBe(1);
    expect(returned).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("preserves prompt caller cancellation and releases a delayed header when it settles", async () => {
    let failHeader: ((error: Error) => void) | undefined;
    const header = new Promise<void>((_, reject) => { failHeader = reject; });
    const cancel = vi.fn(async () => undefined);
    const stream: BrowserArrowStream = {
      schema: undefined, open: vi.fn(() => header), cancel,
      async *[Symbol.asyncIterator]() { yield { numRows: 0, getChildAt: () => null }; },
    };
    const handle = session({ execute: () => readBrowserStream(stream, limits({})), cancel: () => failHeader?.(new Error("synthetic-secret-header")) });
    const controller = new AbortController();
    const pending = new DuckDBExecutor(async () => handle).queryOrdinal({ kind: "native", sql: "SELECT 1" }, controller.signal);
    await vi.waitFor(() => { expect(stream.open).toHaveBeenCalledOnce(); });
    controller.abort("synthetic-secret-caller");
    await expect(pending).rejects.toEqual(new QueryCancelledError("caller"));
    await vi.waitFor(() => { expect(cancel).toHaveBeenCalledOnce(); expect(handle.close).toHaveBeenCalledOnce(); });
  });
  it("retains bool8 metadata and semantics alongside ordinary negative Int8 columns", async () => {
    const type = { typeId: 2, bitWidth: 8, isSigned: true, toString: () => "Int8" };
    const metadata = new Map([["ARROW:extension:name", "arrow.bool8"], ["ARROW:extension:metadata", ""]]);
    const values = [[0, 1, null], [-2, -1, -3]];
    const cancel = vi.fn(async () => undefined);
    const stream: BrowserArrowStream = {
      schema: { fields: [{ name: "flag", type, metadata }, { name: "negative", type }] },
      open: async () => undefined, cancel,
      async *[Symbol.asyncIterator]() { yield { numRows: 3, getChildAt: column => ({ get: index => values[column]?.[index] }) }; },
    };
    expect(await readBrowserStream(stream, limits({}))).toEqual({
      columns: [{ name: "flag", nativeType: "arrow.bool8<Int8>" }, { name: "negative", nativeType: "Int8" }],
      rows: [[false, -2], [true, -1], [null, -3]],
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
describe("engine enforced authority and exact scalar types", () => {
  it("decodes canonical booleans while preserving ordinary negative Int8", () => {
    const type = { typeId: 2, bitWidth: 8, isSigned: true, toString: () => "Int8" };
    const metadata = new Map([["ARROW:extension:name", "arrow.bool8"]]);
    expect(arrowNativeType(type, metadata)).toBe("arrow.bool8<Int8>");
    expect(arrowValue(0, type, metadata)).toBe(false);
    expect(arrowValue(1, type, metadata)).toBe(true);
    expect(arrowValue(null, type, metadata)).toBeNull();
    for (const value of [-2, -1]) expect(() => arrowValue(value, type, metadata)).toThrow(DuckDBError);
    expect(arrowValue(true, { typeId: 6 })).toBe(true);
    expect(arrowValue(false, { typeId: 6 })).toBe(false);
    expect(arrowValue(null, { typeId: 6 })).toBeNull();
    expect(() => arrowValue(-1, { typeId: 6 })).toThrow(DuckDBError);
    expect(arrowValue(-2, type)).toBe(-2);
    expect(arrowValue(-1, type)).toBe(-1);
    expect(arrowValue(-2, type, new Map())).toBe(-2);
  });
  it("refuses unknown bool8 values, storage and extension metadata without leaking values", () => {
    const type = { typeId: 2, bitWidth: 8, isSigned: true };
    const metadata = new Map([["ARROW:extension:name", "arrow.bool8"]]);
    for (const value of [-3, -2, -1, 2, 255, NaN, Infinity, true, false, "synthetic-secret", undefined]) {
      expect(() => arrowValue(value, type, metadata)).toThrow(new DuckDBError("unsupported"));
    }
    for (const storage of [{ typeId: 2, bitWidth: 16, isSigned: true }, { typeId: 2, bitWidth: 8, isSigned: false }, { typeId: 3, bitWidth: 8, isSigned: true }]) {
      expect(() => arrowValue(null, storage, metadata)).toThrow(DuckDBError);
    }
    expect(() => arrowValue(0, type, new Map([["ARROW:extension:name", "unknown.extension"]]))).toThrow(DuckDBError);
    expect(() => arrowValue(0, type, new Map([...metadata, ["ARROW:extension:metadata", "unexpected"]]))).toThrow(DuckDBError);
  });
  it("refuses nested and opaque UHUGEINT Arrow values instead of coercing them", () => {
    expect(() => arrowValue([1, 2], { typeId: 12 })).toThrow(new DuckDBError("unsupported"));
    expect(() => arrowValue(new Uint8Array(16), { typeId: 15 }, new Map([
      ["ARROW:extension:name", "arrow.opaque"],
      ["ARROW:extension:metadata", '{"type_name":"uhugeint","vendor_name":"DuckDB"}'],
    ]))).toThrow(new DuckDBError("unsupported"));
  });
  it("requires an explicit trusted same-origin mirror before admitting Parquet buffers", () => {
    vi.stubGlobal("location", new URL("https://fixture.invalid/app"));
    const worker = vi.fn(); vi.stubGlobal("Worker", worker);
    const options = { bundle: { mainModule: "/engine.wasm", mainWorker: "/worker.js" }, parquetFiles: { "fixture.parquet": new Uint8Array([1]) } };
    try {
      for (const repository of [undefined, "https://foreign.invalid/extensions", "/extensions?credential=secret", "https://user:secret@fixture.invalid/extensions", "/extensions#fragment", "data:text/plain,extension"]) {
        expect(() => new BrowserDuckDBDatabase({ ...options, ...(repository === undefined ? {} : { parquetExtensionRepository: repository }) })).toThrow(DuckDBError);
      }
      expect(worker).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("keeps trusted mirror selection lazy and permits engine-only SQL without a Parquet mirror", () => {
    vi.stubGlobal("location", new URL("https://fixture.invalid/app"));
    const worker = vi.fn(); vi.stubGlobal("Worker", worker);
    const bundle = { mainModule: "/engine.wasm", mainWorker: "/worker.js" };
    try {
      expect(() => new BrowserDuckDBDatabase({ bundle })).not.toThrow();
      expect(() => new BrowserDuckDBDatabase({ bundle, parquetFiles: { "fixture.parquet": new Uint8Array([1]) }, parquetExtensionRepository: "/extensions/" })).not.toThrow();
      expect(worker).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("disables external access, installation and broad filesystem grants", () => {
    expect(nodeConfiguration({ parquetPaths: ["/fixtures/rows.parquet"] })).toMatchObject({ enable_external_access: "false", autoinstall_known_extensions: "false", autoload_known_extensions: "false", allowed_paths: "['/fixtures/rows.parquet']" });
    expect(nodeConfiguration({ databasePath: "/fixtures/rows.duckdb" }).access_mode).toBe("READ_ONLY");
    expect(() => nodeConfiguration({ parquetPaths: ["/fixtures/*.parquet"] })).toThrow(DuckDBError);
    expect(() => nodeConfiguration({ parquetPaths: ["https://secret.test/rows.parquet"] })).toThrow(DuckDBError);
  });
  it("retains wide signed integers, decimal scale and temporal ticks", () => {
    expect(nodeValue(9007199254740993n, "BIGINT")).toEqual({ kind: "integer", value: "9007199254740993" });
    expect(nodeValue({ value: -120034n, scale: 4 }, "DECIMAL(12,4)")).toEqual({ kind: "decimal", unscaled: "-120034", scale: 4 });
    expect(nodeValue({ micros: 1700000000000001n }, "TIMESTAMP")).toEqual({ kind: "datetime", ticksSinceEpoch: "1700000000000001", scale: 6 });
    expect(() => nodeValue(Number.MAX_SAFE_INTEGER + 1, "BIGINT")).toThrow(DuckDBError);
    expect(() => nodeValue({ micros: -((1n << 63n) - 1n) }, "TIMESTAMP")).toThrow(DuckDBError);
    expect(() => nodeValue({ entries: { password: "x" } }, "STRUCT")).toThrow(DuckDBError);
  });
  it("reads signed Arrow decimal128 without converting to double", () => {
    expect(arrowValue(new Uint32Array([0xfffffff4, 0xffffffff, 0xffffffff, 0xffffffff]), { typeId: 7, scale: 2 })).toEqual({ kind: "decimal", unscaled: "-12", scale: 2 });
    expect(arrowValue(9007199254740993n, { typeId: 2, bitWidth: 64 })).toEqual({ kind: "integer", value: "9007199254740993" });
    expect(() => arrowValue(new Date(), { typeId: 10 })).toThrow(DuckDBError);
  });
});
