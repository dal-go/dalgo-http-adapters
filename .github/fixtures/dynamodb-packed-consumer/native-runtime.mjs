// Actual installed SOURCE tarball + official LOW-LEVEL SDK request handler.
// No HTTP service, DynamoDB Local, AWS, IAM or hosted browser/CORS proof.
import assert from "node:assert/strict";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { NativeDynamoDbDatabase, NativeDynamoDbError } from "@dal-go/dalgo2dynamodb";

function gate() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function bounded(promise, ms = 3000) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned native SDK fixture deadline")), ms); })]); } finally { clearTimeout(timer); } }
const credentials = { accessKeyId: "NATIVEFIXTUREKEY", secretAccessKey: "synthetic-native-fixture-secret", sessionToken: "synthetic-native-session" };
const key = bytes => ({ pk: { N: "9007199254740993" }, sk: { B: new Uint8Array(bytes) } });
const wireKey = bytes => ({ pk: { N: "9007199254740993" }, sk: { B: Buffer.from(bytes).toString("base64") } });
const union = bytes => ({ ...wireKey(bytes), group: { S: "tenant" }, rank: { N: "7" } });
const wire = bytes => ({ ...wireKey(bytes), group: { S: "tenant" }, rank: { N: "7.000" }, payload: { M: {
  decimal: { N: "123456789012345678901234567890.0001" }, bytes: { B: "AP+A" }, strings: { SS: ["a", "b"] }, numbers: { NS: ["1.00", "2"] }, binaries: { BS: ["AP8=", "AQ=="] }, list: { L: [{ BOOL: false }, { NULL: true }, { S: "" }] },
} } });
const response = value => ({ response: { statusCode: 200, headers: { "content-type": "application/x-amz-json-1.0", "x-amzn-requestid": "owned-native-fixture" }, body: new TextEncoder().encode(JSON.stringify(value)) } });
const config = { tables: { native: { tableName: "existing-native", partitionKey: { name: "pk", type: "N" }, sortKey: { name: "sk", type: "B" }, indexes: { byRank: { indexName: "by-rank", kind: "gsi", partitionKey: { name: "group", type: "S" }, sortKey: { name: "rank", type: "N" }, projection: ["payload"] } } } }, timeoutMs: 2000, maxRecords: 1000, maxReadBytes: 4000000, maxPages: 10, maxEvaluated: 100, pageSize: 1 };

export async function verifyNativePackedConsumer() {
  let calls = 0, destroys = 0, unprocessed = false, duplicateBase = false, badUnion = false, dispatch, acknowledge;
  const active = new Set(), controllers = new Set(), databases = [], work = [];
  const handler = { metadata: { handlerProtocol: "http/1.1" }, destroy() { destroys++; throw new Error("borrowed native handler destroyed"); }, async handle(request, options) {
    calls++;
    const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
    assert.equal(Object.keys(headers).length, Object.keys(request.headers).length);
    assert.equal(request.hostname, "owned-native.invalid"); assert.equal(request.protocol, "https:"); assert.equal(request.method, "POST"); assert.equal(request.path, "/");
    assert.equal(headers["content-type"], "application/x-amz-json-1.0"); assert.equal(headers.cookie, undefined);
    assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=NATIVEFIXTUREKEY\/[0-9]{8}\/us-east-1\/dynamodb\/aws4_request,/u);
    assert.equal(headers["x-amz-security-token"], credentials.sessionToken);
    // The pinned official SDK's lazy JsonBytesStringAdapter is Uint8Array.
    // Admit only actual encoded bytes/string, never arbitrary object coercion.
    assert.ok(typeof request.body === "string" || request.body instanceof Uint8Array);
    assert.ok((typeof request.body === "string" ? Buffer.byteLength(request.body) : request.body.byteLength) <= 8192);
    const encoded = typeof request.body === "string" ? request.body : new TextDecoder("utf-8", { fatal: true }).decode(request.body);
    const body = JSON.parse(encoded); const target = headers["x-amz-target"];
    assert.equal(body.TableName ?? Object.keys(body.RequestItems ?? {})[0], "existing-native");
    if (target === "DynamoDB_20120810.GetItem") {
      assert.equal(body.Key.pk.N, "9007199254740993");
      if (body.Key.sk.B === "Yw==") {
        assert.ok(options.abortSignal instanceof AbortSignal); assert.equal(options.abortSignal.aborted, false);
        const pending = gate(); let stopped = false;
        const abort = () => { entry.stop(); acknowledge?.(); };
        const entry = { stop() { if (stopped) return; stopped = true; options.abortSignal.removeEventListener("abort", abort); active.delete(entry); pending.reject(new Error("synthetic-native-handler-cause")); } };
        active.add(entry); options.abortSignal.addEventListener("abort", abort, { once: true }); dispatch?.(); return await pending.promise;
      }
      assert.deepEqual(body.Key, wireKey([0,255])); return response({ Item: wire([0,255]) });
    }
    if (target === "DynamoDB_20120810.BatchGetItem") {
      const keys = body.RequestItems["existing-native"].Keys;
      const identities = keys.map(value => JSON.stringify(value)); assert.equal(new Set(identities).size, keys.length);
      if (unprocessed) { unprocessed = false; return response({ Responses: { "existing-native": [] }, UnprocessedKeys: { "existing-native": { Keys: [wireKey([0,255])] } } }); }
      if (keys.length === 1) { assert.deepEqual(keys, [wireKey([0,255])]); return response({ Responses: { "existing-native": [wire([0,255])] } }); }
      assert.equal(keys.length, 3); assert.deepEqual(keys, [wireKey([0,255]), wireKey([2]), wireKey([1])]);
      return response({ Responses: { "existing-native": [wire([1]), wire([0,255])] } });
    }
    assert.equal(target, "DynamoDB_20120810.Query"); assert.equal(body.IndexName, "by-rank"); assert.equal(body.ConsistentRead, false); assert.equal(body.ScanIndexForward, true);
    assert.equal(body.KeyConditionExpression, "#p = :p"); assert.deepEqual(body.ExpressionAttributeValues, { ":p": { S: "tenant" } }); assert.equal(body.Limit, 1);
    assert.deepEqual(new Set(Object.values(body.ExpressionAttributeNames)), new Set(["payload", "pk", "sk", "group", "rank"]));
    assert.equal(body.ProjectionExpression.split(", ").length, 5);
    if (body.ExclusiveStartKey === undefined) return response({ Items: [], Count: 0, ScannedCount: 1, LastEvaluatedKey: union([0]) });
    if (body.ExclusiveStartKey.sk.B === "AA==") { assert.deepEqual(body.ExclusiveStartKey, union([0])); return response({ Items: [wire([0,255])], Count: 1, ScannedCount: 1, LastEvaluatedKey: badUnion ? wireKey([0,255]) : union([0,255]) }); }
    assert.deepEqual(body.ExclusiveStartKey, union([0,255])); return response({ Items: [wire(duplicateBase ? [0,255] : [1])], Count: 1, ScannedCount: 1 });
  } };
  const sdk = new DynamoDBClient({ region: "us-east-1", endpoint: "https://owned-native.invalid", credentials, maxAttempts: 1, requestHandler: handler });
  const create = (extra = {}, client = sdk) => { const db = new NativeDynamoDbDatabase(client, { ...config, ...extra }); databases.push(db); return db; };
  const db = create(); const a = key([0,255]); const query = { collection: "native", index: "byRank", partition: { S: "tenant" }, limit: 1 };
  try {
    assert.equal(calls, 0); assert.equal(db.configuredTables().native.tableName, "existing-native"); assert.equal(calls, 0);
    const item = await bounded(db.get("native", a)); assert.deepEqual(item.pk, { N: "9007199254740993" }); assert.deepEqual(item.sk, { B: new Uint8Array([0,255]) });
    assert.deepEqual(item.payload, { M: { decimal: { N: "123456789012345678901234567890.0001" }, bytes: { B: new Uint8Array([0,255,128]) }, strings: { SS: ["a","b"] }, numbers: { NS: ["1.00","2"] }, binaries: { BS: [new Uint8Array([0,255]),new Uint8Array([1])] }, list: { L: [{ BOOL: false },{ NULL: true },{ S: "" }] } } });
    const rows = await bounded(db.getMany("native", [a, key([2]), a, key([1])])); assert.deepEqual(rows.map(value => value?.sk.B ?? null), [new Uint8Array([0,255]),null,new Uint8Array([0,255]),new Uint8Array([1])]);
    assert.notEqual(rows[0], rows[2]); assert.notEqual(rows[0].sk.B, rows[2].sk.B); rows[0].sk.B[0] = 42; assert.equal(rows[2].sk.B[0], 0);
    const duplicates = await bounded(db.getMany("native", Array.from({ length: 101 }, () => a))); assert.equal(duplicates.length, 101); assert.ok(duplicates.every(value => value.pk.N === "9007199254740993"));
    unprocessed = true; const beforeUnprocessed = calls; await assert.rejects(bounded(db.getMany("native", [a])), error => error instanceof NativeDynamoDbError && error.code === "unprocessed"); assert.equal(calls, beforeUnprocessed + 1);
    const first = await bounded(db.queryPartition(query)); assert.equal(first.items.length, 1); assert.equal(first.pages, 2); assert.equal(first.evaluated, 2); assert.ok(first.nextCursor); assert.equal(first.items[0].rank.N, "7.000");
    const beforeRefusal = calls;
    await assert.rejects(create().queryPartition({ ...query, cursor: first.nextCursor }), error => error instanceof NativeDynamoDbError && error.code === "request");
    await assert.rejects(db.queryPartition({ ...query, partition: { S: "other" }, cursor: first.nextCursor }), error => error instanceof NativeDynamoDbError && error.code === "request");
    await assert.rejects(db.queryPartition({ ...query, projection: ["not-projected"] }), error => error instanceof NativeDynamoDbError && error.code === "request");
    await assert.rejects(db.queryPartition({ ...query, consistentRead: true }), error => error instanceof NativeDynamoDbError && error.code === "request"); assert.equal(calls, beforeRefusal);
    const next = await bounded(db.queryPartition({ ...query, cursor: first.nextCursor })); assert.equal(next.items.length, 1); assert.deepEqual(next.items[0].sk, { B: new Uint8Array([1]) }); assert.equal(next.items[0].rank.N, "7.000"); assert.equal(next.nextCursor, undefined);
    duplicateBase = true; await assert.rejects(bounded(db.queryPartition({ ...query, cursor: first.nextCursor })), error => error instanceof NativeDynamoDbError && error.code === "invalid-response"); duplicateBase = false;
    badUnion = true; await assert.rejects(bounded(db.queryPartition(query)), error => error instanceof NativeDynamoDbError && error.code === "invalid-response"); badUnion = false;
    await assert.rejects(bounded(create({ maxPages: 1 }).queryPartition(query)), error => error instanceof NativeDynamoDbError && error.code === "limit");
    await assert.rejects(bounded(create({ maxReadBytes: 600 }).get("native", a)), error => error instanceof NativeDynamoDbError && error.code === "limit");
    for (const deadline of [false, true]) {
      const caller = new AbortController(); controllers.add(caller); const entered = gate(), aborted = gate(); dispatch = entered.resolve; acknowledge = aborted.resolve;
      const target = create({ timeoutMs: deadline ? 400 : 2000 }); const pending = target.getWithSignal("native", key([99]), caller.signal); work.push(pending);
      const outcome = assert.rejects(pending, error => error instanceof QueryCancelledError && error.reason === (deadline ? "deadline" : "caller") && error.cause === undefined && !error.message.includes("synthetic-native"));
      await bounded(entered.promise); if (!deadline) caller.abort("synthetic-native-caller-cause"); await bounded(outcome); await bounded(aborted.promise); controllers.delete(caller); assert.equal(active.size, 0);
      assert.equal((await bounded(target.get("native", a))).pk.N, "9007199254740993");
    }
    dispatch = undefined; acknowledge = undefined;
    const entered = gate(), pendingCredentials = gate(), caller = new AbortController(); controllers.add(caller);
    const blockedSDK = new DynamoDBClient({ region: "us-east-1", endpoint: "https://owned-native.invalid", credentials: () => { entered.resolve(); return pendingCredentials.promise; }, maxAttempts: 1, requestHandler: handler });
    const blocked = create({}, blockedSDK); const beforeCredentials = calls; const pending = blocked.getWithSignal("native", a, caller.signal); work.push(pending);
    const outcome = assert.rejects(pending, error => error instanceof QueryCancelledError && error.reason === "caller");
    try { await bounded(entered.promise); caller.abort(); await bounded(outcome); assert.equal(calls, beforeCredentials); } finally { pendingCredentials.reject(new Error("synthetic-native-credential-cause")); controllers.delete(caller); }
    const closed = create(); closed.close(); const beforeClose = calls; await assert.rejects(closed.get("native", a), error => error instanceof NativeDynamoDbError && error.code === "closed"); assert.equal(calls, beforeClose); assert.equal(destroys, 0);
    assert.equal((await bounded(db.get("native", a))).pk.N, "9007199254740993");
  } finally {
    dispatch = undefined; acknowledge = undefined; for (const caller of controllers) caller.abort(); controllers.clear(); for (const db of databases) db.close(); for (const entry of [...active]) entry.stop();
    await bounded(Promise.allSettled(work)); assert.equal(active.size, 0); assert.equal(destroys, 0);
  }
  return { officialLowLevelSdk: true, exactNativeValues: true, binaryNumericKeys: true, indexSortTiesAndBaseIdentity: true, fullUnionCursor: true, emptyEvaluatedPages: true, scopedCursor: true, projectionRefusals: true, batchOrderDuplicatesAnd101: true, unprocessedFailsWithoutRetry: true, parsedBudget: true, callerAfterDispatch: true, deadlineAfterDispatch: true, credentialWaiting: true, borrowedNeverDestroyed: true, reopen: true, cleanup: true, actualDynamoDBOrHostedIAM: false };
}
