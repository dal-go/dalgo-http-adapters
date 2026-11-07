import { describe, expect, it, vi } from "vitest";
import { BSON, type Db, type Document, type FindOptions, type AggregateOptions } from "mongodb";
import { MongoNodeExecutor } from "../src/node-executor.js";

function fixture(rows: readonly Record<string, unknown>[]) {
  let offset = 0;
  const close = vi.fn(() => Promise.resolve());
  const cursor = { next: vi.fn(() => Promise.resolve(rows[offset++] ?? null)), close };
  const find = vi.fn<(filter: Document, options: FindOptions) => typeof cursor>(() => cursor);
  const aggregate = vi.fn<(pipeline: Document[], options: AggregateOptions) => typeof cursor>(() => cursor);
  const collection = vi.fn(() => ({ find, aggregate }));
  const executor = new MongoNodeExecutor({ database: { collection } as unknown as Db, collections: { products: "existing_products" }, maxRows: 10 });
  return { executor, find, aggregate, close, collection, cursor };
}

describe("MongoNodeExecutor", () => {
  it("reads existing documents without a DALgo envelope and retains exact BSON values", async () => {
    const f = fixture([{ _id: new BSON.ObjectId("000000000000000000000001"), price: BSON.Decimal128.fromString("12345678901234567890.001"), count: BSON.Long.fromString("9007199254740993"), payload: new BSON.Binary(new Uint8Array([0, 255])) }]);
    const result = await f.executor.execute({ kind: "find", collection: "products", limit: 2 });
    expect(result.kind).toBe("documents");
    if (result.kind !== "documents") throw new Error("documents required");
    expect(result.documents[0]).toMatchObject({ _id: { $oid: "000000000000000000000001" }, count: { $numberLong: "9007199254740993" }, price: { $numberDecimal: "12345678901234567890.001" }, payload: { $binary: { base64: "AP8=", subType: "00" } } });
    expect(f.find.mock.calls[0]?.[1]).toMatchObject({ limit: 3, batchSize: 3, maxTimeMS: 30_000, promoteLongs: false, promoteValues: false });
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("pages with a signed query-bound cursor and BSON comparison order", async () => {
    const f = fixture([{ _id: "a" }, { _id: "b" }]);
    const first = await f.executor.execute({ kind: "find", collection: "products", limit: 1 });
    if (first.kind !== "documents" || first.nextCursor === undefined) throw new Error("cursor required");
    await f.executor.execute({ kind: "find", collection: "products", limit: 1, after: first.nextCursor });
    expect(f.find.mock.calls[1]?.[0]).toEqual({ $and: [{}, { $expr: { $gt: ["$_id", { $literal: "a" }] } }] });
    await expect(f.executor.execute({ kind: "find", collection: "products", filter: { active: true }, limit: 1, after: first.nextCursor })).rejects.toMatchObject({ code: "protocol" });
    const mutated = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith("a") ? "b" : "a"}`;
    await expect(f.executor.execute({ kind: "find", collection: "products", limit: 1, after: mutated })).rejects.toMatchObject({ code: "permission" });
  });

  it("refuses writes, JS, unconfigured collections and hidden extra options before driver calls", async () => {
    const f = fixture([]);
    const requests: unknown[] = [
      { kind: "find", collection: "other", limit: 1 },
      { kind: "find", collection: "products", filter: { $where: "secret()" }, limit: 1 },
      { kind: "find", collection: "products", filter: { x: { $regex: ".*" } }, limit: 1 },
      { kind: "find", collection: "products", limit: 1, uri: "mongodb://secret" },
      { kind: "aggregate", collection: "products", pipeline: [{ $out: "sink" }], limit: 1 },
      { kind: "aggregate", collection: "products", pipeline: [{ $lookup: { from: "private" } }], limit: 1 },
      { kind: "aggregate", collection: "products", pipeline: [{ $project: { secret: { $function: {} } } }], limit: 1 },
    ];
    for (const request of requests) await expect(f.executor.execute(request as Parameters<MongoNodeExecutor["execute"]>[0])).rejects.toBeInstanceOf(Error);
    expect(f.find).not.toHaveBeenCalled();
    expect(f.aggregate).not.toHaveBeenCalled();
  });

  it("refuses aggregate overflow instead of reporting a truncated success", async () => {
    const f = fixture([{ _id: "a" }, { _id: "b" }]);
    await expect(f.executor.execute({ kind: "aggregate", collection: "products", pipeline: [{ $match: { active: true } }], limit: 1 })).rejects.toMatchObject({ code: "bounds" });
    expect(f.aggregate.mock.calls[0]?.[0]).toEqual([{ $match: { active: true } }, { $limit: 2 }]);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("cancels a hanging cursor read promptly and closes it without exposing abort reason", async () => {
    const f = fixture([]);
    f.cursor.next.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = f.executor.execute({ kind: "find", collection: "products", limit: 1 }, controller.signal);
    controller.abort("token secret");
    await expect(pending).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller", message: "query cancelled by caller" });
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("bounds response bytes and redacts provider authentication errors", async () => {
    const f = fixture([]);
    f.cursor.next.mockRejectedValue({ code: 18, message: "mongodb://alice:secret@host" });
    await expect(f.executor.execute({ kind: "find", collection: "products", limit: 1 })).rejects.toMatchObject({ code: "authentication", message: "MongoDB read failed (authentication)" });
    const large = fixture([{ _id: "a", value: "x".repeat(4_194_304) }]);
    await expect(large.executor.execute({ kind: "find", collection: "products", limit: 1 })).rejects.toMatchObject({ code: "bounds" });
    expect(large.close).toHaveBeenCalledOnce();
  });

  it("describes only configured grants without claiming network discovery", async () => {
    const f = fixture([]);
    expect(await f.executor.execute({ kind: "discover" })).toEqual({ kind: "collections", source: "configured", collections: ["products"] });
    expect(f.collection).not.toHaveBeenCalled();
  });

  it("applies the configured response byte cap to configured metadata", async () => {
    const executor = new MongoNodeExecutor({ database: {} as Db, collections: { products: "physical" }, maxResponseBytes: 32 });
    await expect(executor.execute({ kind: "discover" })).rejects.toMatchObject({ code: "bounds" });
  });
});
