import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { describe, expect, it, vi } from "vitest";
import { NativeDynamoDbDatabase, type NativeDynamoDbClientLike, type NativeDynamoDbOptions, type NativeDynamoDbQuery } from "../src/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(value: unknown) {
  return { response: { statusCode: 200, headers: { "content-type": "application/x-amz-json-1.0" }, body: new TextEncoder().encode(JSON.stringify(value)) } };
}
function httpRequest(value: unknown): { body: string; headers: Record<string, string>; hostname: string } {
  if (value === null || typeof value !== "object") throw new Error("fixture requires HTTP request");
  const body: unknown = Reflect.get(value, "body"); const headers: unknown = Reflect.get(value, "headers"); const hostname: unknown = Reflect.get(value, "hostname");
  if (typeof hostname !== "string" || headers === null || typeof headers !== "object") throw new Error("fixture requires JSON HTTP request");
  // Official AWS JsonBytesStringAdapter extends Uint8Array; accept its actual
  // UTF-8 bytes without invoking arbitrary object string conversion.
  let jsonBody: string;
  if (typeof body === "string") {
    if (new TextEncoder().encode(body).byteLength > 8192) throw new Error("fixture request body too large");
    jsonBody = body;
  } else if (body instanceof Uint8Array && body.byteLength <= 8192) {
    jsonBody = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } else throw new Error("fixture requires string or byte JSON body");
  const copied: Record<string, string> = {};
  for (const name of Object.keys(headers)) {
    const content: unknown = Reflect.get(headers, name); if (typeof content !== "string") throw new Error("fixture requires string headers"); copied[name] = content;
  }
  return { body: jsonBody, headers: copied, hostname };
}
const config: NativeDynamoDbOptions = { tables: { native: { tableName: "existing", partitionKey: { name: "pk", type: "N" }, sortKey: { name: "sk", type: "B" }, indexes: {
  byRank: { indexName: "by-rank", kind: "gsi", partitionKey: { name: "group", type: "S" }, sortKey: { name: "rank", type: "N" }, projection: ["payload"] },
} } }, timeoutMs: 1000 };
const wire = (key = "AP8=") => ({ pk: { N: "9007199254740993" }, sk: { B: key }, group: { S: "tenant" }, rank: { N: "7.000" }, payload: { M: {
  decimal: { N: "123456789012345678901234567890.0001" }, bytes: { B: "AP+A" }, strings: { SS: ["a", "b"] }, numbers: { NS: ["1.00", "2"] },
  binaries: { BS: ["AP8=", "AQ=="] }, list: { L: [{ BOOL: false }, { NULL: true }, { S: "" }] },
} } });

describe("native DynamoDB official SDK protocol boundary", () => {
  it("uses the low-level signed SDK with exact AV binary/numbers and index cursor keys", async () => {
    const calls: { target: string; body: Record<string, unknown> }[] = [];
    const sdk = new DynamoDBClient({ region: "us-east-1", endpoint: "https://owned.invalid", credentials: { accessKeyId: "owned-access", secretAccessKey: "owned-secret" }, maxAttempts: 1,
      requestHandler: { handle(input: unknown) {
        const request = httpRequest(input);
        const body: unknown = JSON.parse(request.body);
        if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("fixture requires object");
        const parsed = body as Record<string, unknown>; const target = request.headers["x-amz-target"] ?? "";
        expect(request.headers.authorization).toContain("AWS4-HMAC-SHA256"); expect(request.hostname).toBe("owned.invalid");
        expect(parsed.TableName ?? Object.keys(parsed.RequestItems ?? {})[0]).toBe("existing");
        calls.push({ target, body: parsed });
        if (target === "DynamoDB_20120810.GetItem") return Promise.resolve(response({ Item: wire() }));
        if (target === "DynamoDB_20120810.BatchGetItem") return Promise.resolve(response({ Responses: { existing: [wire()] } }));
        expect(target).toBe("DynamoDB_20120810.Query"); expect(parsed.IndexName).toBe("by-rank"); expect(parsed.ConsistentRead).toBe(false);
        expect(parsed.ExpressionAttributeValues).toEqual({ ":p": { S: "tenant" } });
        if (parsed.ExclusiveStartKey === undefined) return Promise.resolve(response({ Items: [wire()], Count: 1, ScannedCount: 1, LastEvaluatedKey: { pk: { N: "9007199254740993" }, sk: { B: "AP8=" }, group: { S: "tenant" }, rank: { N: "7" } } }));
        expect(parsed.ExclusiveStartKey).toEqual({ pk: { N: "9007199254740993" }, sk: { B: "AP8=" }, group: { S: "tenant" }, rank: { N: "7" } });
        return Promise.resolve(response({ Items: [wire("AQ==")], Count: 1, ScannedCount: 1 }));
      } } });
    const borrowed: NativeDynamoDbClientLike = sdk;
    const destroy = vi.spyOn(sdk, "destroy"); const db = new NativeDynamoDbDatabase(borrowed, config);
    try {
      const key = { pk: { N: "9007199254740993" }, sk: { B: new Uint8Array([0, 255]) } };
      const item = await db.get("native", key);
      expect(item?.pk).toEqual({ N: "9007199254740993" }); expect(item?.sk).toEqual({ B: new Uint8Array([0, 255]) });
      expect(item?.payload).toEqual({ M: { decimal: { N: "123456789012345678901234567890.0001" }, bytes: { B: new Uint8Array([0, 255, 128]) }, strings: { SS: ["a", "b"] }, numbers: { NS: ["1.00", "2"] }, binaries: { BS: [new Uint8Array([0, 255]), new Uint8Array([1])] }, list: { L: [{ BOOL: false }, { NULL: true }, { S: "" }] } } });
      await expect(db.getMany("native", [key, key])).resolves.toHaveLength(2);
      const query: NativeDynamoDbQuery = { collection: "native", index: "byRank", partition: { S: "tenant" }, limit: 1 };
      const first = await db.queryPartition(query); if (first.nextCursor === undefined) throw new Error("expected cursor");
      const next = await db.queryPartition({ ...query, cursor: first.nextCursor }); expect(next.items[0]?.sk).toEqual({ B: new Uint8Array([1]) });
      expect(calls).toHaveLength(4); expect(calls[0]?.body.Key).toEqual({ pk: { N: "9007199254740993" }, sk: { B: "AP8=" } });
      db.close(); expect(destroy).not.toHaveBeenCalled();
    } finally { sdk.destroy(); }
  });

  it("bounds credential waiting, observes late failure and never destroys the borrowed SDK", async () => {
    const entered = deferred<undefined>(); const credentials = deferred<{ accessKeyId: string; secretAccessKey: string }>(); const handler = vi.fn();
    const sdk = new DynamoDBClient({ region: "us-east-1", endpoint: "https://owned.invalid", credentials: () => { entered.resolve(undefined); return credentials.promise; }, maxAttempts: 1,
      requestHandler: { handle() { handler(); return Promise.resolve(response({})); } } });
    const destroy = vi.spyOn(sdk, "destroy"); const db = new NativeDynamoDbDatabase(sdk, config); const caller = new AbortController();
    const work = expect(db.getWithSignal("native", { pk: { N: "1" }, sk: { B: new Uint8Array([1]) } }, caller.signal)).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
    try {
      await entered.promise; caller.abort("private-credential-cause"); await work; expect(handler).not.toHaveBeenCalled();
      credentials.reject(new Error("private-late-credential")); await Promise.resolve(undefined); await Promise.resolve(undefined);
      db.close(); expect(destroy).not.toHaveBeenCalled();
    } finally { sdk.destroy(); }
  });

  it("cancels only after actual SDK handler dispatch, acknowledges abort and reads again", async () => {
    for (const deadline of [false, true]) {
      const entered = deferred<undefined>(); const aborted = deferred<undefined>(); let first = true;
      const sdk = new DynamoDBClient({ region: "us-east-1", endpoint: "https://owned.invalid", credentials: { accessKeyId: "owned", secretAccessKey: "synthetic" }, maxAttempts: 1,
        requestHandler: { handle(_request: unknown, options?: { readonly abortSignal?: unknown }) {
          if (!first) return Promise.resolve(response({})); first = false;
          const signal = options?.abortSignal; if (!(signal instanceof AbortSignal)) throw new Error("fixture requires live abort signal");
          expect(signal.aborted).toBe(false);
          return new Promise<never>((_, reject) => { signal.addEventListener("abort", () => { aborted.resolve(undefined); reject(new Error("private-handler-cause")); }, { once: true }); entered.resolve(undefined); });
        } } });
      const db = new NativeDynamoDbDatabase(sdk, { ...config, timeoutMs: deadline ? 100 : 1000 }); const caller = new AbortController();
      const work = expect(db.getWithSignal("native", { pk: { N: "1" }, sk: { B: new Uint8Array([1]) } }, caller.signal)).rejects.toMatchObject({ name: "QueryCancelledError", reason: deadline ? "deadline" : "caller" });
      try {
        await entered.promise; if (!deadline) caller.abort(new Error("private-caller")); await work; await aborted.promise;
        await expect(db.get("native", { pk: { N: "1" }, sk: { B: new Uint8Array([1]) } })).resolves.toBeNull();
        expect(new QueryCancelledError("caller")).not.toHaveProperty("cause");
      } finally { db.close(); sdk.destroy(); }
    }
  });
});
