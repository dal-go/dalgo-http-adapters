import { describe, expect, it, vi } from "vitest";
import { Key, collection } from "@dalgo/core";
import { MongoDatabase } from "../src/database.js";
import type { MongoReadRequest, MongoReadResult } from "../src/types.js";

describe("MongoDB modern core facade", () => {
  it("maps string-keyed existing documents and retains canonical int64 data", async () => {
    const execute = vi.fn<(request: MongoReadRequest) => Promise<MongoReadResult>>(() => Promise.resolve({ kind: "documents", documents: [{ _id: "sku-1", count: { $numberLong: "9007199254740993" } }] }));
    const db = new MongoDatabase({ execute }, { idKind: "string" });
    const result = await db.get(new Key("products", "sku-1"));
    expect(result).toMatchObject({ exists: true, data: { count: { $numberLong: "9007199254740993" } } });
    expect(execute.mock.calls[0]?.[0]).toEqual({ kind: "find", collection: "products", filter: { _id: "sku-1" }, limit: 1 });
  });

  it("uses actual core StructuredQuery and returns only the adapter-generated continuation", async () => {
    const requests: MongoReadRequest[] = [];
    const db = new MongoDatabase({ execute: (request): Promise<MongoReadResult> => { requests.push(request); return Promise.resolve({ kind: "documents", documents: [{ _id: { $oid: "000000000000000000000001" }, active: true }], nextCursor: "signed-page" }); } });
    const result = await db.query(collection("products").query().limit(1).build());
    expect(requests[0]).toEqual({ kind: "find", collection: "products", filter: {}, limit: 1 });
    expect(result.nextCursor).toEqual({ values: ["signed-page"] });
    expect(result.records[0]?.key.id).toBe("000000000000000000000001");
  });

  it("refuses unsupported key identities and writes before executing", async () => {
    const execute = vi.fn((): Promise<MongoReadResult> => Promise.resolve({ kind: "documents", documents: [] }));
    const db = new MongoDatabase({ execute });
    await expect(db.get(new Key("products", 42))).rejects.toThrow("keys require");
    await expect(db.runReadwriteTransaction(() => Promise.resolve())).rejects.toThrow("read-only");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not return a core query page after transport fulfillment races caller cancellation", async () => {
    const controller = new AbortController();
    const db = new MongoDatabase({ execute: () => {
      const pending = Promise.resolve<MongoReadResult>({ kind: "documents", documents: [] });
      // This callback runs before the facade continuation registered by await.
      void pending.then(() => { controller.abort("redacted"); });
      return pending;
    } });
    await expect(db.queryWithSignal(collection("products").query().limit(1).build(), controller.signal)).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
  });
});
