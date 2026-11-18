import { BatchGetItemCommand, GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeDynamoDbDatabase, NativeDynamoDbError, type NativeDynamoDbClientLike, type NativeDynamoDbItem, type NativeDynamoDbOptions, type NativeDynamoDbQuery } from "../src/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const options: NativeDynamoDbOptions = { tables: { items: { tableName: "existing-items", partitionKey: { name: "id", type: "S" }, indexes: {
  rank: { indexName: "rank-index", kind: "gsi", partitionKey: { name: "group", type: "S" }, sortKey: { name: "rank", type: "N" }, projection: ["label"] },
} } } };
function setup(change: Partial<NativeDynamoDbOptions> = {}) {
  const send = vi.fn<NativeDynamoDbClientLike["send"]>();
  const db = new NativeDynamoDbDatabase({ send }, { ...options, ...change });
  return { db, send };
}
function indexed(id: string, rank = "7"): NativeDynamoDbItem { return { id: { S: id }, group: { S: "tenant" }, rank: { N: rank }, label: { S: id } }; }
const indexedQuery = (): NativeDynamoDbQuery => ({ collection: "items", index: "rank", partition: { S: "tenant" }, limit: 1 });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("native existing DynamoDB tables", () => {
  it("does no constructor IO, snapshots configuration and reports configured metadata only", async () => {
    const config: NativeDynamoDbOptions = { tables: { items: { tableName: "existing-items", partitionKey: { name: "id", type: "S" } } } };
    const { send } = setup(); const db = new NativeDynamoDbDatabase({ send }, config);
    expect(send).not.toHaveBeenCalled();
    Object.assign(config.tables.items ?? {}, { tableName: "changed-table" });
    send.mockResolvedValueOnce({}); await expect(db.get("items", { id: { S: "a" } })).resolves.toBeNull();
    const command = send.mock.calls[0]?.[0]; if (!(command instanceof GetItemCommand)) throw new Error("expected GetItem");
    expect(command.input.TableName).toBe("existing-items");
    expect(db.configuredTables().items?.tableName).toBe("existing-items");
    expect(Object.isFrozen(db.configuredTables())).toBe(true);
  });

  it("preserves all AV tags and owns returned binary and nested values", async () => {
    const { db, send } = setup(); const binary = new Uint8Array([0, 255, 128]);
    const item = { id: { S: "a" }, exact: { N: "9007199254740993.000" }, bytes: { B: binary }, flag: { BOOL: false }, empty: { NULL: true },
      ss: { SS: ["", "x"] }, ns: { NS: ["1.00", "9007199254740993"] }, bs: { BS: [new Uint8Array(), new Uint8Array([255])] },
      list: { L: [{ S: "" }, { M: {} }] }, map: { M: { empty: { L: [] } } } };
    send.mockResolvedValueOnce({ Item: item }); const result = await db.get("items", { id: { S: "a" } });
    expect(result).toEqual(item); binary[0] = 99; item.ns.NS[0] = "changed";
    expect(result?.bytes).toEqual({ B: new Uint8Array([0, 255, 128]) }); expect(result?.ns).toEqual({ NS: ["1.00", "9007199254740993"] });
  });

  it("uses native N and B/composite keys without a managed envelope or numeric coercion", async () => {
    const { db, send } = setup({ tables: { items: { tableName: "existing-items", partitionKey: { name: "pk", type: "N" }, sortKey: { name: "sk", type: "B" } } } });
    const bytes = new Uint8Array([0, 255]); const held = deferred<unknown>(); const entered = deferred<undefined>();
    send.mockImplementationOnce(() => { entered.resolve(undefined); return held.promise; });
    const result = db.get("items", { pk: { N: "1" }, sk: { B: bytes } }); await entered.promise; bytes[0] = 90;
    const command = send.mock.calls[0]?.[0]; if (!(command instanceof GetItemCommand)) throw new Error("expected GetItem");
    expect(command.input.Key).toEqual({ pk: { N: "1" }, sk: { B: new Uint8Array([0, 255]) } });
    held.resolve({ Item: { pk: { N: "1.0" }, sk: { B: new Uint8Array([0, 255]) } } });
    await expect(result).resolves.toEqual({ pk: { N: "1.0" }, sk: { B: new Uint8Array([0, 255]) } });
    await expect(db.get("items", { pk: { N: "1" } })).rejects.toBeInstanceOf(NativeDynamoDbError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses identity-only projection for exists and rejects foreign point identities", async () => {
    const { db, send } = setup(); send.mockResolvedValueOnce({});
    await expect(db.exists("items", { id: { S: "a" } })).resolves.toBe(false);
    send.mockResolvedValueOnce({ Item: { id: { S: "a" } } });
    await expect(db.exists("items", { id: { S: "a" } })).resolves.toBe(true);
    const command = send.mock.calls[1]?.[0]; if (!(command instanceof GetItemCommand)) throw new Error("expected GetItem");
    expect(command.input.ProjectionExpression).toBe("#a0"); expect(command.input.ExpressionAttributeNames).toEqual({ "#a0": "id" });
    send.mockResolvedValueOnce({ Item: { id: { S: "foreign" } } });
    await expect(db.get("items", { id: { S: "a" } })).rejects.toBeInstanceOf(NativeDynamoDbError);
  });

  it("deduplicates 101 logical batch requests and reconstructs unordered missing results", async () => {
    const { db, send } = setup(); send.mockResolvedValueOnce({ Responses: { "existing-items": [{ id: { S: "b" } }, { id: { S: "a" } }] } });
    const keys = Array.from({ length: 101 }, (_, index) => ({ id: { S: index % 3 === 0 ? "missing" : index % 2 === 0 ? "b" : "a" } }));
    const result = await db.getMany("items", keys); expect(result).toHaveLength(101);
    const command = send.mock.calls[0]?.[0]; if (!(command instanceof BatchGetItemCommand)) throw new Error("expected BatchGetItem");
    expect(command.input.RequestItems?.["existing-items"]?.Keys).toHaveLength(3);
    expect(result.map((row) => row?.id ?? null)).toEqual(keys.map((key) => key.id.S === "missing" ? null : key.id));
    await expect(db.getMany("items", Array.from({ length: 101 }, (_, index) => ({ id: { S: String(index) } })))).rejects.toBeInstanceOf(NativeDynamoDbError);
    await expect(db.getMany("items", [])).resolves.toEqual([]); expect(send).toHaveBeenCalledTimes(1);
  });

  it("fails whole batches for unprocessed, foreign and duplicate SDK replies", async () => {
    for (const output of [
      { Responses: { "existing-items": [{ id: { S: "a" } }] }, UnprocessedKeys: { "existing-items": { Keys: [{ id: { S: "a" } }] } } },
      { Responses: { foreign: [] } }, { Responses: { "existing-items": [{ id: { S: "foreign" } }] } },
      { Responses: { "existing-items": [{ id: { S: "a" } }, { id: { S: "a" } }] } },
    ]) { const { db, send } = setup(); send.mockResolvedValueOnce(output); await expect(db.getMany("items", [{ id: { S: "a" } }])).rejects.toBeInstanceOf(NativeDynamoDbError); expect(send).toHaveBeenCalledTimes(1); }
  });

  it("charges logical duplicate expansion instead of returning an unbounded batch", async () => {
    const { db, send } = setup({ maxReadBytes: 3000 }); send.mockImplementation(() => Promise.resolve({ Responses: { "existing-items": [{ id: { S: "a" }, text: { S: "x".repeat(800) } }] } }));
    await expect(db.getMany("items", [{ id: { S: "a" } }])).resolves.toHaveLength(1);
    await expect(db.getMany("items", [{ id: { S: "a" } }, { id: { S: "a" } }])).rejects.toMatchObject({ code: "limit" });
  });

  it("allows legal GSI sort ties across an instance-bound cursor and rejects scope changes", async () => {
    const { db, send } = setup(); const last = { id: { S: "a" }, group: { S: "tenant" }, rank: { N: "7" } };
    send.mockResolvedValueOnce({ Items: [indexed("a")], Count: 1, ScannedCount: 1, LastEvaluatedKey: last });
    const first = await db.queryPartition(indexedQuery()); if (first.nextCursor === undefined) throw new Error("expected cursor");
    const query = send.mock.calls[0]?.[0]; if (!(query instanceof QueryCommand)) throw new Error("expected Query");
    expect(query.input.IndexName).toBe("rank-index"); expect(query.input.ConsistentRead).toBe(false);
    expect(query.input.ExpressionAttributeValues).toEqual({ ":p": { S: "tenant" } });
    await expect(db.queryPartition({ ...indexedQuery(), partition: { S: "foreign" }, cursor: first.nextCursor })).rejects.toMatchObject({ code: "request" });
    const other = setup(); await expect(other.db.queryPartition({ ...indexedQuery(), cursor: first.nextCursor })).rejects.toMatchObject({ code: "request" }); expect(other.send).not.toHaveBeenCalled();
    send.mockResolvedValueOnce({ Items: [indexed("b", "7.0")], Count: 1, ScannedCount: 1 });
    await expect(db.queryPartition({ ...indexedQuery(), cursor: first.nextCursor })).resolves.toMatchObject({ items: [indexed("b", "7.0")] });
    send.mockResolvedValueOnce({ Items: [indexed("a")], Count: 1, ScannedCount: 1 });
    await expect(db.queryPartition({ ...indexedQuery(), cursor: first.nextCursor })).rejects.toBeInstanceOf(NativeDynamoDbError);
  });

  it("refuses GSI strong reads and nonprojected attributes before SDK credentials", async () => {
    const { db, send } = setup();
    for (const query of [{ ...indexedQuery(), consistentRead: true }, { ...indexedQuery(), projection: ["not-projected"] }]) await expect(db.queryPartition(query)).rejects.toMatchObject({ code: "request" });
    expect(send).not.toHaveBeenCalled();
    const metadata = db.configuredTables().items?.indexes?.rank;
    expect(metadata?.kind).toBe("gsi"); expect(metadata?.projection).toEqual(["label"]);
  });

  it("keeps LSI strong reads local to configured projected attributes", async () => {
    const { db, send } = setup({ tables: { items: { tableName: "existing-items", partitionKey: { name: "tenant", type: "S" }, sortKey: { name: "id", type: "S" }, consistentRead: true,
      indexes: { local: { indexName: "local-rank", kind: "lsi", partitionKey: { name: "tenant", type: "S" }, sortKey: { name: "rank", type: "N" }, projection: "KEYS_ONLY" } } } } });
    send.mockResolvedValueOnce({ Items: [{ tenant: { S: "x" }, id: { S: "a" }, rank: { N: "1" } }], Count: 1, ScannedCount: 1 });
    await expect(db.queryPartition({ collection: "items", index: "local", partition: { S: "x" }, limit: 1 })).resolves.toMatchObject({ items: [{ id: { S: "a" } }] });
    const command = send.mock.calls[0]?.[0]; if (!(command instanceof QueryCommand)) throw new Error("expected Query"); expect(command.input.ConsistentRead).toBe(true);
    await expect(db.queryPartition({ collection: "items", index: "local", partition: { S: "x" }, projection: ["label"], limit: 1 })).rejects.toMatchObject({ code: "request" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("compares string sort keys in UTF-8 order and native decimals mathematically", async () => {
    const { db, send } = setup({ tables: { items: { tableName: "existing-items", partitionKey: { name: "pk", type: "S" }, sortKey: { name: "sk", type: "S" } } } });
    const rows = [{ pk: { S: "x" }, sk: { S: "\ue000" } }, { pk: { S: "x" }, sk: { S: "😀" } }];
    send.mockResolvedValueOnce({ Items: rows, Count: 2, ScannedCount: 2 });
    await expect(db.queryPartition({ collection: "items", partition: { S: "x" }, limit: 2 })).resolves.toMatchObject({ items: rows });
    send.mockResolvedValueOnce({ Items: [...rows].reverse(), Count: 2, ScannedCount: 2 });
    await expect(db.queryPartition({ collection: "items", partition: { S: "x" }, limit: 2 })).rejects.toBeInstanceOf(NativeDynamoDbError);
    const numeric = setup({ tables: { items: { tableName: "existing-items", partitionKey: { name: "id", type: "N" } } } });
    numeric.send.mockResolvedValueOnce({ Responses: { "existing-items": [{ id: { N: "1.000" } }] } });
    await expect(numeric.db.getMany("items", [{ id: { N: "1" } }, { id: { N: "1.0" } }])).resolves.toHaveLength(2);
    const command = numeric.send.mock.calls[0]?.[0]; if (!(command instanceof BatchGetItemCommand)) throw new Error("expected BatchGetItem"); expect(command.input.RequestItems?.["existing-items"]?.Keys).toHaveLength(1);
  });

  it("continues empty pages but refuses repeated/foreign cursors and count overreturn", async () => {
    const { db, send } = setup(); const key = { id: { S: "a" }, group: { S: "tenant" }, rank: { N: "1" } };
    send.mockResolvedValueOnce({ Items: [], Count: 0, ScannedCount: 1, LastEvaluatedKey: key });
    send.mockResolvedValueOnce({ Items: [indexed("b", "2")], Count: 1, ScannedCount: 1 });
    await expect(db.queryPartition(indexedQuery())).resolves.toMatchObject({ pages: 2, evaluated: 2, items: [indexed("b", "2")] });
    const repeated = setup(); repeated.send.mockResolvedValue({ Items: [], Count: 0, ScannedCount: 1, LastEvaluatedKey: key });
    await expect(repeated.db.queryPartition(indexedQuery())).rejects.toBeInstanceOf(NativeDynamoDbError); expect(repeated.send).toHaveBeenCalledTimes(2);
    for (const output of [{ Items: [], Count: 1, ScannedCount: 1 }, { Items: [indexed("a"), indexed("b")], Count: 2, ScannedCount: 2 }, { Items: [], Count: 0, ScannedCount: 1, LastEvaluatedKey: { ...key, group: { S: "foreign" } } }]) {
      const invalid = setup(); invalid.send.mockResolvedValueOnce(output); await expect(invalid.db.queryPartition(indexedQuery())).rejects.toBeInstanceOf(NativeDynamoDbError);
    }
  });

  it("bounds page/evaluated work even when no matching records are delivered", async () => {
    const { db, send } = setup({ maxPages: 1 }); send.mockResolvedValue({ Items: [], Count: 0, ScannedCount: 0, LastEvaluatedKey: { id: { S: "a" }, group: { S: "tenant" }, rank: { N: "1" } } });
    await expect(db.queryPartition(indexedQuery())).rejects.toMatchObject({ code: "limit" }); expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses raw/unknown query routes and oversized keys without an SDK call", async () => {
    const { db, send } = setup();
    await expect(db.queryPartition({ ...indexedQuery(), index: "not-configured" })).rejects.toBeInstanceOf(NativeDynamoDbError);
    await expect(db.queryPartition(Object.assign(indexedQuery(), { FilterExpression: "private-raw-expression" }))).rejects.toBeInstanceOf(NativeDynamoDbError);
    await expect(db.get("items", { id: { S: "x".repeat(2049) } })).rejects.toBeInstanceOf(NativeDynamoDbError);
    await expect(db.get("items", { id: { S: "\ud800" } })).rejects.toBeInstanceOf(NativeDynamoDbError);
    expect(send).not.toHaveBeenCalled();
  });

  it("fails whole malformed deep documents and inconsistent configured index key types", async () => {
    const { db, send } = setup(); let value: unknown = { S: "leaf" };
    for (let depth = 0; depth < 34; depth += 1) value = { M: { child: value } };
    send.mockResolvedValueOnce({ Item: { id: { S: "a" }, value } });
    await expect(db.get("items", { id: { S: "a" } })).rejects.toMatchObject({ code: "limit" });
    expect(() => new NativeDynamoDbDatabase({ send }, { tables: { items: { tableName: "existing-items", partitionKey: { name: "id", type: "S" }, indexes: {
      bad: { indexName: "bad-index", kind: "gsi", partitionKey: { name: "id", type: "N" }, projection: "ALL" },
    } } } })).toThrow(NativeDynamoDbError);
  });

  it("rejects invalid unions, numbers, accessors and binary subclasses without calling them", async () => {
    const getter = vi.fn(() => "a");
    const key = Object.defineProperty({}, "id", { enumerable: true, get: getter });
    const { db, send } = setup(); await expect(db.get("items", key)).rejects.toBeInstanceOf(NativeDynamoDbError); expect(getter).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    class CustomBytes extends Uint8Array {}
    const binary = setup({ tables: { items: { tableName: "existing-items", partitionKey: { name: "id", type: "B" } } } });
    const custom = Object.defineProperty(new CustomBytes([1]), "byteLength", { get: getter });
    await expect(binary.db.get("items", { id: { B: custom } })).rejects.toBeInstanceOf(NativeDynamoDbError); expect(getter).not.toHaveBeenCalled();
    for (const value of [{ N: "NaN" }, { N: "1e126" }, { N: "1e-131" }, { N: "1".repeat(39) }, { NULL: false }, { NS: ["1", "1.0"] }, { UNKNOWN: "private-provider-detail" }]) {
      send.mockResolvedValueOnce({ Item: { id: { S: "a" }, value } }); await expect(db.get("items", { id: { S: "a" } })).rejects.toBeInstanceOf(NativeDynamoDbError);
    }
  });

  it("retains ignored SDK leases until actual settlement, then admits a new read", async () => {
    const { db, send } = setup({ maxConcurrent: 1, timeoutMs: 10 }); const held = deferred<unknown>(); const entered = deferred<undefined>();
    send.mockImplementationOnce(() => { entered.resolve(undefined); return held.promise; });
    const caller = new AbortController(); const first = expect(db.getWithSignal("items", { id: { S: "a" } }, caller.signal)).rejects.toMatchObject({ reason: "caller" });
    await entered.promise; caller.abort("private-cause"); await first;
    vi.useFakeTimers(); const queued = expect(db.get("items", { id: { S: "b" } })).rejects.toMatchObject({ reason: "deadline" });
    await vi.advanceTimersByTimeAsync(10); await queued; expect(send).toHaveBeenCalledTimes(1);
    held.reject(new Error("private-late-sdk-error")); await Promise.resolve(undefined); await Promise.resolve(undefined); vi.useRealTimers();
    send.mockResolvedValueOnce({}); await expect(db.get("items", { id: { S: "c" } })).resolves.toBeNull();
  });

  it("observes cancellation between admission and SDK dispatch without orphaning a rejection", async () => {
    const { db, send } = setup({ maxConcurrent: 1 }); const caller = new AbortController();
    queueMicrotask(() => { caller.abort("private-admission-cause"); });
    await expect(db.getWithSignal("items", { id: { S: "a" } }, caller.signal)).rejects.toMatchObject({ reason: "caller" });
    expect(send).not.toHaveBeenCalled();
    send.mockResolvedValueOnce({}); await expect(db.get("items", { id: { S: "b" } })).resolves.toBeNull();
  });

  it("checks monotonic elapsed time after SDK completion and cancels only owned scopes", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const { db, send } = setup({ timeoutMs: 10 }); send.mockImplementationOnce(() => { now = 11; return Promise.resolve({}); });
    await expect(db.get("items", { id: { S: "a" } })).rejects.toMatchObject({ reason: "deadline" });
    now = 0; const held = deferred<unknown>(); const entered = deferred<undefined>();
    send.mockImplementationOnce(() => { entered.resolve(undefined); return held.promise; });
    const work = expect(db.get("items", { id: { S: "b" } })).rejects.toBeInstanceOf(QueryCancelledError);
    await entered.promise; db.close(); await work; expect(send.mock.calls[1]?.[1]?.abortSignal?.aborted).toBe(true);
    held.resolve({}); await expect(db.get("items", { id: { S: "c" } })).rejects.toMatchObject({ code: "closed" });
  });
});
