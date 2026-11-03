import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { createAthenaNodeClient } from "@dalgo/dalgo2athena/node";
import { createAthenaHttpHandler } from "@dalgo/dalgo2athena/http";
import { Key, collection, UnsupportedError } from "@dalgo/core";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { AthenaDatabase, AthenaError } from "@dalgo/dalgo2athena";

export const source = {
  sourceId: "owned", region: "us-east-1", workGroup: "readers", catalog: "AwsDataCatalog", database: "native",
  outputLocation: "s3://owned-results/athena/", expectedBucketOwner: "111111111111", maxScanBytes: "10000000",
  encryption: { option: "SSE_S3" }, tables: { items: { table: "actual", columns: { id: "varchar", amount: "decimal(38,10)", note: "varchar" }, idColumn: "id" } }
};
export const query = (offset) => ({ source: { kind: "collection", name: "items" }, filters: [], orders: [{ field: "id", direction: "asc" }], ...(offset === undefined ? {} : { offset }) });
export const info = [{ Name: "id", Type: "varchar" }, { Name: "amount", Type: "decimal", Precision: 38, Scale: 10 }, { Name: "note", Type: "varchar" }];
export function result(rows, next, header = false) {
  return { ResultSet: { ResultSetMetadata: { ColumnInfo: info }, Rows: [...(header ? [["id", "amount", "note"]] : []), ...rows].map(row => ({ Data: row.map(value => value === null ? {} : { VarCharValue: value }) })) }, ...(next === undefined ? {} : { NextToken: next }) };
}
export function deferred() {
  let resolve = () => undefined, reject = () => undefined;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}

export function responseBody(incoming, signal) {
  let settled = false, controller;
  const cleanup = () => { incoming.off("data", onData); incoming.off("end", onEnd); incoming.off("error", onError); incoming.off("close", onClose); signal?.removeEventListener("abort", onAbort); };
  const finish = (error) => { if (settled) return; settled = true; cleanup(); if (error === undefined) controller?.close(); else controller?.error(error); };
  const onData = (chunk) => { if (settled) return; incoming.pause(); try { controller?.enqueue(new Uint8Array(chunk)); } catch (error) { finish(error); } };
  const onEnd = () => { finish(); };
  const onError = (error) => { finish(error); };
  const onClose = () => { if (!incoming.complete) finish(new Error("owned fixture response closed before completion")); };
  const onAbort = () => { incoming.destroy(); finish(signal?.reason ?? new Error("owned fixture request aborted")); };
  return new ReadableStream({
    start(value) {
      controller = value; incoming.on("data", onData); incoming.once("end", onEnd); incoming.once("error", onError); incoming.once("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true }); if (signal?.aborted) onAbort();
    },
    pull() { if (!settled) incoming.resume(); },
    cancel() { if (settled) return; settled = true; cleanup(); incoming.destroy(); }
  });
}

export function createTrustedFetch(port) {
  return (input, init) => {
    if (typeof input !== "string" || input !== "https://athena.us-east-1.amazonaws.com/" || typeof init?.body !== "string") throw new Error("unexpected authority/body");
    assert.equal(init.redirect, "error"); assert.equal(init.method, "POST");
    const headers = new Headers(init.headers); assert.equal(headers.get("host"), "athena.us-east-1.amazonaws.com");
    // Node24 fetch deliberately deletes Host before deriving it from a
    // remapped URL. The owned test seam dials loopback with node:http and
    // forwards the exact signed Host instead; production still uses AWS HTTPS.
    const wire = init.body;
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({ hostname: "127.0.0.1", port, path: "/", method: "POST", headers: Object.fromEntries(headers),
        signal: init.signal ?? undefined, agent: false, maxHeaderSize: 65536 }, incoming => {
        try {
          if (incoming.statusCode === undefined) throw new Error("owned fixture status missing");
          const responseHeaders = new Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
            const name = incoming.rawHeaders[i], value = incoming.rawHeaders[i + 1];
            if (name === undefined || value === undefined) throw new Error("owned fixture header missing"); responseHeaders.append(name, value);
          }
          resolve(new Response(responseBody(incoming, init.signal), { status: incoming.statusCode, headers: responseHeaders }));
        } catch (error) { incoming.destroy(); reject(error); }
      });
      outgoing.once("error", reject); outgoing.end(wire);
    });
  };
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function sign(key, value) { return createHmac("sha256", key).update(value).digest(); }
export function verifySigV4(headers, body, credentials) {
  const { accessKeyId, secretAccessKey, sessionToken } = credentials;
  const auth = headers.authorization; assert.equal(typeof auth, "string"); if (typeof auth !== "string") throw new Error("missing synthetic signature");
  const fields = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/u.exec(auth);
  if (fields === null) throw new Error("invalid synthetic signature");
  assert.equal(fields[1], accessKeyId); const scope = fields[2]; if (scope === undefined) throw new Error("scope");
  const parts = scope.split("/"); assert.deepEqual(parts.slice(1), ["us-east-1", "athena", "aws4_request"]);
  const names = fields[3]?.split(";"); if (names === undefined) throw new Error("signed headers");
  assert.ok(names.every((name, index) => index === 0 || names[index - 1] < name), "signed headers sorted and unique"); assert.ok(names.includes("host"), "signed host");
  const canonical = names.map(name => { const value = headers[name]; if (typeof value !== "string") throw new Error("signed field"); return name + ":" + value.trim().replace(/\s+/gu, " ") + "\n"; }).join("");
  const date = headers["x-amz-date"]; if (typeof date !== "string") throw new Error("date");
  const request = "POST\n/\n\n" + canonical + "\n" + names.join(";") + "\n" + hash(body);
  const stringToSign = "AWS4-HMAC-SHA256\n" + date + "\n" + scope + "\n" + hash(request);
  const dateKey = sign("AWS4" + secretAccessKey, parts[0] ?? ""), region = sign(dateKey, "us-east-1"), service = sign(region, "athena"), signing = sign(service, "aws4_request");
  assert.equal(fields[4], createHmac("sha256", signing).update(stringToSign).digest("hex")); assert.equal(headers["x-amz-security-token"], sessionToken);
}
export async function createOwnedServer(handler) {
  const sockets = new Set(), socketAcks = new Set(), handlers = new Set(), failures = [];
  let server, closing = false, ready = false, accepted = 0, setupFailed;
  const record = error => { failures.push(error); };
  const failure = new Promise((_, reject) => { setupFailed = reject; });
  server = createServer((request, response) => {
    if (closing) { request.destroy(); response.destroy(); return; }
    const controller = new AbortController();
    const entry = { controller, completion: undefined };
    const onAbort = () => { if (!controller.signal.aborted) controller.abort(new Error("owned handler aborted")); };
    const onRequestClose = () => { if (!request.complete) onAbort(); };
    const onResponseClose = () => { if (!response.writableEnded) onAbort(); };
    const detach = () => {
      request.off("aborted", onAbort);
      request.off("close", onRequestClose);
      response.off("close", onResponseClose);
    };
    request.once("aborted", onAbort);
    request.once("close", onRequestClose);
    response.once("close", onResponseClose);
    entry.completion = Promise.resolve().then(async () => {
      try {
        await handler(request, response, controller.signal);
      } catch (error) {
        record(error);
        if (!response.writableEnded) { try { response.destroy(); } catch (failure) { record(failure); } }
      } finally {
        detach();
        handlers.delete(entry);
      }
    });
    handlers.add(entry);
  });
  server.on("error", error => {
    if (ready) record(error);
    else setupFailed?.(error);
  });
  server.on("connection", socket => {
    sockets.add(socket);
    accepted++;
    const ack = new Promise(resolve => {
      socket.once("close", () => { sockets.delete(socket); socketAcks.delete(ack); resolve(); });
    });
    socketAcks.add(ack);
    socket.on("error", () => undefined);
    if (closing) socket.destroy();
  });
  let timer;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        const onListening = () => { server.off("error", onStartupError); resolve(); };
        const onStartupError = error => { server.off("listening", onListening); reject(error); };
        server.once("listening", onListening);
        server.once("error", onStartupError);
        server.listen(0, "127.0.0.1");
      }),
      failure,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned server startup deadline")), 2000); })
    ]);
    ready = true;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("owned server address");
    const port = address.port;
    let closingPromise;
    const snapshot = () => ({ liveConnections: sockets.size, activeHandlers: handlers.size, acceptedConnections: accepted });
    const close = () => {
      if (closingPromise !== undefined) return closingPromise;
      closing = true;
      closingPromise = Promise.resolve().then(async () => {
        let timer;
        try {
          for (const entry of handlers) entry.controller.abort(new Error("owned server closing"));
          const serverClosed = new Promise((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
          for (const socket of sockets) socket.destroy();
          await Promise.race([
            (async () => {
              await serverClosed;
              for (;;) { const count = socketAcks.size; await Promise.all([...socketAcks]); if (count === socketAcks.size) break; }
              await Promise.all([...handlers].map(entry => entry.completion));
            })(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned server cleanup deadline")), 2000); })
          ]);
        } catch (error) {
          record(error);
          throw error;
        } finally {
          clearTimeout(timer);
        }
        if (sockets.size !== 0 || handlers.size !== 0) {
          const error = new Error("owned server cleanup state");
          record(error);
          throw error;
        }
        assert.equal(sockets.size, 0);
        assert.equal(handlers.size, 0);
      });
      return closingPromise;
    };
    return { port, close, snapshot, failures };
  } catch (error) {
    record(error);
    ready = false;
    setupFailed = undefined;
    for (const socket of sockets) socket.destroy();
    try { server.close(); } catch (failure) { record(failure); }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/x-amz-json-1.1" } });
}
export function createWireFixture(source, initialPages) {
  const queries = new Map();
  let sequence = 0;
  const fixture = {
    calls: [],
    pages: [...initialPages],
    states: ["SUCCEEDED"],
    scan: "9007199254740993",
    override: undefined,
    request(action, body, authority, signal) {
      const input = JSON.parse(body); const event = { action, input, authority, signal }; fixture.calls.push(event);
      const overridden = fixture.override?.(event); if (overridden !== undefined) return overridden;
      if (action === "GetWorkGroup") return jsonResponse({ WorkGroup: { Name: source.workGroup, State: "ENABLED", Configuration: {
        EnforceWorkGroupConfiguration: true, BytesScannedCutoffPerQuery: 10000000, EngineVersion: { EffectiveEngineVersion: "Athena engine version 3" },
        ResultConfiguration: { OutputLocation: source.outputLocation, ExpectedBucketOwner: source.expectedBucketOwner, EncryptionConfiguration: { EncryptionOption: "SSE_S3" } }
      } } });
      if (action === "StartQueryExecution") { const id = "query-" + String(++sequence); queries.set(id, input); return jsonResponse({ QueryExecutionId: id }); }
      if (action === "GetQueryExecution") {
        const id = String(input.QueryExecutionId), original = queries.get(id); if (original === undefined) throw new Error("fixture unexpected query");
        const state = fixture.states.length > 1 ? fixture.states.shift() : fixture.states[0];
        const payload = { QueryExecution: { QueryExecutionId: id, Query: original.QueryString, QueryExecutionContext: original.QueryExecutionContext, WorkGroup: original.WorkGroup, ExecutionParameters: original.ExecutionParameters,
          ResultConfiguration: { OutputLocation: source.outputLocation + id + ".csv", ExpectedBucketOwner: source.expectedBucketOwner, EncryptionConfiguration: { EncryptionOption: "SSE_S3" } },
          Status: { State: state }, Statistics: { DataScannedInBytes: fixture.scan } } };
        return new Response(JSON.stringify(payload).replace('"DataScannedInBytes":"' + fixture.scan + '"', '"DataScannedInBytes":' + fixture.scan), { headers: { "content-type": "application/x-amz-json-1.1" } });
      }
      if (action === "GetQueryResults") {
        const id = String(input.QueryExecutionId); if (!queries.has(id)) throw new Error("fixture unexpected query");
        const token = input.NextToken; const index = token === undefined ? 0 : Number(String(token).slice(1));
        const page = fixture.pages[index]; if (page === undefined) throw new Error("fixture missing page"); return jsonResponse(page);
      }
      if (action === "StopQueryExecution") {
        const id = String(input.QueryExecutionId); if (!queries.has(id)) throw new Error("fixture unexpected query");
        return new Response(null, { status: 200 });
      }
      throw new Error("fixture unexpected action");
    }
  };
  return fixture;
}
export async function runSignedSmoke() {
  const credentials = Object.freeze({ accessKeyId: "AKIDOWNEDSMOKE", secretAccessKey: "owned/secret", sessionToken: "owned/session", principal: "owned-reader", generation: "one" });
  const rotatedCredentials = Object.freeze({ accessKeyId: "AKIDROTATEDDISPATCH", secretAccessKey: "rotated/dispatch/secret", sessionToken: "rotated/dispatch/session", principal: "owned-reader", generation: "one" });
  let selectedCredentials = credentials;
  const dispatchCase = { armed: false, statusReceived: deferred(), statusDisconnected: deferred(), stopAck: deferred(),
    capturedQueryId: undefined, stopQueryId: undefined, disconnected: false, stopAttempts: 0, stopStatus: undefined,
    stopBytes: undefined, stopFinished: false, stopSocketClosed: false, stopSignatureVerified: false, credentialCallsAtStatus: undefined };
  let credentialCalls = 0;
  const sourceSnapshot = JSON.stringify(source);
  const fixture = createWireFixture(source, [result([["a", "9007199254740993.0001", ""]], undefined, true)]);
  const actions = [];
  const server = await createOwnedServer(async (request, response, signal) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/");
    assert.equal(request.headers.host, "athena.us-east-1.amazonaws.com");
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 65536) throw new Error("owned signed request exceeds 65536 bytes");
      chunks.push(Buffer.from(chunk));
    }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    verifySigV4(request.headers, body, credentials);
    const target = request.headers["x-amz-target"];
    assert.equal(typeof target, "string");
    const match = /^AmazonAthena\.(GetWorkGroup|StartQueryExecution|GetQueryExecution|GetQueryResults|StopQueryExecution)$/u.exec(target);
    assert.notEqual(match, null);
    const action = match[1];
    actions.push(action);
    const upstream = await fixture.request(action, body, { principal: credentials.principal, generation: credentials.generation }, signal);
    const bytes = await upstream.arrayBuffer();
    if (dispatchCase.armed && action === "GetQueryExecution") {
      dispatchCase.capturedQueryId = String(JSON.parse(body).QueryExecutionId);
      dispatchCase.credentialCallsAtStatus = credentialCalls;
      let onStatusAbort;
      const disconnected = new Promise(resolve => { onStatusAbort = () => resolve(true); if (signal.aborted) onStatusAbort(); else signal.addEventListener("abort", onStatusAbort, { once: true }); });
      dispatchCase.statusReceived.resolve();
      let statusTimer;
      try {
        await Promise.race([disconnected, new Promise((_, reject) => { statusTimer = setTimeout(() => reject(new Error("held status disconnect deadline")), 3000); })]);
      } finally {
        clearTimeout(statusTimer);
        signal.removeEventListener("abort", onStatusAbort);
      }
      dispatchCase.disconnected = true;
      dispatchCase.statusDisconnected.resolve();
      return;
    }
    if (dispatchCase.armed && action === "StopQueryExecution") {
      const stopBody = JSON.parse(body);
      assert.deepEqual(stopBody, { QueryExecutionId: dispatchCase.capturedQueryId });
      dispatchCase.stopQueryId = stopBody.QueryExecutionId;
      dispatchCase.stopSignatureVerified = true;
      assert.equal(upstream.status, 200);
      assert.equal(bytes.byteLength, 0);
      dispatchCase.stopAttempts++;
      const socket = request.socket;
      let stopFail = () => undefined, stopCleanup = () => undefined, stopBlocked = false;
      const stopped = new Promise((resolve, reject) => {
        let settled = false, finished = false, socketClosed = false, timer;
        const cleanup = () => {
          clearTimeout(timer);
          response.off("finish", onFinish); response.off("close", onResponseClose); response.off("error", onError);
          socket.off("close", onSocketClose); socket.off("error", onError);
          signal.removeEventListener("abort", onAbort);
        };
        const fail = reason => { if (settled) return; settled = true; cleanup(); reject(new Error(reason)); };
        const settle = () => { if (settled || !finished || !socketClosed) return; settled = true; cleanup(); resolve(); };
        const onFinish = () => { finished = true; settle(); };
        const onResponseClose = () => { if (!finished) fail("owned fixture stop response closed before finish"); };
        const onSocketClose = () => { if (!finished) { fail("owned fixture stop socket closed before finish"); return; } socketClosed = true; settle(); };
        const onError = () => { fail("owned fixture stop exchange error"); };
        const onAbort = () => { fail("owned fixture stop handler aborted"); };
        stopFail = fail; stopCleanup = cleanup;
        response.once("finish", onFinish); response.once("close", onResponseClose); response.once("error", onError);
        socket.once("close", onSocketClose); socket.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => fail("owned fixture stop acknowledgement deadline"), 2000);
        if (signal.aborted) { stopBlocked = true; fail("owned fixture stop handler aborted"); return; }
        if (response.destroyed || socket.destroyed) { stopBlocked = true; fail("owned fixture stop transport closed before finish"); return; }
      });
      try {
        if (!stopBlocked) {
          try {
            response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
            response.end(Buffer.from(bytes));
          } catch { stopFail("owned fixture stop write failure"); }
        }
        await stopped;
      } finally {
        stopCleanup();
      }
      dispatchCase.stopFinished = true;
      dispatchCase.stopSocketClosed = true;
      dispatchCase.stopStatus = upstream.status;
      dispatchCase.stopBytes = bytes.byteLength;
      dispatchCase.stopAck.resolve();
      return;
    }
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    response.end(Buffer.from(bytes));
  });
  let client, deadlineClient, partial;
  try {
    client = createAthenaNodeClient({ source, credentials: async () => { credentialCalls++; return selectedCredentials; }, fetch: createTrustedFetch(server.port), pollIntervalMs: 0, timeoutMs: 5000 });
    assert.equal(credentialCalls, 0);
    assert.equal(fixture.calls.length, 0);
    const page = await client.queryPage({ ...query(), limit: 1 }, { pageSize: 2 });
    assert.deepEqual(actions, ["GetWorkGroup", "StartQueryExecution", "GetQueryExecution", "GetQueryResults"]);
    assert.deepEqual(fixture.calls.map(call => call.action), actions);
    const start = fixture.calls[1].input;
    assert.equal(start.QueryString, 'SELECT "id", "amount", "note" FROM "AwsDataCatalog"."native"."actual" ORDER BY "id" ASC LIMIT 1');
    assert.equal(start.WorkGroup, source.workGroup);
    assert.deepEqual(start.QueryExecutionContext, { Catalog: source.catalog, Database: source.database });
    assert.deepEqual(start.ResultConfiguration, { OutputLocation: source.outputLocation, ExpectedBucketOwner: source.expectedBucketOwner, EncryptionConfiguration: { EncryptionOption: "SSE_S3" } });
    assert.deepEqual(start.ResultReuseConfiguration, { ResultReuseByAgeConfiguration: { Enabled: false } });
    assert.equal(typeof start.ClientRequestToken, "string");
    const results = fixture.calls[3].input;
    assert.equal(results.QueryExecutionId, "query-1");
    assert.equal(results.MaxResults, 2);
    assert.equal(results.QueryResultType, "DATA_ROWS");
    assert.equal(results.NextToken, undefined);
    assert.deepEqual(page.columns, [
      { name: "id", type: "varchar" },
      { name: "amount", type: "decimal", precision: 38, scale: 10 },
      { name: "note", type: "varchar" }
    ]);
    assert.deepEqual(page.rows, [["a", "9007199254740993.0001", ""]]);
    assert.equal(page.ordinalStart, 0);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, undefined);
    assert.equal(page.receipt.sourceId, "owned");
    assert.equal(page.receipt.queryId, "query-1");
    assert.equal(page.receipt.state, "SUCCEEDED");
    assert.equal(page.receipt.complete, true);
    assert.equal(page.receipt.dataScannedBytes, "9007199254740993");
    const segmentCalls = fixture.calls.length, segmentActions = actions.length;
    fixture.pages.splice(0, fixture.pages.length, result([], "p1", true), result([], "p2"), result([["a", "9007199254740993.0001", null]], "p3"), result([["a", "9007199254740993.0001", null]], "p4"), result([["b", null, ""]]));
    const resultCalls = () => fixture.calls.slice(segmentCalls).filter(call => call.action === "GetQueryResults").length;
    const first = await client.queryPage(query(2), { pageSize: 1 });
    assert.deepEqual(first.rows, []); assert.equal(first.ordinalStart, 0); assert.equal(first.hasMore, true);
    if (first.nextCursor === undefined) throw new Error("missing first cursor");
    const second = await client.nextPage(first.nextCursor);
    assert.deepEqual(second.rows, []); assert.equal(second.ordinalStart, 0); assert.equal(second.hasMore, true);
    if (second.nextCursor === undefined) throw new Error("missing second cursor");
    const beforeFailure = resultCalls(); assert.equal(beforeFailure, 2);
    await assert.rejects(client.mapNextPage(second.nextCursor, undefined, async passed => { passed.rows[0][0] = "mutated-copy"; throw new Error("PRIVATE_FACTORY"); }), error => {
      assert.equal(error.code, "transport"); assert.equal(String(error.message).includes("PRIVATE_FACTORY"), false); return true;
    });
    assert.equal(resultCalls(), beforeFailure + 1); assert.deepEqual(first.rows, []); assert.deepEqual(second.rows, []);
    const third = await client.nextPage(second.nextCursor);
    assert.equal(resultCalls(), beforeFailure + 1); assert.deepEqual(third.rows, [["a", "9007199254740993.0001", null]]); assert.equal(third.ordinalStart, 0);
    const beforeStale = resultCalls(); assert.equal(beforeStale, 3);
    await assert.rejects(client.nextPage(second.nextCursor), error => { assert.equal(error.code, "cursor"); return true; });
    assert.equal(resultCalls(), beforeStale);
    if (third.nextCursor === undefined) throw new Error("missing third cursor");
    const fourth = await client.nextPage(third.nextCursor);
    assert.deepEqual(fourth.rows, [["a", "9007199254740993.0001", null]]); assert.equal(fourth.ordinalStart, 1);
    if (fourth.nextCursor === undefined) throw new Error("missing fourth cursor");
    const fifth = await client.nextPage(fourth.nextCursor);
    assert.deepEqual(fifth.rows, [["b", null, ""]]); assert.equal(fifth.ordinalStart, 2); assert.equal(fifth.hasMore, false); assert.equal(fifth.nextCursor, undefined);
    assert.equal(fifth.receipt.complete, true); assert.equal(fifth.receipt.counters.rows, 3);
    const pages = [first, second, third, fourth, fifth];
    assert.equal(resultCalls(), 5);
    assert.deepEqual(pages.flatMap(value => value.rows), [["a", "9007199254740993.0001", null], ["a", "9007199254740993.0001", null], ["b", null, ""]]);
    assert.deepEqual(pages.map(value => value.ordinalStart), [0, 0, 0, 1, 2]);
    for (const value of pages) { assert.equal(value.receipt.sourceId, "owned"); assert.equal(value.receipt.queryId, "query-2"); assert.equal(value.receipt.state, "SUCCEEDED"); }
    const appended = fixture.calls.slice(segmentCalls), appendedStarts = appended.filter(call => call.action === "StartQueryExecution"), appendedResults = appended.filter(call => call.action === "GetQueryResults");
    assert.equal(appendedStarts.length, 1); assert.equal(appendedResults.length, 5); assert.equal(appended.filter(call => call.action === "StopQueryExecution").length, 0);
    const pagingActions = actions.slice(segmentActions);
    assert.equal(pagingActions.filter(action => action === "StartQueryExecution").length, 1);
    assert.equal(pagingActions.filter(action => action === "GetQueryResults").length, 5);
    const secondStart = appendedStarts[0].input;
    assert.equal(String(secondStart.QueryString).split("OFFSET 2").length - 1, 1);
    assert.deepEqual(secondStart.ResultReuseConfiguration, { ResultReuseByAgeConfiguration: { Enabled: false } });
    assert.deepEqual(appendedResults.map(call => call.input.QueryExecutionId), ["query-2", "query-2", "query-2", "query-2", "query-2"]);
    assert.deepEqual(appendedResults.map(call => call.input.MaxResults), [1, 1, 1, 1, 1]);
    assert.deepEqual(appendedResults.map(call => call.input.QueryResultType), ["DATA_ROWS", "DATA_ROWS", "DATA_ROWS", "DATA_ROWS", "DATA_ROWS"]);
    assert.deepEqual(appendedResults.map(call => call.input.NextToken), [undefined, "p1", "p2", "p3", "p4"]);
    fixture.pages.splice(0, fixture.pages.length, result([["a", "9007199254740993.0001", null]], undefined, true));
    const items = collection("items"), aKey = items.key("a"), directKey = new Key("items", "a");
    assert.ok(aKey instanceof Key); assert.ok(directKey instanceof Key);
    assert.equal(aKey.collection, "items"); assert.equal(aKey.id, "a"); assert.equal(aKey.path, "items/a");
    assert.equal(directKey.collection, "items"); assert.equal(directKey.id, "a"); assert.equal(directKey.path, "items/a");
    const database = new AthenaDatabase(client), coreSegment = fixture.calls.length;
    const positive = await database.get(aKey);
    assert.equal(positive.exists, true); assert.ok(positive.key instanceof Key);
    assert.equal(positive.key.collection, "items"); assert.equal(positive.key.id, "a"); assert.equal(positive.key.path, "items/a");
    assert.equal(Object.getPrototypeOf(positive.data), null); assert.deepEqual(Object.keys(positive.data), ["id", "amount", "note"]);
    assert.ok(Object.hasOwn(positive.data, "id")); assert.ok(Object.hasOwn(positive.data, "amount")); assert.ok(Object.hasOwn(positive.data, "note"));
    assert.deepEqual(Object.values(positive.data), ["a", "9007199254740993.0001", null]);
    assert.equal(typeof positive.data.amount, "string"); assert.equal(positive.data.amount, "9007199254740993.0001"); assert.equal(positive.data.note, null);
    fixture.pages.splice(0, fixture.pages.length, result([["a", "9007199254740993.0001", ""]], undefined, true));
    const empty = await database.get(new Key("items", "a"));
    assert.equal(empty.exists, true); assert.equal(Object.getPrototypeOf(empty.data), null);
    assert.equal(empty.data.id, "a"); assert.equal(empty.data.amount, "9007199254740993.0001"); assert.equal(typeof empty.data.note, "string"); assert.equal(empty.data.note, "");
    fixture.pages.splice(0, fixture.pages.length, result([["a", "9007199254740993.0001", null]], undefined, true));
    const duplicates = await database.getMany([aKey, aKey]);
    assert.equal(duplicates.length, 2); assert.equal(duplicates[0].exists, true); assert.equal(duplicates[1].exists, true);
    assert.equal(duplicates[0].key.collection, "items"); assert.equal(duplicates[0].key.id, "a"); assert.equal(duplicates[1].key.collection, "items"); assert.equal(duplicates[1].key.id, "a");
    assert.notStrictEqual(duplicates[0], duplicates[1]); assert.notStrictEqual(duplicates[0].data, duplicates[1].data);
    assert.equal(Object.getPrototypeOf(duplicates[0].data), null); assert.equal(Object.getPrototypeOf(duplicates[1].data), null);
    assert.deepEqual(Object.values(duplicates[0].data), ["a", "9007199254740993.0001", null]); assert.deepEqual(Object.values(duplicates[1].data), ["a", "9007199254740993.0001", null]);
    duplicates[0].data.id = "mutated"; assert.equal(duplicates[1].data.id, "a");
    fixture.pages.splice(0, fixture.pages.length, result([], undefined, true));
    const missingKey = new Key("items", "missing"), missing = await database.get(missingKey);
    assert.equal(missing.exists, false); assert.equal(missing.key.collection, "items"); assert.equal(missing.key.id, "missing"); assert.equal(missing.key.path, "items/missing");
    assert.equal(Object.hasOwn(missing, "data"), false); assert.equal(missing.data, undefined);
    fixture.pages.splice(0, fixture.pages.length, result([["a", "9007199254740993.0001", null]], undefined, true));
    const coreCalls = fixture.calls.slice(coreSegment), coreStarts = coreCalls.filter(call => call.action === "StartQueryExecution");
    const coreResults = coreCalls.filter(call => call.action === "GetQueryResults"), coreExecutions = coreCalls.filter(call => call.action === "GetQueryExecution");
    assert.equal(coreStarts.length, 5); assert.equal(coreResults.length, 5); assert.equal(coreExecutions.length, 5);
    const coreQueryIds = coreExecutions.map(call => String(call.input.QueryExecutionId)); assert.equal(new Set(coreQueryIds).size, 5);
    for (const call of coreResults) assert.ok(coreQueryIds.includes(String(call.input.QueryExecutionId)));
    assert.equal(new Set(coreResults.map(call => String(call.input.QueryExecutionId))).size, 5);
    const aStarts = coreStarts.filter(call => JSON.stringify(call.input.ExecutionParameters ?? null) === JSON.stringify(["'a'"]));
    const missingStarts = coreStarts.filter(call => JSON.stringify(call.input.ExecutionParameters ?? null) === JSON.stringify(["'missing'"]));
    assert.equal(aStarts.length, 4); assert.equal(missingStarts.length, 1);
    for (const call of [...aStarts, ...missingStarts]) assert.equal(call.input.QueryString, 'SELECT "id", "amount", "note" FROM "AwsDataCatalog"."native"."actual" WHERE "id" = ? LIMIT 2');
    let transactionInvoked = false; const credentialsBeforeTransaction = credentialCalls, callsBeforeTransaction = fixture.calls.length;
    await assert.rejects(database.runReadwriteTransaction(async () => { transactionInvoked = true; }), error => {
      assert.ok(error instanceof UnsupportedError); assert.equal(Object.getPrototypeOf(error), UnsupportedError.prototype); return true;
    });
    assert.equal(transactionInvoked, false); assert.equal(credentialCalls, credentialsBeforeTransaction); assert.equal(fixture.calls.length, callsBeforeTransaction);
    const coreValues = { key: { collection: aKey.collection, id: aKey.id, path: aKey.path, core: aKey instanceof Key },
      positive: { exists: positive.exists, prototypeNull: Object.getPrototypeOf(positive.data) === null, keys: Object.keys(positive.data), values: Object.values(positive.data), amountType: typeof positive.data.amount },
      emptyString: empty.data.note, duplicates: { length: duplicates.length, distinctSnapshots: duplicates[0] !== duplicates[1], distinctMaps: duplicates[0].data !== duplicates[1].data, keys: Object.keys(duplicates[1].data), values: Object.values(duplicates[1].data) },
      missing: { exists: missing.exists, hasData: Object.hasOwn(missing, "data"), path: missing.key.path },
      transaction: { invoked: transactionInvoked, unsupported: true, credentialsUnchanged: credentialCalls === credentialsBeforeTransaction, callsUnchanged: fixture.calls.length === callsBeforeTransaction },
      segment: { starts: coreStarts.length, results: coreResults.length, queryIds: coreQueryIds } };
    const codecSegment = fixture.calls.length, codecActionSegment = actions.length;
    const stopsBeforeCodec = actions.filter(value => value === "StopQueryExecution").length;
    const controller = new AbortController(), abortReason = new Error("PRIVATE_CODEC_REASON");
    let codecEntered = 0, delivered = false;
    const codec = { encode(value) { return value; }, decode(data) {
      assert.equal(Object.getPrototypeOf(data), null); assert.equal(data.id, "a"); assert.equal(typeof data.amount, "string");
      assert.equal(data.amount, "9007199254740993.0001"); assert.equal(data.note, null); codecEntered++;
      controller.abort(abortReason); return data;
    } };
    await assert.rejects(database.getWithSignal(aKey, controller.signal, codec).then(value => { delivered = true; return value; }), error => {
      assert.ok(error instanceof QueryCancelledError); assert.equal(Object.getPrototypeOf(error), QueryCancelledError.prototype);
      assert.equal(error.reason, "caller"); assert.equal(String(error.message).includes("PRIVATE_CODEC_REASON"), false);
      assert.equal(error.cause, undefined); return true;
    });
    assert.equal(codecEntered, 1); assert.equal(delivered, false);
    const codecActions = actions.slice(codecActionSegment);
    assert.deepEqual(codecActions, ["GetWorkGroup", "StartQueryExecution", "GetQueryExecution", "GetQueryResults"]);
    assert.equal(actions.filter(value => value === "StopQueryExecution").length, stopsBeforeCodec);
    const reuse = await database.get(aKey);
    assert.equal(reuse.exists, true); assert.ok(reuse.key instanceof Key);
    assert.equal(reuse.key.collection, "items"); assert.equal(reuse.key.id, "a"); assert.equal(reuse.key.path, "items/a");
    assert.equal(Object.getPrototypeOf(reuse.data), null);
    assert.deepEqual(Object.values(reuse.data), ["a", "9007199254740993.0001", null]);
    assert.equal(typeof reuse.data.amount, "string"); assert.equal(reuse.data.amount, "9007199254740993.0001"); assert.equal(reuse.data.note, null);
    const finalCalls = fixture.calls.slice(codecSegment), finalActions = actions.slice(codecActionSegment);
    const finalStarts = finalCalls.filter(call => call.action === "StartQueryExecution");
    const finalResults = finalCalls.filter(call => call.action === "GetQueryResults");
    const finalExecutions = finalCalls.filter(call => call.action === "GetQueryExecution");
    assert.equal(finalStarts.length, 2); assert.equal(finalResults.length, 2); assert.equal(finalExecutions.length, 2);
    assert.equal(finalCalls.filter(call => call.action === "StopQueryExecution").length, 0); assert.equal(actions.length, 40);
    const finalQueryIds = finalExecutions.map(call => String(call.input.QueryExecutionId));
    assert.equal(new Set(finalQueryIds).size, 2); assert.deepEqual(finalResults.map(call => String(call.input.QueryExecutionId)), finalQueryIds);
    const codecStopsUnchanged = actions.filter(value => value === "StopQueryExecution").length === stopsBeforeCodec;
    assert.equal(codecStopsUnchanged, true);
    fixture.pages.splice(0, fixture.pages.length, result([], "p1", true), result([["a", "9007199254740993.0001", null]]));
    const bridgeSegment = fixture.calls.length, bridgeActionSegment = actions.length;
    const bridgeHandler = createAthenaHttpHandler({
      allowedOrigins: ["https://app.invalid"],
      authorize: (request, signal) => {
        assert.equal(request.url, "https://bridge.invalid/athena");
        assert.equal(request.headers.get("authorization"), "Bearer bridge-reader");
        assert.ok(signal instanceof AbortSignal);
        return client;
      }
    });
    const bridgeRequest = (body, signal) => new Request("https://bridge.invalid/athena", { method: "POST",
      headers: { origin: "https://app.invalid", "content-type": "application/json", authorization: "Bearer bridge-reader" },
      body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });
    const bridgeInitial = { operation: "query", query: { source: { kind: "collection", name: "items" }, filters: [], orders: [{ field: "id", direction: "asc" }], limit: 2 }, pageSize: 1 };
    const bridgeResponse = await bridgeHandler(bridgeRequest(bridgeInitial));
    assert.equal(bridgeResponse.status, 200);
    assert.match(String(bridgeResponse.headers.get("content-type")), /^application\/json/u);
    assert.equal(bridgeResponse.headers.get("cache-control"), "no-store");
    assert.equal(bridgeResponse.headers.get("x-content-type-options"), "nosniff");
    const bridgeFirstPage = await bridgeResponse.json();
    assert.equal(Object.hasOwn(bridgeFirstPage, "page"), false);
    assert.deepEqual(bridgeFirstPage.rows, []); assert.equal(bridgeFirstPage.ordinalStart, 0); assert.equal(bridgeFirstPage.hasMore, true);
    const bridgeCursor = bridgeFirstPage.nextCursor; if (typeof bridgeCursor !== "string" || bridgeCursor.length === 0) throw new Error("missing bridge cursor");
    assert.equal(typeof bridgeFirstPage.receipt.queryId, "string");
    const bridgeCalls = fixture.calls.slice(bridgeSegment), bridgeActions = actions.slice(bridgeActionSegment);
    assert.deepEqual(bridgeActions, ["GetWorkGroup", "StartQueryExecution", "GetQueryExecution", "GetQueryResults"]);
    assert.deepEqual(bridgeCalls.map(call => call.action), bridgeActions);
    const bridgeStart = bridgeCalls[1].input, bridgeResults = bridgeCalls[3].input;
    assert.equal(typeof bridgeStart.QueryString, "string");
    assert.equal(bridgeResults.QueryExecutionId, bridgeFirstPage.receipt.queryId);
    assert.equal(bridgeResults.MaxResults, 1); assert.equal(bridgeResults.NextToken, undefined);
    assert.equal(actions.length, 44);
    const OriginalResponse = globalThis.Response;
    const caller = new AbortController(), PRIVATE_REASON = new Error("PRIVATE_STAGE2_REASON"), PRIVATE_FACTORY = new Error("PRIVATE_STAGE2_FACTORY");
    const countResults = () => fixture.calls.filter(call => call.action === "GetQueryResults").length;
    const countStarts = () => fixture.calls.filter(call => call.action === "StartQueryExecution").length;
    const bridgeFirstTotalActions = actions.length, getResultsBefore = countResults(), startsBefore = countStarts();
    let constructionEntered = 0, failed;
    try {
      globalThis.Response = class extends OriginalResponse {
        constructor(body, init) {
          super(body, init);
          if (typeof body === "string" && init?.status === 200 && body.includes('"ordinalStart"')) {
            constructionEntered++;
            caller.abort(PRIVATE_REASON);
            throw PRIVATE_FACTORY;
          }
        }
      };
      failed = await bridgeHandler(bridgeRequest({ operation: "next", cursor: bridgeCursor }, caller.signal));
    } finally {
      globalThis.Response = OriginalResponse;
    }
    assert.equal(constructionEntered, 1);
    assert.equal(failed.status, 408);
    const failedEnvelope = await failed.json();
    assert.deepEqual(failedEnvelope, { error: "cancelled", reason: "caller" });
    const failedText = JSON.stringify(failedEnvelope);
    assert.equal(failedText.includes("PRIVATE_STAGE2_REASON"), false);
    assert.equal(failedText.includes("PRIVATE_STAGE2_FACTORY"), false);
    assert.equal(failedText.includes(bridgeCursor), false);
    assert.equal(Object.hasOwn(failedEnvelope, "rows"), false);
    assert.equal(Object.hasOwn(failedEnvelope, "nextCursor"), false);
    const getResultsAfterFailure = countResults();
    assert.equal(getResultsAfterFailure, getResultsBefore + 1);
    const retried = await bridgeHandler(bridgeRequest({ operation: "next", cursor: bridgeCursor }));
    assert.equal(retried.status, 200);
    const retriedPage = await retried.json();
    assert.equal(retriedPage.rows.length, 1);
    assert.deepEqual(retriedPage.rows[0], ["a", "9007199254740993.0001", null]);
    assert.equal(typeof retriedPage.rows[0][1], "string");
    assert.equal(retriedPage.ordinalStart, 0); assert.equal(retriedPage.hasMore, false);
    assert.equal(retriedPage.nextCursor, undefined); assert.equal(retriedPage.receipt.complete, true);
    assert.equal(retriedPage.receipt.queryId, bridgeFirstPage.receipt.queryId);
    assert.equal(countResults(), getResultsAfterFailure); assert.equal(countStarts(), startsBefore);
    const staleCursor = await bridgeHandler(bridgeRequest({ operation: "next", cursor: bridgeCursor }));
    assert.equal(staleCursor.status, 400);
    assert.deepEqual(await staleCursor.json(), { error: "cursor" });
    assert.equal(countResults(), getResultsAfterFailure); assert.equal(countStarts(), startsBefore);
    const bridgeAllCalls = fixture.calls.slice(bridgeSegment), bridgeAllActions = actions.slice(bridgeActionSegment);
    const bridgeWireResults = bridgeAllCalls.filter(call => call.action === "GetQueryResults");
    assert.equal(bridgeAllActions.filter(value => value === "GetWorkGroup").length, 1);
    assert.equal(bridgeAllActions.filter(value => value === "StartQueryExecution").length, 1);
    assert.equal(bridgeAllActions.filter(value => value === "GetQueryExecution").length, 1);
    assert.equal(bridgeWireResults.length, 2);
    assert.equal(bridgeAllActions.filter(value => value === "StopQueryExecution").length, 0);
    assert.deepEqual(bridgeWireResults.map(call => call.input.QueryExecutionId), [bridgeFirstPage.receipt.queryId, bridgeFirstPage.receipt.queryId]);
    assert.equal(actions.length, 45);
    const bridgeTotalActions = actions.length;
    const trustedHttpBridge = {
      stage: 2, constructionEntered, failedStatus: failed.status, error: failedEnvelope,
      privateHidden: !failedText.includes("PRIVATE_STAGE2_REASON") && !failedText.includes("PRIVATE_STAGE2_FACTORY"),
      failedAddedResults: getResultsAfterFailure - getResultsBefore,
      retry: { status: retried.status, rows: retriedPage.rows, ordinalStart: retriedPage.ordinalStart, hasMore: retriedPage.hasMore,
        nextCursor: retriedPage.nextCursor ?? null, complete: retriedPage.receipt.complete, queryId: retriedPage.receipt.queryId },
      retryAddedResults: countResults() - getResultsAfterFailure,
      stale: { status: staleCursor.status, error: "cursor" },
      wire: { workGroups: 1, starts: 1, statuses: 1, results: bridgeWireResults.length, stops: 0,
        queryIds: bridgeWireResults.map(call => String(call.input.QueryExecutionId)) },
      totalActions: bridgeTotalActions, firstPageTotalActions: bridgeFirstTotalActions,
      notProven: ["callerAbortDuringInflightAwsStop", "deadlineInflightAwsStop", "latePhysicalLeases", "quota", "browserAuthCors"]
    };
    const genuineCaller = new AbortController(), PRIVATE_DISPATCH_REASON = "PRIVATE_DISPATCH_REASON";
    const callerSegment = fixture.calls.length, callerActionSegment = actions.length;
    fixture.pages.splice(0, fixture.pages.length, result([["a", "9007199254740993.0001", null]], undefined, true));
    fixture.states = ["RUNNING"];
    dispatchCase.armed = true;
    let callerDelivered = false;
    const callerOutcome = client.queryPage({ ...query(), limit: 1 }, { signal: genuineCaller.signal, pageSize: 2 }).then(
      value => { callerDelivered = true; return { cancelled: false, error: undefined, value }; },
      error => ({ cancelled: true, error, value: undefined })
    );
    let readTimer, dispatchFirst;
    try {
      dispatchFirst = await Promise.race([
        dispatchCase.statusReceived.promise.then(() => ({ kind: "status" })),
        callerOutcome.then(() => ({ kind: "outcome" })),
        new Promise((_, reject) => { readTimer = setTimeout(() => reject(new Error("dispatched caller read deadline")), 5000); })
      ]);
    } finally { clearTimeout(readTimer); }
    assert.equal(dispatchFirst.kind, "status");
    selectedCredentials = rotatedCredentials;
    const abortedAt = Date.now();
    genuineCaller.abort(new Error(PRIVATE_DISPATCH_REASON));
    let cleanupTimer, outcome;
    try {
      outcome = await Promise.race([callerOutcome, new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error("dispatched caller cleanup deadline")), 2000); })]);
    } finally { clearTimeout(cleanupTimer); }
    const cleanupMs = Date.now() - abortedAt;
    assert.ok(cleanupMs <= 2000);
    assert.equal(outcome.cancelled, true); assert.equal(callerDelivered, false);
    const cancellation = outcome.error;
    assert.ok(cancellation instanceof QueryCancelledError);
    assert.equal(Object.getPrototypeOf(cancellation), QueryCancelledError.prototype);
    assert.equal(cancellation.reason, "caller");
    assert.equal(String(cancellation.message).includes(PRIVATE_DISPATCH_REASON), false);
    assert.equal(cancellation.cause, undefined);
    let ackTimer;
    try {
      await Promise.race([Promise.all([dispatchCase.statusDisconnected.promise, dispatchCase.stopAck.promise]),
        new Promise((_, reject) => { ackTimer = setTimeout(() => reject(new Error("dispatched stop ack deadline")), 2500); })]);
    } finally { clearTimeout(ackTimer); }
    assert.equal(dispatchCase.disconnected, true);
    assert.equal(dispatchCase.stopAttempts, 1); assert.equal(dispatchCase.stopStatus, 200);
    assert.equal(dispatchCase.stopBytes, 0); assert.equal(dispatchCase.stopFinished, true); assert.equal(dispatchCase.stopSocketClosed, true);
    assert.equal(dispatchCase.stopSignatureVerified, true);
    assert.equal(dispatchCase.stopQueryId, dispatchCase.capturedQueryId);
    assert.equal(credentialCalls, dispatchCase.credentialCallsAtStatus);
    const credentialCallsAfterStop = credentialCalls;
    const callerCalls = fixture.calls.slice(callerSegment), callerActions = actions.slice(callerActionSegment);
    const callerStarts = callerCalls.filter(call => call.action === "StartQueryExecution");
    const callerStatus = callerCalls.filter(call => call.action === "GetQueryExecution");
    const callerResults = callerCalls.filter(call => call.action === "GetQueryResults");
    assert.deepEqual(callerActions, ["GetWorkGroup", "StartQueryExecution", "GetQueryExecution", "StopQueryExecution"]);
    assert.equal(callerStarts.length, 1); assert.equal(callerResults.length, 0); assert.equal(callerStatus.length, 1);
    assert.equal(String(callerStatus[0].input.QueryExecutionId), dispatchCase.capturedQueryId);
    assert.equal(actions.length, 49);
    selectedCredentials = credentials;
    fixture.states = ["SUCCEEDED"];
    dispatchCase.armed = false;
    const reuseSegment = fixture.calls.length, reuseActionSegment = actions.length;
    const dispatchedReuse = await database.get(aKey);
    assert.equal(dispatchedReuse.exists, true); assert.equal(dispatchedReuse.key.collection, "items"); assert.equal(dispatchedReuse.key.id, "a");
    assert.equal(Object.getPrototypeOf(dispatchedReuse.data), null);
    assert.deepEqual(Object.values(dispatchedReuse.data), ["a", "9007199254740993.0001", null]);
    assert.equal(typeof dispatchedReuse.data.amount, "string"); assert.equal(dispatchedReuse.data.amount, "9007199254740993.0001"); assert.equal(dispatchedReuse.data.note, null);
    const reuseCalls = fixture.calls.slice(reuseSegment), reuseActions = actions.slice(reuseActionSegment);
    assert.deepEqual(reuseCalls.map(call => call.action), ["GetWorkGroup", "StartQueryExecution", "GetQueryExecution", "GetQueryResults"]);
    assert.equal(reuseActions.length, 4); assert.equal(actions.length, 53);
    const dispatchedCaller = { before: 45, actions: callerActions, starts: callerStarts.length,
      stops: callerCalls.filter(call => call.action === "StopQueryExecution").length,
      resultRequestsDuringCaller: callerResults.length, capturedQueryId: dispatchCase.capturedQueryId,
      sameCapturedId: dispatchCase.stopQueryId === dispatchCase.capturedQueryId,
      statusDisconnected: dispatchCase.disconnected,
      stop: { attempts: dispatchCase.stopAttempts, status: dispatchCase.stopStatus, bytes: dispatchCase.stopBytes,
        finished: dispatchCase.stopFinished, socketClosed: dispatchCase.stopSocketClosed, originalSigV4: dispatchCase.stopSignatureVerified },
      cancelled: cancellation instanceof QueryCancelledError, reasonCaller: cancellation.reason === "caller",
      prototypeExact: Object.getPrototypeOf(cancellation) === QueryCancelledError.prototype,
      privateHidden: !String(cancellation.message).includes(PRIVATE_DISPATCH_REASON) && cancellation.cause === undefined,
      causeLeaked: cancellation.cause !== undefined, delivered: callerDelivered, cleanupMs,
      credentialCallsUnchanged: credentialCallsAfterStop === dispatchCase.credentialCallsAtStatus,
      reuseAdditional: reuseActions.length, combinedPredicted: 53, totalActions: actions.length,
      notProven: ["deadlineInflightAwsStop", "ignoredWorkPhysicalLease", "quota", "fullCancellationGroup"] };
    const deadlineSegment = fixture.calls.length, deadlineActionSegment = actions.length, deadlineCredentialsBefore = credentialCalls;
    dispatchCase.statusReceived = deferred();
    dispatchCase.statusDisconnected = deferred();
    dispatchCase.stopAck = deferred();
    dispatchCase.capturedQueryId = undefined;
    dispatchCase.stopQueryId = undefined;
    dispatchCase.stopStatus = undefined;
    dispatchCase.stopBytes = undefined;
    dispatchCase.credentialCallsAtStatus = undefined;
    dispatchCase.armed = false;
    dispatchCase.disconnected = false;
    dispatchCase.stopFinished = false;
    dispatchCase.stopSocketClosed = false;
    dispatchCase.stopSignatureVerified = false;
    dispatchCase.stopAttempts = 0;
    fixture.states = ["RUNNING"];
    fixture.pages.splice(0, fixture.pages.length, result([["a", "9007199254740993.0001", null]], undefined, true));
    selectedCredentials = credentials;
    deadlineClient = createAthenaNodeClient({ source, credentials: async () => { credentialCalls++; return selectedCredentials; }, fetch: createTrustedFetch(server.port), pollIntervalMs: 0, timeoutMs: 1000 });
    dispatchCase.armed = true;
    let deadlineFacts;
    try {
      let deadlineDelivered = false;
      const deadlineOutcome = deadlineClient.queryPage({ ...query(), limit: 1 }, { pageSize: 2 }).then(
        value => { deadlineDelivered = true; return { cancelled: false, error: undefined, value }; },
        error => ({ cancelled: true, error, value: undefined })
      );
      let deadlineReadTimer, deadlineFirst;
      try {
        deadlineFirst = await Promise.race([
          dispatchCase.statusReceived.promise.then(() => ({ kind: "status" })),
          deadlineOutcome.then(() => ({ kind: "outcome" })),
          new Promise((_, reject) => { deadlineReadTimer = setTimeout(() => reject(new Error("deadline status barrier")), 5000); })
        ]);
      } finally { clearTimeout(deadlineReadTimer); }
      assert.equal(deadlineFirst.kind, "status");
      selectedCredentials = rotatedCredentials;
      let deadlineOutcomeTimer, deadlineResult;
      try {
        deadlineResult = await Promise.race([deadlineOutcome, new Promise((_, reject) => { deadlineOutcomeTimer = setTimeout(() => reject(new Error("deadline expiry outcome")), 3000); })]);
      } finally { clearTimeout(deadlineOutcomeTimer); }
      assert.equal(deadlineResult.cancelled, true); assert.equal(deadlineDelivered, false);
      const deadlineCancellation = deadlineResult.error;
      assert.ok(deadlineCancellation instanceof QueryCancelledError);
      assert.equal(Object.getPrototypeOf(deadlineCancellation), QueryCancelledError.prototype);
      assert.equal(deadlineCancellation.reason, "deadline");
      assert.equal(deadlineCancellation.cause, undefined);
      assert.equal(String(deadlineCancellation.message).includes("PRIVATE"), false);
      assert.equal(deadlineResult.value, undefined);
      let deadlineAckTimer;
      try {
        await Promise.race([Promise.all([dispatchCase.statusDisconnected.promise, dispatchCase.stopAck.promise]),
          new Promise((_, reject) => { deadlineAckTimer = setTimeout(() => reject(new Error("deadline stop ack deadline")), 2500); })]);
      } finally { clearTimeout(deadlineAckTimer); }
      assert.equal(dispatchCase.disconnected, true);
      assert.equal(dispatchCase.stopAttempts, 1); assert.equal(dispatchCase.stopStatus, 200);
      assert.equal(dispatchCase.stopBytes, 0); assert.equal(dispatchCase.stopFinished, true); assert.equal(dispatchCase.stopSocketClosed, true);
      assert.equal(dispatchCase.stopSignatureVerified, true);
      assert.equal(dispatchCase.stopQueryId, dispatchCase.capturedQueryId);
      assert.notEqual(dispatchCase.capturedQueryId, dispatchedCaller.capturedQueryId);
      assert.equal(credentialCalls, dispatchCase.credentialCallsAtStatus);
      const deadlineCredentialCallsAfterStop = credentialCalls;
      const deadlineCalls = fixture.calls.slice(deadlineSegment), deadlineActions = actions.slice(deadlineActionSegment);
      const deadlineStarts = deadlineCalls.filter(call => call.action === "StartQueryExecution");
      const deadlineStatus = deadlineCalls.filter(call => call.action === "GetQueryExecution");
      const deadlineResults = deadlineCalls.filter(call => call.action === "GetQueryResults");
      assert.deepEqual(deadlineActions, ["GetWorkGroup", "StartQueryExecution", "GetQueryExecution", "StopQueryExecution"]);
      assert.equal(deadlineStarts.length, 1); assert.equal(deadlineResults.length, 0); assert.equal(deadlineStatus.length, 1);
      assert.equal(String(deadlineStatus[0].input.QueryExecutionId), dispatchCase.capturedQueryId);
      assert.equal(actions.length, 57);
      deadlineFacts = { before: 53, actions: deadlineActions, starts: deadlineStarts.length,
        stops: deadlineCalls.filter(call => call.action === "StopQueryExecution").length,
        resultRequestsDuringDeadline: deadlineResults.length, capturedQueryId: dispatchCase.capturedQueryId,
        sameCapturedId: dispatchCase.stopQueryId === dispatchCase.capturedQueryId,
        statusDisconnected: dispatchCase.disconnected,
        stop: { attempts: dispatchCase.stopAttempts, status: dispatchCase.stopStatus, bytes: dispatchCase.stopBytes,
          finished: dispatchCase.stopFinished, socketClosed: dispatchCase.stopSocketClosed, originalSigV4: dispatchCase.stopSignatureVerified },
        cancelled: deadlineCancellation instanceof QueryCancelledError, reasonDeadline: deadlineCancellation.reason === "deadline",
        prototypeExact: Object.getPrototypeOf(deadlineCancellation) === QueryCancelledError.prototype,
        privateHidden: !String(deadlineCancellation.message).includes("PRIVATE") && deadlineCancellation.cause === undefined,
        causeLeaked: deadlineCancellation.cause !== undefined, delivered: deadlineDelivered, valueAbsent: deadlineResult.value === undefined,
        credentialCallsUnchanged: deadlineCredentialCallsAfterStop === dispatchCase.credentialCallsAtStatus,
        credentialCallsBefore: deadlineCredentialsBefore, totalActions: actions.length,
        notProven: ["observedCancelled", "hostedTermination", "cost", "completeIgnoredPhysicalLease", "quota", "fullCancellationGroup"] };
    } finally {
      selectedCredentials = credentials;
      fixture.states = ["SUCCEEDED"];
      dispatchCase.armed = false;
    }
    const deadlineReuseSegment = fixture.calls.length, deadlineReuseActionSegment = actions.length;
    const deadlineReuse = await deadlineClient.queryPage({ ...query(), limit: 1 }, { pageSize: 2 });
    assert.deepEqual(deadlineReuse.rows, [["a", "9007199254740993.0001", null]]);
    assert.deepEqual(deadlineReuse.columns, page.columns);
    assert.equal(deadlineReuse.receipt.state, "SUCCEEDED"); assert.equal(deadlineReuse.receipt.complete, true);
    assert.equal(typeof deadlineReuse.rows[0][1], "string");
    const deadlineReuseCalls = fixture.calls.slice(deadlineReuseSegment), deadlineReuseActions = actions.slice(deadlineReuseActionSegment);
    assert.deepEqual(deadlineReuseCalls.map(call => call.action), ["GetWorkGroup", "StartQueryExecution", "GetQueryExecution", "GetQueryResults"]);
    assert.equal(deadlineReuseActions.length, 4); assert.equal(actions.length, 61);
    deadlineFacts = { ...deadlineFacts, reuseAdditional: deadlineReuseActions.length, combinedPredicted: 61, totalActions: actions.length };
    assert.equal(dispatchCase.armed, false);
    const leaseWide = "wide-" + "x".repeat(4096);
    const leaseCaller = new AbortController();
    const leaseProviderEntered = deferred(), leaseProviderRelease = deferred(), leaseProviderSettled = deferred();
    let leaseProviderCalls = 0, leaseHold = true, leaseProviderSettledFlag = false;
    const leaseProvider = () => {
      leaseProviderCalls++; leaseProviderEntered.resolve();
      const result = leaseHold ? leaseProviderRelease.promise.then(() => credentials) : Promise.resolve(credentials);
      result.then(() => { leaseProviderSettledFlag = true; leaseProviderSettled.resolve(); }, () => undefined);
      return result;
    };
    const leaseFetch = createTrustedFetch(server.port);
    let leaseFetchCalls = 0;
    const leaseFetchObserved = (input, init) => { leaseFetchCalls++; return leaseFetch(input, init); };
    const leaseSegment = fixture.calls.length, leaseActionSegment = actions.length;
    const leaseStopsBefore = actions.filter(value => value === "StopQueryExecution").length;
    let leaseClient, leaseOutcome, leaseDelivered = false, leaseFacts;
    fixture.states = ["SUCCEEDED"];
    fixture.pages.splice(0, fixture.pages.length, result([["lease-a", null, leaseWide]], undefined, true));
    try {
      leaseClient = createAthenaNodeClient({ source, credentials: leaseProvider, fetch: leaseFetchObserved, maxConcurrent: 1, pollIntervalMs: 0, timeoutMs: 5000,
        maxCursorBytes: 16777216, maxCursorNodes: 65536 });
      assert.equal(leaseProviderCalls, 0); assert.equal(leaseFetchCalls, 0);
      leaseOutcome = leaseClient.queryPage({ ...query(), limit: 1 }, { signal: leaseCaller.signal, pageSize: 2 }).then(
        value => { leaseDelivered = true; return { cancelled: false, error: undefined, value }; },
        error => ({ cancelled: true, error, value: undefined })
      );
      let leaseEnterTimer, leaseFirst;
      try {
        leaseFirst = await Promise.race([
          leaseProviderEntered.promise.then(() => ({ kind: "entered" })),
          leaseOutcome.then(() => ({ kind: "outcome" })),
          new Promise((_, reject) => { leaseEnterTimer = setTimeout(() => reject(new Error("late credential provider entry deadline")), 5000); })
        ]);
      } finally { clearTimeout(leaseEnterTimer); }
      assert.equal(leaseFirst.kind, "entered");
      assert.equal(leaseProviderCalls, 1); assert.equal(leaseProviderSettledFlag, false);
      assert.equal(leaseFetchCalls, 0); assert.equal(fixture.calls.length, leaseSegment); assert.equal(actions.length, leaseActionSegment);
      const PRIVATE_LATE_CREDENTIAL = "PRIVATE_LATE_CREDENTIAL", leaseAbortedAt = Date.now();
      leaseCaller.abort(new Error(PRIVATE_LATE_CREDENTIAL));
      let leaseCleanupTimer, leaseResult;
      try {
        leaseResult = await Promise.race([leaseOutcome, new Promise((_, reject) => { leaseCleanupTimer = setTimeout(() => reject(new Error("late credential cancellation deadline")), 2000); })]);
      } finally { clearTimeout(leaseCleanupTimer); }
      assert.ok(Date.now() - leaseAbortedAt <= 2000);
      assert.equal(leaseResult.cancelled, true); assert.equal(leaseDelivered, false); assert.equal(leaseResult.value, undefined);
      const leaseCancellation = leaseResult.error;
      assert.ok(leaseCancellation instanceof QueryCancelledError);
      assert.equal(Object.getPrototypeOf(leaseCancellation), QueryCancelledError.prototype);
      assert.equal(leaseCancellation.reason, "caller");
      assert.equal(String(leaseCancellation.message).includes(PRIVATE_LATE_CREDENTIAL), false);
      assert.equal(leaseCancellation.cause, undefined);
      assert.equal(leaseProviderSettledFlag, false); assert.equal(leaseProviderCalls, 1);
      assert.equal(leaseFetchCalls, 0); assert.equal(fixture.calls.length, leaseSegment); assert.equal(actions.length, leaseActionSegment);
      let leaseBusyRead;
      try {
        leaseBusyRead = await leaseClient.queryPage({ ...query(), limit: 1 }, { pageSize: 2 }).then(
          value => ({ admitted: true, error: undefined, value }), error => ({ admitted: false, error, value: undefined }));
      } catch (error) { leaseBusyRead = { admitted: false, error, value: undefined }; }
      assert.equal(leaseBusyRead.admitted, false);
      assert.ok(leaseBusyRead.error instanceof AthenaError);
      assert.equal(Object.getPrototypeOf(leaseBusyRead.error), AthenaError.prototype);
      assert.equal(leaseBusyRead.error.code, "busy");
      const leaseDatabase = new AthenaDatabase(leaseClient);
      let leaseEmptyBusy;
      try {
        leaseEmptyBusy = await leaseDatabase.getMany([]).then(
          value => ({ admitted: true, error: undefined, value }), error => ({ admitted: false, error, value: undefined }));
      } catch (error) { leaseEmptyBusy = { admitted: false, error, value: undefined }; }
      assert.equal(leaseEmptyBusy.admitted, false);
      assert.ok(leaseEmptyBusy.error instanceof AthenaError);
      assert.equal(Object.getPrototypeOf(leaseEmptyBusy.error), AthenaError.prototype);
      assert.equal(leaseEmptyBusy.error.code, "busy");
      assert.equal(leaseProviderCalls, 1); assert.equal(leaseFetchCalls, 0);
      assert.equal(fixture.calls.length, leaseSegment); assert.equal(actions.length, leaseActionSegment);
      assert.equal(actions.filter(value => value === "StopQueryExecution").length, leaseStopsBefore);
      leaseHold = false; leaseProviderRelease.resolve();
      let leaseSettledTimer;
      try {
        await Promise.race([leaseProviderSettled.promise, new Promise((_, reject) => { leaseSettledTimer = setTimeout(() => reject(new Error("late credential provider settlement deadline")), 2000); })]);
      } finally { clearTimeout(leaseSettledTimer); }
      assert.equal(leaseProviderSettledFlag, true);
      let leaseProbes = 0, leaseCapacity;
      const leaseProbeDeadline = Date.now() + 1000;
      for (;;) {
        if (leaseProbes >= 64) throw new Error("late credential capacity probe count exceeded");
        if (Date.now() > leaseProbeDeadline) throw new Error("late credential capacity probe deadline");
        leaseProbes++;
        let probe;
        try { probe = { admitted: true, value: await leaseDatabase.getMany([]), error: undefined }; }
        catch (error) { probe = { admitted: false, value: undefined, error }; }
        assert.equal(leaseProviderCalls, 1); assert.equal(leaseFetchCalls, 0);
        assert.equal(fixture.calls.length, leaseSegment); assert.equal(actions.length, leaseActionSegment);
        if (probe.admitted) { assert.deepEqual(probe.value, []); leaseCapacity = probe.value; break; }
        assert.ok(probe.error instanceof AthenaError);
        assert.equal(Object.getPrototypeOf(probe.error), AthenaError.prototype);
        assert.equal(probe.error.code, "busy");
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.deepEqual(leaseCapacity, []);
      const leaseLateCallsStillZero = fixture.calls.length === leaseSegment;
      assert.equal(leaseLateCallsStillZero, true);
      const leaseReadSegment = fixture.calls.length, leaseReadActionSegment = actions.length;
      const leaseRead = await leaseClient.queryPage({ ...query(), limit: 1 }, { pageSize: 2 });
      const leaseReadCalls = fixture.calls.slice(leaseReadSegment), leaseReadActions = actions.slice(leaseReadActionSegment);
      const leaseStarts = leaseReadCalls.filter(call => call.action === "StartQueryExecution");
      const leaseResults = leaseReadCalls.filter(call => call.action === "GetQueryResults");
      assert.deepEqual(leaseReadActions, ["GetWorkGroup", "StartQueryExecution", "GetQueryExecution", "GetQueryResults"]);
      assert.equal(leaseStarts.length, 1); assert.equal(leaseResults.length, 1);
      assert.equal(leaseFetchCalls, 4); assert.equal(leaseProviderCalls, 2);
      assert.equal(actions.length, leaseActionSegment + 4);
      assert.equal(leaseRead.rows.length, 1); assert.equal(leaseRead.rows[0][0], "lease-a");
      assert.equal(leaseRead.rows[0][1], null); assert.equal(leaseRead.rows[0][2], leaseWide);
      assert.equal(typeof leaseRead.rows[0][2], "string");
      assert.deepEqual(leaseRead.columns, [
        { name: "id", type: "varchar" },
        { name: "amount", type: "decimal", precision: 38, scale: 10 },
        { name: "note", type: "varchar" }
      ]);
      assert.equal(leaseRead.receipt.state, "SUCCEEDED"); assert.equal(leaseRead.receipt.complete, true);
      assert.equal(leaseRead.hasMore, false); assert.equal(leaseRead.nextCursor, undefined);
      leaseFacts = { before: leaseSegment, actions: leaseReadActions, starts: leaseStarts.length, results: leaseResults.length,
        cancelled: leaseCancellation instanceof QueryCancelledError, reasonCaller: leaseCancellation.reason === "caller",
        prototypeExact: Object.getPrototypeOf(leaseCancellation) === QueryCancelledError.prototype,
        privateHidden: !String(leaseCancellation.message).includes("PRIVATE") && leaseCancellation.cause === undefined,
        causeLeaked: leaseCancellation.cause !== undefined, delivered: leaseDelivered, valueAbsent: leaseResult.value === undefined,
        provider: { callsDuringCancellation: 1, callsAfterRecovery: leaseProviderCalls, entered: true, settledWhilePending: false, settledAfterRelease: leaseProviderSettledFlag },
        busyBeforeProviderSettlement: { validRead: leaseBusyRead.error.code, emptyBatch: leaseEmptyBusy.error.code,
          providerCalls: 1, fetchCalls: 0, awsActions: 0, stops: 0 },
        capacity: { probes: leaseProbes, admitted: true, empty: true, actual: leaseCapacity, providerCalls: 1, fetchCalls: 0, awsActions: 0 },
        lateAttemptDispatchedRequests: leaseLateCallsStillZero ? 0 : -1,
        recovery: { fetchCalls: leaseFetchCalls, providerCalls: leaseProviderCalls, rows: leaseRead.rows, columns: leaseRead.columns,
          ordinalStart: leaseRead.ordinalStart, hasMore: leaseRead.hasMore, nextCursor: leaseRead.nextCursor ?? null,
          state: leaseRead.receipt.state, complete: leaseRead.receipt.complete },
        sameClient: true, combinedPredicted: 65, totalActions: actions.length, notAQuotaProof: true,
        notProven: ["cursorPreservation", "lateFetchBodyRetention", "aggregateCursorQuota", "remoteStop", "fullCancellationGroup"] };
    } finally {
      if (!leaseCaller.signal.aborted) leaseCaller.abort(new Error("PRIVATE_LEASE_CLEANUP"));
      leaseHold = false; leaseProviderRelease.resolve();
      if (leaseProviderCalls > 0) {
        let leaseProviderTimer;
        try { await Promise.race([leaseProviderSettled.promise, new Promise(resolve => { leaseProviderTimer = setTimeout(resolve, 2000); })]); }
        finally { clearTimeout(leaseProviderTimer); }
      }
      if (leaseOutcome !== undefined) {
        let leaseJoinTimer;
        try { await Promise.race([leaseOutcome, new Promise(resolve => { leaseJoinTimer = setTimeout(resolve, 2000); })]); }
        finally { clearTimeout(leaseJoinTimer); }
      }
      leaseClient?.close();
    }
    const lateFetchBase = createTrustedFetch(server.port);
    const lateFetchSegment = fixture.calls.length, lateFetchActionSegment = actions.length, lateFetchPriorActions = actions.length;
    assert.equal(lateFetchPriorActions, 65);
    const lateFetchResponseReady = deferred(), lateFetchRelease = deferred(), lateFetchCancelEntered = deferred(),
      lateFetchCancelDeferred = deferred(), lateFetchNativeDone = deferred();
    let lateFetchHold = true, lateFetchCalls = 0, lateFetchProviderCalls = 0, lateFetchCapture, lateFetchReleased = false,
      lateFetchReturned = false, lateFetchDelivered = false, lateFetchCancelEntries = 0, lateFetchReaderEntries = 0, lateFetchCancelHanded = false, lateFetchCancelSettled = false,
      lateFetchNativeSettled = false, lateFetchNativeRejected = false, lateFetchCleanupStarted = false;
    const lateFetch = (lateFetchInput, lateFetchOptions) => {
      lateFetchCalls++;
      if (!lateFetchHold) return lateFetchBase(lateFetchInput, lateFetchOptions);
      lateFetchHold = false;
      const lateFetchHeaders = new Headers(lateFetchOptions.headers), lateFetchTarget = lateFetchHeaders.get("x-amz-target");
      assert.equal(lateFetchInput, "https://athena.us-east-1.amazonaws.com/");
      assert.equal(lateFetchTarget, "AmazonAthena.GetWorkGroup");
      const { signal: lateFetchIgnoredSignal, ...lateFetchRest } = lateFetchOptions;
      void lateFetchIgnoredSignal;
      return (async () => {
        const lateFetchResponse = await lateFetchBase(lateFetchInput, lateFetchRest);
        assert.ok(lateFetchResponse instanceof Response);
        if (lateFetchCleanupStarted) {
          const lateFetchLateBody = lateFetchResponse.body;
          if (lateFetchLateBody !== null) {
            try {
              const lateFetchLateNative = lateFetchLateBody.cancel();
              if (lateFetchLateNative !== undefined) Promise.resolve(lateFetchLateNative).catch(() => { /* Late arrival cleanup only. */ });
            } catch { /* Owned late arrival cleanup only. */ }
          }
          return lateFetchResponse;
        }
        const lateFetchBody = lateFetchResponse.body;
        if (lateFetchBody === null) throw new Error("late fetch body missing");
        assert.equal(lateFetchBody.locked, false);
        const lateFetchNativeCancel = lateFetchBody.cancel.bind(lateFetchBody);
        const lateFetchNativeGetReader = lateFetchBody.getReader.bind(lateFetchBody);
        lateFetchBody.getReader = (...lateFetchReaderArgs) => { lateFetchReaderEntries++; return lateFetchNativeGetReader(...lateFetchReaderArgs); };
        lateFetchCapture = { response: lateFetchResponse, body: lateFetchBody, nativeCancel: lateFetchNativeCancel };
        lateFetchBody.cancel = () => {
          lateFetchCancelEntries++; lateFetchCancelHanded = true; lateFetchCancelEntered.resolve();
          let lateFetchNative;
          try { lateFetchNative = lateFetchNativeCancel(); }
          catch { lateFetchNativeRejected = true; lateFetchNativeDone.resolve(); }
          if (lateFetchNative !== undefined) Promise.resolve(lateFetchNative).then(
            () => { lateFetchNativeSettled = true; lateFetchNativeDone.resolve(); },
            () => { lateFetchNativeRejected = true; lateFetchNativeSettled = true; lateFetchNativeDone.resolve(); });
          else lateFetchNativeDone.resolve();
          return lateFetchCancelDeferred.promise;
        };
        lateFetchResponseReady.resolve();
        await lateFetchRelease.promise;
        const lateFetchHeld = lateFetchCapture.response;
        assert.equal(lateFetchHeld, lateFetchResponse);
        lateFetchReturned = true;
        return lateFetchHeld;
      })();
    };
    const lateFetchCaller = new AbortController();
    let lateFetchClient, lateFetchOutcome, lateFetchFacts;
    try {
      lateFetchClient = createAthenaNodeClient({ source, credentials: async () => { lateFetchProviderCalls++; return credentials; }, fetch: lateFetch,
        maxConcurrent: 1, pollIntervalMs: 0, timeoutMs: 5000, maxCursorBytes: 16777216, maxCursorNodes: 65536 });
      const lateFetchDatabase = new AthenaDatabase(lateFetchClient);
      assert.equal(lateFetchProviderCalls, 0); assert.equal(lateFetchCalls, 0);
      assert.equal(actions.length, lateFetchActionSegment); assert.equal(fixture.calls.length, lateFetchSegment);
      fixture.states = ["SUCCEEDED"];
      fixture.pages.splice(0, fixture.pages.length, result([["late-fetch", null, "late-fetch-note"]], undefined, true));
      lateFetchOutcome = lateFetchClient.queryPage({ ...query(), limit: 1 }, { signal: lateFetchCaller.signal, pageSize: 2 }).then(
        value => { lateFetchDelivered = true; return { cancelled: false, error: undefined, value }; },
        error => ({ cancelled: true, error, value: undefined }));
      let lateFetchResponseTimer;
      try { await Promise.race([lateFetchResponseReady.promise, new Promise((_, reject) => { lateFetchResponseTimer = setTimeout(() => reject(new Error("late fetch response deadline")), 5000); })]); }
      finally { clearTimeout(lateFetchResponseTimer); }
      assert.notEqual(lateFetchCapture, undefined); assert.equal(lateFetchReturned, false);
      assert.equal(lateFetchCalls, 1); assert.equal(lateFetchProviderCalls, 1);
      assert.equal(fixture.calls.length, lateFetchSegment + 1); assert.equal(actions.length, lateFetchActionSegment + 1);
      assert.equal(actions[lateFetchActionSegment], "GetWorkGroup");
      assert.equal(actions.slice(lateFetchActionSegment).filter(value => value === "StartQueryExecution").length, 0);
      const LATE_FETCH_PRIVATE_CALLER = "LATE_FETCH_PRIVATE_CALLER", lateFetchAbortedAt = Date.now();
      lateFetchCaller.abort(new Error(LATE_FETCH_PRIVATE_CALLER));
      let lateFetchCancellationTimer, lateFetchResult;
      try { lateFetchResult = await Promise.race([lateFetchOutcome, new Promise((_, reject) => { lateFetchCancellationTimer = setTimeout(() => reject(new Error("late fetch cancellation deadline")), 2000); })]); }
      finally { clearTimeout(lateFetchCancellationTimer); }
      const lateFetchCleanupMs = Date.now() - lateFetchAbortedAt;
      assert.ok(lateFetchCleanupMs <= 2000);
      assert.equal(lateFetchResult.cancelled, true); assert.equal(lateFetchResult.value, undefined); assert.equal(lateFetchReturned, false); assert.equal(lateFetchDelivered, false);
      const lateFetchCancellation = lateFetchResult.error;
      assert.ok(lateFetchCancellation instanceof QueryCancelledError);
      assert.equal(Object.getPrototypeOf(lateFetchCancellation), QueryCancelledError.prototype);
      assert.equal(lateFetchCancellation.reason, "caller");
      assert.equal(String(lateFetchCancellation.message).includes(LATE_FETCH_PRIVATE_CALLER), false);
      assert.equal(lateFetchCancellation.cause, undefined);
      const lateFetchBusy = async lateFetchPromise => {
        try { return { admitted: true, value: await lateFetchPromise, error: undefined }; }
        catch (error) { return { admitted: false, value: undefined, error }; }
      };
      const lateFetchBusyRead = await lateFetchBusy(lateFetchClient.queryPage({ ...query(), limit: 1 }, { pageSize: 2 }));
      const lateFetchBusyEmpty = await lateFetchBusy(lateFetchDatabase.getMany([]));
      for (const lateFetchBusyResult of [lateFetchBusyRead, lateFetchBusyEmpty]) {
        assert.equal(lateFetchBusyResult.admitted, false);
        assert.ok(lateFetchBusyResult.error instanceof AthenaError);
        assert.equal(Object.getPrototypeOf(lateFetchBusyResult.error), AthenaError.prototype);
        assert.equal(lateFetchBusyResult.error.code, "busy");
      }
      assert.equal(lateFetchProviderCalls, 1); assert.equal(lateFetchCalls, 1);
      assert.equal(fixture.calls.length, lateFetchSegment + 1); assert.equal(actions.length, lateFetchActionSegment + 1);
      lateFetchReleased = true; lateFetchRelease.resolve();
      let lateFetchCancelTimer;
      try { await Promise.race([lateFetchCancelEntered.promise, new Promise((_, reject) => { lateFetchCancelTimer = setTimeout(() => reject(new Error("late fetch body cancel deadline")), 5000); })]); }
      finally { clearTimeout(lateFetchCancelTimer); }
      assert.equal(lateFetchCancelEntries, 1); assert.equal(lateFetchReturned, true);
      assert.equal(lateFetchReaderEntries, 0);
      assert.equal(lateFetchCapture.body.locked, false);
      assert.equal(lateFetchResult.cancelled, true); assert.equal(lateFetchResult.error, lateFetchCancellation);
      const lateFetchHeldBusy = await lateFetchBusy(lateFetchDatabase.getMany([]));
      assert.equal(lateFetchHeldBusy.admitted, false);
      assert.ok(lateFetchHeldBusy.error instanceof AthenaError);
      assert.equal(Object.getPrototypeOf(lateFetchHeldBusy.error), AthenaError.prototype);
      assert.equal(lateFetchHeldBusy.error.code, "busy");
      assert.equal(lateFetchProviderCalls, 1); assert.equal(lateFetchCalls, 1);
      assert.equal(fixture.calls.length, lateFetchSegment + 1); assert.equal(actions.length, lateFetchActionSegment + 1);
      const lateFetchNativeSettledWhileHeld = lateFetchNativeSettled;
      const LATE_FETCH_PRIVATE_CANCEL = new Error("LATE_FETCH_PRIVATE_CANCEL");
      assert.equal(lateFetchCancelHanded, true);
      lateFetchCancelSettled = true; lateFetchCancelDeferred.reject(LATE_FETCH_PRIVATE_CANCEL);
      let lateFetchProbes = 0, lateFetchCapacity;
      const lateFetchProbeDeadline = Date.now() + 1000;
      for (;;) {
        if (lateFetchProbes >= 64) throw new Error("late fetch capacity probe count exceeded");
        if (Date.now() > lateFetchProbeDeadline) throw new Error("late fetch capacity probe deadline");
        lateFetchProbes++;
        const lateFetchProbe = await lateFetchBusy(lateFetchDatabase.getMany([]));
        assert.equal(lateFetchProviderCalls, 1); assert.equal(lateFetchCalls, 1);
        assert.equal(fixture.calls.length, lateFetchSegment + 1); assert.equal(actions.length, lateFetchActionSegment + 1);
        if (lateFetchProbe.admitted) { assert.deepEqual(lateFetchProbe.value, []); lateFetchCapacity = lateFetchProbe.value; break; }
        assert.ok(lateFetchProbe.error instanceof AthenaError);
        assert.equal(Object.getPrototypeOf(lateFetchProbe.error), AthenaError.prototype);
        assert.equal(lateFetchProbe.error.code, "busy");
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.deepEqual(lateFetchCapacity, []);
      lateFetchHold = false;
      const lateFetchReadSegment = fixture.calls.length, lateFetchReadActionSegment = actions.length;
      const lateFetchRead = await lateFetchClient.queryPage({ ...query(), limit: 1 }, { pageSize: 2 });
      const lateFetchReadCalls = fixture.calls.slice(lateFetchReadSegment), lateFetchReadActions = actions.slice(lateFetchReadActionSegment);
      const lateFetchStarts = lateFetchReadCalls.filter(call => call.action === "StartQueryExecution");
      const lateFetchResults = lateFetchReadCalls.filter(call => call.action === "GetQueryResults");
      assert.deepEqual(lateFetchReadActions, ["GetWorkGroup", "StartQueryExecution", "GetQueryExecution", "GetQueryResults"]);
      assert.equal(lateFetchStarts.length, 1); assert.equal(lateFetchResults.length, 1); assert.equal(lateFetchCalls, 5); assert.equal(lateFetchProviderCalls, 2);
      assert.deepEqual(lateFetchRead.rows, [["late-fetch", null, "late-fetch-note"]]);
      assert.equal(typeof lateFetchRead.rows[0][0], "string"); assert.equal(lateFetchRead.rows[0][1], null); assert.equal(typeof lateFetchRead.rows[0][2], "string");
      assert.deepEqual(lateFetchRead.columns, page.columns);
      assert.equal(lateFetchRead.ordinalStart, 0); assert.equal(lateFetchRead.hasMore, false); assert.equal(lateFetchRead.nextCursor, undefined);
      assert.equal(lateFetchRead.receipt.state, "SUCCEEDED"); assert.equal(lateFetchRead.receipt.complete, true);
      assert.equal(actions.length, lateFetchPriorActions + 5);
      assert.equal(actions.slice(lateFetchActionSegment).filter(value => value === "StopQueryExecution").length, 0);
      lateFetchFacts = {
        before: lateFetchPriorActions,
        heldFetch: { calls: 1, withheld: true, ignoredSignal: true, realResponse: true, unlockedBody: true, cancelEntries: lateFetchCancelEntries, readerAcquisitions: lateFetchReaderEntries, nativeSettled: lateFetchNativeSettled, nativeRejected: lateFetchNativeRejected },
        cancellation: { cancelled: lateFetchCancellation instanceof QueryCancelledError, reasonCaller: lateFetchCancellation.reason === "caller", prototypeExact: Object.getPrototypeOf(lateFetchCancellation) === QueryCancelledError.prototype, privateHidden: !String(lateFetchCancellation.message).includes(LATE_FETCH_PRIVATE_CALLER) && lateFetchCancellation.cause === undefined, causeLeaked: lateFetchCancellation.cause !== undefined, delivered: lateFetchDelivered, valueAbsent: lateFetchResult.value === undefined, cleanupMs: lateFetchCleanupMs },
        busyBeforeSettlement: { validRead: lateFetchBusyRead.error.code, emptyBatch: lateFetchBusyEmpty.error.code, providerCalls: 1, fetchCalls: 1, awsActions: 1 },
        retainedCleanup: { emptyBatchBusyWhileCancelPending: lateFetchHeldBusy.error.code === "busy", providerCalls: 1, fetchCalls: 1, awsActions: 1, cancelEntries: lateFetchCancelEntries, nativeSettledWhileHeld: lateFetchNativeSettledWhileHeld },
        capacity: { probes: lateFetchProbes, admitted: true, empty: true, actual: lateFetchCapacity, providerCalls: 1, fetchCalls: 1, awsActions: 1 },
        recovery: { actions: lateFetchReadActions, starts: lateFetchStarts.length, results: lateFetchResults.length, fetchCalls: lateFetchCalls, providerCalls: lateFetchProviderCalls, rows: lateFetchRead.rows, columns: lateFetchRead.columns, ordinalStart: lateFetchRead.ordinalStart, hasMore: lateFetchRead.hasMore, nextCursor: lateFetchRead.nextCursor ?? null, state: lateFetchRead.receipt.state, complete: lateFetchRead.receipt.complete },
        predictedNewRequests: 5, actualNewRequests: actions.length - lateFetchActionSegment, predictedTotal: lateFetchPriorActions + 5, actualTotal: actions.length,
        sameClient: true, notAQuotaProof: true,
        notProven: ["permanentNeverSettlement", "serverDisconnectFromCancelEntry", "nativeSourceCancelCallback", "cursorPreservation", "aggregateCursorQuota", "fullLateBodyGroup", "fullConsumerQualification"] };
    } finally {
      lateFetchCleanupStarted = true;
      if (!lateFetchCaller.signal.aborted) lateFetchCaller.abort(new Error("LATE_FETCH_PRIVATE_CLEANUP"));
      lateFetchHold = false;
      if (lateFetchCapture !== undefined && !lateFetchReleased) {
        try {
          const lateFetchCleanupNative = lateFetchCapture.nativeCancel();
          if (lateFetchCleanupNative !== undefined) Promise.resolve(lateFetchCleanupNative).catch(() => { /* Owned failure-path native cleanup rejection. */ });
        } catch { /* Owned failure-path response cleanup. */ }
        lateFetchReleased = true;
      }
      lateFetchRelease.resolve();
      if (!lateFetchCancelSettled) {
        lateFetchCancelSettled = true;
        if (lateFetchCancelHanded) lateFetchCancelDeferred.reject(new Error("LATE_FETCH_PRIVATE_CANCEL_CLEANUP"));
        else lateFetchCancelDeferred.resolve();
      }
      if (lateFetchOutcome !== undefined) {
        let lateFetchOutcomeTimer;
        try { await Promise.race([lateFetchOutcome, new Promise(resolve => { lateFetchOutcomeTimer = setTimeout(resolve, 2000); })]); }
        finally { clearTimeout(lateFetchOutcomeTimer); }
      }
      if (lateFetchCancelHanded) {
        let lateFetchNativeTimer;
        try { await Promise.race([lateFetchNativeDone.promise, new Promise(resolve => { lateFetchNativeTimer = setTimeout(resolve, 2000); })]); }
        finally { clearTimeout(lateFetchNativeTimer); }
      }
      lateFetchClient?.close();
    }
    const quotaCasePriorActions = actions.slice();
    const quotaCasePriorColumns = JSON.stringify(page.columns);
    const quotaCasePriorRows = JSON.stringify(page.rows);
    const quotaCasePriorPage = JSON.stringify({ ordinalStart: page.ordinalStart, hasMore: page.hasMore, nextCursor: page.nextCursor ?? null, receipt: page.receipt });
    const quotaCaseId = "i".repeat(1_048_576);
    const quotaCaseNote = "n".repeat(2_097_152);
    const quotaCaseIdHash = hash(quotaCaseId);
    const quotaCaseNoteHash = hash(quotaCaseNote);
    const quotaCaseTerminal = result([[quotaCaseId, null, quotaCaseNote]]);
    const quotaCaseResponseBytes = Buffer.byteLength(JSON.stringify(quotaCaseTerminal));
    assert.ok(quotaCaseResponseBytes > 3_000_000);
    assert.ok(quotaCaseResponseBytes <= 4_194_304);
    const quotaCaseOriginalCredentials = Object.freeze({ accessKeyId: "AKIDOWNEDSMOKE", secretAccessKey: "owned/secret", sessionToken: "owned/session", principal: "owned-reader", generation: "one" });
    let quotaCaseCredentials = quotaCaseOriginalCredentials;
    let quotaCaseCredentialCalls = 0;
    const quotaCaseBaseFetch = createTrustedFetch(server.port);
    let quotaCaseFetchCalls = 0;
    const quotaCaseFetch = (input, init) => { quotaCaseFetchCalls++; return quotaCaseBaseFetch(input, init); };
    const quotaCaseCountResults = () => fixture.calls.filter(call => call.action === "GetQueryResults").length;
    const quotaCaseCountStarts = () => fixture.calls.filter(call => call.action === "StartQueryExecution").length;
    const quotaCaseActionSegment = actions.length;
    let quotaCaseClient, quotaFacts;
    try {
      quotaCaseClient = createAthenaNodeClient({ source, credentials: async () => { quotaCaseCredentialCalls++; return quotaCaseCredentials; }, fetch: quotaCaseFetch, pollIntervalMs: 0, timeoutMs: 5000 });
      fixture.states = ["SUCCEEDED"];
      fixture.pages.splice(0, fixture.pages.length, result([], "p1", true), quotaCaseTerminal);
      assert.equal(quotaCaseCredentialCalls, 0);
      assert.equal(quotaCaseFetchCalls, 0);
      const quotaCaseFirstPages = [], quotaCaseCursors = [];
      for (let index = 0; index < 6; index++) {
        const quotaCaseFirst = await quotaCaseClient.queryPage(query(3), { pageSize: 1 });
        assert.deepEqual(quotaCaseFirst.rows, []);
        assert.equal(quotaCaseFirst.ordinalStart, 0);
        assert.equal(quotaCaseFirst.hasMore, true);
        assert.equal(quotaCaseFirst.receipt.sourceId, source.sourceId);
        assert.equal(quotaCaseFirst.receipt.complete, false);
        if (quotaCaseFirst.nextCursor === undefined) throw new Error("missing quota cursor");
        quotaCaseFirstPages.push(quotaCaseFirst);
        quotaCaseCursors.push(quotaCaseFirst.nextCursor);
      }
      assert.equal(new Set(quotaCaseFirstPages.map(value => value.receipt.queryId)).size, 6);
      assert.equal(new Set(quotaCaseFirstPages.map(value => value.nextCursor)).size, 6);
      const quotaCasePermission = async changed => {
        const quotaCasePermissionCalls = fixture.calls.length, quotaCasePermissionActions = actions.length,
          quotaCasePermissionFetch = quotaCaseFetchCalls, quotaCasePermissionCredentials = quotaCaseCredentialCalls;
        let quotaCasePermissionError;
        quotaCaseCredentials = changed;
        try {
          await assert.rejects(quotaCaseClient.nextPage(quotaCaseCursors[0]), error => {
            quotaCasePermissionError = error;
            assert.ok(error instanceof AthenaError);
            assert.equal(Object.getPrototypeOf(error), AthenaError.prototype);
            assert.equal(error.code, "permission");
            assert.equal(error.cause, undefined);
            return true;
          });
        } finally { quotaCaseCredentials = quotaCaseOriginalCredentials; }
        assert.equal(fixture.calls.length, quotaCasePermissionCalls);
        assert.equal(actions.length, quotaCasePermissionActions);
        assert.equal(quotaCaseFetchCalls, quotaCasePermissionFetch);
        assert.equal(quotaCaseCredentialCalls, quotaCasePermissionCredentials + 1);
        return quotaCasePermissionError;
      };
      const quotaCasePrincipalError = await quotaCasePermission({ ...quotaCaseOriginalCredentials, principal: "owned-reader-other" });
      const quotaCaseGenerationError = await quotaCasePermission({ ...quotaCaseOriginalCredentials, generation: "two" });
      quotaCaseCredentials = quotaCaseOriginalCredentials;
      let quotaCaseFactoryEntries = 0, quotaCaseFactoryVerified = 0, quotaCaseFactoryVerificationError;
      for (let index = 0; index < 4; index++) {
        const quotaCaseRetainCalls = fixture.calls.length, quotaCaseRetainActions = actions.length,
          quotaCaseRetainResults = quotaCaseCountResults(), quotaCaseRetainStarts = quotaCaseCountStarts(), quotaCaseRetainFetch = quotaCaseFetchCalls;
        const quotaCasePrivateFactory = new Error("PRIVATE_QUOTA_FACTORY_" + index);
        await assert.rejects(quotaCaseClient.mapNextPage(quotaCaseCursors[index], undefined, quotaCasePage => {
          quotaCaseFactoryEntries++;
          try {
            const quotaCaseRow = quotaCasePage.rows[0];
            assert.equal(quotaCasePage.rows.length, 1);
            if (quotaCaseRow === undefined) throw new Error("missing quota row");
            assert.equal(quotaCaseRow.length, 3);
            assert.equal(quotaCaseRow[0]?.length, quotaCaseId.length);
            assert.equal(quotaCaseRow[1], null);
            assert.equal(quotaCaseRow[2]?.length, quotaCaseNote.length);
            assert.equal(hash(quotaCaseRow[0] ?? ""), quotaCaseIdHash);
            assert.equal(hash(quotaCaseRow[2] ?? ""), quotaCaseNoteHash);
            assert.equal(quotaCasePage.ordinalStart, 0);
            assert.equal(quotaCasePage.receipt.queryId, quotaCaseFirstPages[index].receipt.queryId);
            quotaCaseFactoryVerified++;
          } catch (error) { if (quotaCaseFactoryVerificationError === undefined) quotaCaseFactoryVerificationError = error; }
          throw quotaCasePrivateFactory;
        }), error => {
          assert.ok(error instanceof AthenaError);
          assert.equal(Object.getPrototypeOf(error), AthenaError.prototype);
          assert.equal(error.code, "transport");
          assert.equal(error.cause, undefined);
          assert.equal(String(error.message).includes("PRIVATE_QUOTA_FACTORY"), false);
          return true;
        });
        if (quotaCaseFactoryVerificationError !== undefined) throw quotaCaseFactoryVerificationError;
        assert.equal(fixture.calls.length, quotaCaseRetainCalls + 1);
        assert.equal(actions.length, quotaCaseRetainActions + 1);
        assert.equal(actions[quotaCaseRetainActions], "GetQueryResults");
        assert.equal(quotaCaseCountResults(), quotaCaseRetainResults + 1);
        assert.equal(quotaCaseCountStarts(), quotaCaseRetainStarts);
        assert.equal(quotaCaseFetchCalls, quotaCaseRetainFetch + 1);
      }
      assert.equal(quotaCaseFactoryEntries, 4);
      assert.equal(quotaCaseFactoryVerified, 4);
      const quotaCaseDatabase = new AthenaDatabase(quotaCaseClient);
      const quotaCaseEmptyCalls = fixture.calls.length, quotaCaseEmptyActions = actions.length,
        quotaCaseEmptyFetch = quotaCaseFetchCalls, quotaCaseEmptyCredentials = quotaCaseCredentialCalls;
      const quotaCaseEmpty = await quotaCaseDatabase.getMany([]);
      assert.deepEqual(quotaCaseEmpty, []);
      assert.equal(fixture.calls.length, quotaCaseEmptyCalls);
      assert.equal(actions.length, quotaCaseEmptyActions);
      assert.equal(quotaCaseFetchCalls, quotaCaseEmptyFetch);
      assert.equal(quotaCaseCredentialCalls, quotaCaseEmptyCredentials);
      const quotaCaseRefusedCalls = fixture.calls.length, quotaCaseRefusedActions = actions.length,
        quotaCaseRefusedResults = quotaCaseCountResults(), quotaCaseRefusedStarts = quotaCaseCountStarts(),
        quotaCaseRefusedFetch = quotaCaseFetchCalls, quotaCaseRefusedCredentials = quotaCaseCredentialCalls;
      let quotaCaseRefusedFactoryEntries = 0, quotaCaseRefusedError;
      await assert.rejects(quotaCaseClient.mapNextPage(quotaCaseCursors[4], undefined, () => { quotaCaseRefusedFactoryEntries++; }), error => {
        quotaCaseRefusedError = error;
        assert.ok(error instanceof AthenaError);
        assert.equal(Object.getPrototypeOf(error), AthenaError.prototype);
        assert.equal(error.code, "bounds");
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(quotaCaseRefusedFactoryEntries, 0);
      assert.equal(fixture.calls.length, quotaCaseRefusedCalls);
      assert.equal(actions.length, quotaCaseRefusedActions);
      assert.equal(quotaCaseCountResults(), quotaCaseRefusedResults);
      assert.equal(quotaCaseCountStarts(), quotaCaseRefusedStarts);
      assert.equal(quotaCaseFetchCalls, quotaCaseRefusedFetch);
      assert.equal(quotaCaseCredentialCalls, quotaCaseRefusedCredentials + 1);
      const quotaCaseFreshCalls = fixture.calls.length, quotaCaseFreshActions = actions.length,
        quotaCaseFreshResults = quotaCaseCountResults(), quotaCaseFreshStarts = quotaCaseCountStarts(),
        quotaCaseFreshFetch = quotaCaseFetchCalls, quotaCaseFreshCredentials = quotaCaseCredentialCalls;
      let quotaCaseFreshFactoryEntries = 0, quotaCaseFreshError;
      await assert.rejects(quotaCaseClient.mapQueryPage(query(4), { pageSize: 1 }, () => { quotaCaseFreshFactoryEntries++; }), error => {
        quotaCaseFreshError = error;
        assert.ok(error instanceof AthenaError);
        assert.equal(Object.getPrototypeOf(error), AthenaError.prototype);
        assert.equal(error.code, "bounds");
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(quotaCaseFreshFactoryEntries, 0);
      assert.equal(fixture.calls.length, quotaCaseFreshCalls);
      assert.equal(actions.length, quotaCaseFreshActions);
      assert.equal(quotaCaseCountResults(), quotaCaseFreshResults);
      assert.equal(quotaCaseCountStarts(), quotaCaseFreshStarts);
      assert.equal(quotaCaseFetchCalls, quotaCaseFreshFetch);
      assert.equal(quotaCaseCredentialCalls, quotaCaseFreshCredentials);
      const quotaCaseRetryFirstCalls = fixture.calls.length, quotaCaseRetryFirstActions = actions.length,
        quotaCaseRetryFirstResults = quotaCaseCountResults(), quotaCaseRetryFirstStarts = quotaCaseCountStarts(),
        quotaCaseRetryFirstFetch = quotaCaseFetchCalls, quotaCaseRetryFirstCredentials = quotaCaseCredentialCalls;
      const quotaCaseRetryFirst = await quotaCaseClient.nextPage(quotaCaseCursors[0]);
      assert.equal(quotaCaseRetryFirst.receipt.queryId, quotaCaseFirstPages[0].receipt.queryId);
      assert.equal(quotaCaseRetryFirst.ordinalStart, 0);
      assert.equal(quotaCaseRetryFirst.rows.length, 1);
      assert.equal(quotaCaseRetryFirst.rows[0]?.[1], null);
      assert.equal(hash(quotaCaseRetryFirst.rows[0]?.[0] ?? ""), quotaCaseIdHash);
      assert.equal(hash(quotaCaseRetryFirst.rows[0]?.[2] ?? ""), quotaCaseNoteHash);
      assert.equal(quotaCaseRetryFirst.hasMore, false);
      assert.equal(quotaCaseRetryFirst.nextCursor, undefined);
      assert.equal(quotaCaseRetryFirst.receipt.complete, true);
      assert.equal(quotaCaseRetryFirst.receipt.counters.rows, 1);
      assert.equal(quotaCaseRetryFirst.receipt.counters.fetchedRows, 1);
      assert.equal(quotaCaseRetryFirst.receipt.counters.pages, 2);
      assert.ok(quotaCaseRetryFirst.receipt.counters.attempts >= 5);
      assert.equal(fixture.calls.length, quotaCaseRetryFirstCalls);
      assert.equal(actions.length, quotaCaseRetryFirstActions);
      assert.equal(quotaCaseCountResults(), quotaCaseRetryFirstResults);
      assert.equal(quotaCaseCountStarts(), quotaCaseRetryFirstStarts);
      assert.equal(quotaCaseFetchCalls, quotaCaseRetryFirstFetch);
      assert.equal(quotaCaseCredentialCalls, quotaCaseRetryFirstCredentials + 1);
      const quotaCaseFifthCalls = fixture.calls.length, quotaCaseFifthActions = actions.length,
        quotaCaseFifthResults = quotaCaseCountResults(), quotaCaseFifthStarts = quotaCaseCountStarts(),
        quotaCaseFifthFetch = quotaCaseFetchCalls, quotaCaseFifthCredentials = quotaCaseCredentialCalls;
      const quotaCaseFifth = await quotaCaseClient.nextPage(quotaCaseCursors[4]);
      assert.equal(quotaCaseFifth.receipt.queryId, quotaCaseFirstPages[4].receipt.queryId);
      assert.equal(quotaCaseFifth.ordinalStart, 0);
      assert.equal(quotaCaseFifth.rows.length, 1);
      assert.equal(quotaCaseFifth.rows[0]?.[1], null);
      assert.equal(hash(quotaCaseFifth.rows[0]?.[0] ?? ""), quotaCaseIdHash);
      assert.equal(hash(quotaCaseFifth.rows[0]?.[2] ?? ""), quotaCaseNoteHash);
      assert.equal(quotaCaseFifth.nextCursor, undefined);
      assert.equal(quotaCaseFifth.receipt.complete, true);
      assert.equal(fixture.calls.length, quotaCaseFifthCalls + 1);
      assert.equal(actions.length, quotaCaseFifthActions + 1);
      assert.equal(actions[quotaCaseFifthActions], "GetQueryResults");
      assert.equal(quotaCaseCountResults(), quotaCaseFifthResults + 1);
      assert.equal(quotaCaseCountStarts(), quotaCaseFifthStarts);
      assert.equal(quotaCaseFetchCalls, quotaCaseFifthFetch + 1);
      assert.equal(quotaCaseCredentialCalls, quotaCaseFifthCredentials + 1);
      const quotaCaseDrainCalls = fixture.calls.length, quotaCaseDrainActions = actions.length,
        quotaCaseDrainResults = quotaCaseCountResults(), quotaCaseDrainStarts = quotaCaseCountStarts(), quotaCaseDrainFetch = quotaCaseFetchCalls;
      for (const index of [1, 2, 3]) {
        const quotaCaseDrained = await quotaCaseClient.nextPage(quotaCaseCursors[index]);
        assert.equal(quotaCaseDrained.receipt.queryId, quotaCaseFirstPages[index].receipt.queryId);
        assert.equal(quotaCaseDrained.ordinalStart, 0);
        assert.equal(quotaCaseDrained.rows.length, 1);
        assert.equal(quotaCaseDrained.rows[0]?.[1], null);
        assert.equal(hash(quotaCaseDrained.rows[0]?.[0] ?? ""), quotaCaseIdHash);
        assert.equal(hash(quotaCaseDrained.rows[0]?.[2] ?? ""), quotaCaseNoteHash);
        assert.equal(quotaCaseDrained.hasMore, false);
        assert.equal(quotaCaseDrained.nextCursor, undefined);
        assert.equal(quotaCaseDrained.receipt.counters.rows, 1);
        assert.equal(quotaCaseDrained.receipt.counters.fetchedRows, 1);
        assert.equal(quotaCaseDrained.receipt.counters.pages, 2);
      }
      assert.equal(fixture.calls.length, quotaCaseDrainCalls);
      assert.equal(actions.length, quotaCaseDrainActions);
      assert.equal(quotaCaseCountResults(), quotaCaseDrainResults);
      assert.equal(quotaCaseCountStarts(), quotaCaseDrainStarts);
      assert.equal(quotaCaseFetchCalls, quotaCaseDrainFetch);
      assert.equal(JSON.stringify(source), sourceSnapshot);
      assert.equal(JSON.stringify(page.columns), quotaCasePriorColumns);
      assert.equal(JSON.stringify(page.rows), quotaCasePriorRows);
      assert.equal(JSON.stringify({ ordinalStart: page.ordinalStart, hasMore: page.hasMore, nextCursor: page.nextCursor ?? null, receipt: page.receipt }), quotaCasePriorPage);
      const quotaCaseActionCounts = actions.slice(quotaCaseActionSegment).reduce((counts, action) => { counts[action] = (counts[action] ?? 0) + 1; return counts; }, {});
      quotaFacts = {
        defaults: { maxPageBytes: 4_194_304, maxPageNodes: 8_192, maxColumns: 256, maxCursors: 128, maxCursorBytes: 16_777_216, maxCursorNodes: 65_536, maxConcurrent: 4 },
        journeys: { cursors: 6, queryIds: quotaCaseFirstPages.map(value => value.receipt.queryId),
          ordinals: quotaCaseFirstPages.map(value => value.ordinalStart), emptyFirstRows: quotaCaseFirstPages.every(value => value.rows.length === 0),
          sourceIds: [...new Set(quotaCaseFirstPages.map(value => value.receipt.sourceId))], hasMore: quotaCaseFirstPages.every(value => value.hasMore) },
        nativeRow: { idLength: quotaCaseId.length, noteLength: quotaCaseNote.length, amountNull: true,
          responseBytes: quotaCaseResponseBytes, responseLimit: 4_194_304, withinResponseLimit: quotaCaseResponseBytes <= 4_194_304,
          idHash: quotaCaseIdHash, noteHash: quotaCaseNoteHash },
        principalGeneration: { principalCode: quotaCasePrincipalError.code, generationCode: quotaCaseGenerationError.code,
          httpDuring: 0, awsActionsDuring: 0, handlesPreserved: true, restored: true },
        retainedFactory: { count: 4, factoryEntries: quotaCaseFactoryEntries, verified: quotaCaseFactoryVerified,
          rowsPerPage: 1, cellsPerRow: 3, safeTransportErrors: 4, privateTextHidden: true, noSuccessorDelivered: true, activeFactories: 0 },
        capacity: { admitted: true, empty: quotaCaseEmpty.length, providerCalls: 0, fetchCalls: 0, awsActions: 0 },
        refusedFifth: { code: quotaCaseRefusedError.code, providerCalls: 1, fetchCalls: 0, starts: 0, results: 0,
          factoryEntries: 0, handlePreserved: true },
        refusedFresh: { code: quotaCaseFreshError.code, providerCalls: 0, fetchCalls: 0, awsActions: 0, factoryEntries: 0 },
        retryFirst: { queryId: quotaCaseRetryFirst.receipt.queryId, ordinalStart: quotaCaseRetryFirst.ordinalStart,
          rows: quotaCaseRetryFirst.receipt.counters.rows, fetchedRows: quotaCaseRetryFirst.receipt.counters.fetchedRows,
          pages: quotaCaseRetryFirst.receipt.counters.pages, attempts: quotaCaseRetryFirst.receipt.counters.attempts,
          resultRequests: 0, starts: 0, complete: quotaCaseRetryFirst.receipt.complete, nextCursor: quotaCaseRetryFirst.nextCursor ?? null },
        retryFifth: { queryId: quotaCaseFifth.receipt.queryId, ordinalStart: quotaCaseFifth.ordinalStart,
          resultRequests: 1, starts: 0, rows: quotaCaseFifth.receipt.counters.rows,
          fetchedRows: quotaCaseFifth.receipt.counters.fetchedRows, pages: quotaCaseFifth.receipt.counters.pages,
          attempts: quotaCaseFifth.receipt.counters.attempts, nextCursor: quotaCaseFifth.nextCursor ?? null },
        drained: { count: 3, resultRequests: 0, starts: 0 },
        wire: { ...quotaCaseActionCounts, total: actions.length - quotaCaseActionSegment },
        oldOutputUnchanged: true, sourceUnchanged: true,
        notProven: ["actualAwsIamValidity", "cursorTtlExpiry", "finalSummary"]
      };
    } finally {
      quotaCaseCredentials = quotaCaseOriginalCredentials;
      quotaCaseClient?.close();
    }
    partial = { actions: quotaCasePriorActions, columns: page.columns, rows: page.rows, ordinalStart: page.ordinalStart, hasMore: page.hasMore, nextCursor: page.nextCursor, receipt: page.receipt,
      sameQueryPages: { queryId: "query-2", fetchedPages: appendedResults.length, actions: pagingActions, rows: pages.flatMap(value => value.rows),
        ordinals: pages.map(value => value.ordinalStart), tokens: appendedResults.map(call => call.input.NextToken ?? null), startCount: appendedStarts.length,
        states: pages.map(value => value.receipt.state), complete: fifth.receipt.complete, hasMore: fifth.hasMore, nextCursor: fifth.nextCursor ?? null, receiptRows: fifth.receipt.counters.rows }, coreValues,
      bridge: { handler: typeof bridgeHandler === "function", requestFactory: typeof bridgeRequest === "function",
        status: bridgeResponse.status, contentType: bridgeResponse.headers.get("content-type"), cacheControl: bridgeResponse.headers.get("cache-control"),
        nosniff: bridgeResponse.headers.get("x-content-type-options"), topLevelPage: !Object.hasOwn(bridgeFirstPage, "page"),
        rows: bridgeFirstPage.rows, ordinalStart: bridgeFirstPage.ordinalStart, hasMore: bridgeFirstPage.hasMore, cursorLength: bridgeCursor.length,
        queryId: bridgeFirstPage.receipt.queryId, queryString: bridgeStart.QueryString, actions: bridgeActions,
        starts: bridgeCalls.filter(call => call.action === "StartQueryExecution").length, results: bridgeCalls.filter(call => call.action === "GetQueryResults").length,
        maxResults: bridgeResults.MaxResults, noToken: bridgeResults.NextToken === undefined, totalActions: bridgeFirstTotalActions }, trustedHttpBridge, dispatchedCaller, deadline: deadlineFacts,
      lateCredentialLease: leaseFacts,
      lateFetchBodyCancel: lateFetchFacts,
      quotaBytesAndPrincipal: quotaFacts,
      codecFinalAbort: { codecEntered, cancelled: true, reasonCaller: true, privateHidden: true, causeLeaked: false,
        stopsUnchanged: codecStopsUnchanged,
        actions: finalActions, starts: finalStarts.length, results: finalResults.length, queryIds: finalQueryIds,
        reuse: { exists: reuse.exists, canonicalKey: reuse.key.collection === "items" && reuse.key.id === "a" && reuse.key.path === "items/a",
          prototypeNull: Object.getPrototypeOf(reuse.data) === null, values: Object.values(reuse.data), amountType: typeof reuse.data.amount } } };
  } finally {
    try {
      client?.close();
    } finally {
      try {
        deadlineClient?.close();
      } finally {
        await server.close();
        assert.deepEqual(server.failures, []);
        const cleanup = server.snapshot();
        assert.equal(cleanup.liveConnections, 0);
        assert.equal(cleanup.activeHandlers, 0);
        assert.equal(JSON.stringify(source), sourceSnapshot);
        partial = { ...partial, cleanup };
      }
    }
  }
  return partial;
}
const signedSmoke = await runSignedSmoke();
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const coreValues = signedSmoke.coreValues, sameQueryPages = signedSmoke.sameQueryPages;
const trustedHttpBridge = signedSmoke.trustedHttpBridge, dispatchedCaller = signedSmoke.dispatchedCaller;
const deadline = signedSmoke.deadline, lease = signedSmoke.lateCredentialLease, lateFetch = signedSmoke.lateFetchBodyCancel;
const quota = signedSmoke.quotaBytesAndPrincipal, codec = signedSmoke.codecFinalAbort, cleanup = signedSmoke.cleanup;
const nativeColumns = signedSmoke.columns.length === 3 &&
  signedSmoke.columns[0]?.name === "id" && signedSmoke.columns[0]?.type === "varchar" &&
  signedSmoke.columns[1]?.name === "amount" && signedSmoke.columns[1]?.type === "decimal" &&
  signedSmoke.columns[1]?.precision === 38 && signedSmoke.columns[1]?.scale === 10 &&
  signedSmoke.columns[2]?.name === "note" && signedSmoke.columns[2]?.type === "varchar";
const summary = {
  publicCoreIdentity: {
    core: coreValues.key.core === true && coreValues.key.collection === "items" && coreValues.key.id === "a" && coreValues.key.path === "items/a",
    typedNativeValues: coreValues.positive.exists === true && coreValues.positive.prototypeNull === true &&
      same(coreValues.positive.keys, ["id", "amount", "note"]) && same(coreValues.positive.values, ["a", "9007199254740993.0001", null]) &&
      coreValues.positive.amountType === "string" && coreValues.emptyString === "" &&
      coreValues.duplicates.length === 2 && coreValues.duplicates.distinctSnapshots === true && coreValues.duplicates.distinctMaps === true &&
      same(coreValues.duplicates.keys, ["id", "amount", "note"]) && same(coreValues.duplicates.values, ["a", "9007199254740993.0001", null]) &&
      coreValues.missing.exists === false && coreValues.missing.hasData === false && coreValues.missing.path === "items/missing" &&
      coreValues.transaction.invoked === false && coreValues.transaction.unsupported === true &&
      coreValues.transaction.credentialsUnchanged === true && coreValues.transaction.callsUnchanged === true
  },
  signedOwnedHttpFixture: signedSmoke.actions.length === 70 &&
    signedSmoke.actions.every(action => ["GetWorkGroup", "StartQueryExecution", "GetQueryExecution", "GetQueryResults", "StopQueryExecution"].includes(action)) &&
    quota.wire.total === 29 && signedSmoke.actions.length + quota.wire.total === 99,
  sameQueryPages: {
    header: sameQueryPages.fetchedPages === 5 && sameQueryPages.rows.length === 3 &&
      same(sameQueryPages.rows, [["a", "9007199254740993.0001", null], ["a", "9007199254740993.0001", null], ["b", null, ""]]),
    empty: same(sameQueryPages.ordinals, [0, 0, 0, 1, 2]) && sameQueryPages.rows.length === 3 && sameQueryPages.fetchedPages === 5,
    duplicate: sameQueryPages.rows[0]?.[0] === "a" && sameQueryPages.rows[1]?.[0] === "a" && sameQueryPages.rows[2]?.[0] === "b",
    pendingFactoryRetry: sameQueryPages.startCount === 1 && sameQueryPages.fetchedPages === 5 &&
      same(sameQueryPages.tokens, [null, "p1", "p2", "p3", "p4"]) && sameQueryPages.states.every(state => state === "SUCCEEDED"),
    localAck: sameQueryPages.complete === true && sameQueryPages.hasMore === false &&
      sameQueryPages.nextCursor === null && sameQueryPages.receiptRows === 3
  },
  compilerMetadata: {
    exact: signedSmoke.receipt.queryId === "query-1" && signedSmoke.receipt.state === "SUCCEEDED" && signedSmoke.receipt.complete === true &&
      same(signedSmoke.rows, [["a", "9007199254740993.0001", ""]]) && nativeColumns &&
      sameQueryPages.queryId === "query-2" && sameQueryPages.startCount === 1 &&
      coreValues.segment.starts === 5 && coreValues.segment.results === 5 && coreValues.segment.queryIds.length === 5,
    native: nativeColumns && typeof signedSmoke.rows[0]?.[1] === "string",
    unsafeNumericStatistics: signedSmoke.receipt.dataScannedBytes === "9007199254740993"
  },
  codecFinalAbort: codec.codecEntered === 1 && codec.cancelled === true && codec.reasonCaller === true &&
    codec.privateHidden === true && codec.causeLeaked === false && codec.stopsUnchanged === true &&
    codec.starts === 2 && codec.results === 2 && codec.reuse.exists === true && codec.reuse.canonicalKey === true &&
    codec.reuse.prototypeNull === true && same(codec.reuse.values, ["a", "9007199254740993.0001", null]) &&
    codec.reuse.amountType === "string",
  trustedHttpBridge: {
    preAckResponseAbortRetry: trustedHttpBridge.constructionEntered === 1 && trustedHttpBridge.failedStatus === 408 &&
      trustedHttpBridge.error?.error === "cancelled" && trustedHttpBridge.error?.reason === "caller" &&
      trustedHttpBridge.privateHidden === true && trustedHttpBridge.failedAddedResults === 1 &&
      trustedHttpBridge.retry.status === 200 && trustedHttpBridge.retry.complete === true &&
      trustedHttpBridge.retryAddedResults === 0 && trustedHttpBridge.stale.status === 400 &&
      trustedHttpBridge.stale.error === "cursor"
  },
  dispatchedCallerDeadline: {
    caller: dispatchedCaller.cancelled === true && dispatchedCaller.reasonCaller === true && dispatchedCaller.prototypeExact === true &&
      dispatchedCaller.privateHidden === true && dispatchedCaller.causeLeaked === false && dispatchedCaller.delivered === false &&
      same(dispatchedCaller.actions, ["GetWorkGroup", "StartQueryExecution", "GetQueryExecution", "StopQueryExecution"]) &&
      dispatchedCaller.starts === 1 && dispatchedCaller.resultRequestsDuringCaller === 0 && dispatchedCaller.statusDisconnected === true,
    deadline: deadline.cancelled === true && deadline.reasonDeadline === true && deadline.prototypeExact === true &&
      deadline.privateHidden === true && deadline.causeLeaked === false && deadline.delivered === false && deadline.valueAbsent === true &&
      same(deadline.actions, ["GetWorkGroup", "StartQueryExecution", "GetQueryExecution", "StopQueryExecution"]) &&
      deadline.starts === 1 && deadline.resultRequestsDuringDeadline === 0 && deadline.statusDisconnected === true,
    capturedStop: dispatchedCaller.sameCapturedId === true && dispatchedCaller.stop.attempts === 1 && dispatchedCaller.stop.status === 200 &&
      dispatchedCaller.stop.bytes === 0 && dispatchedCaller.stop.finished === true && dispatchedCaller.stop.socketClosed === true &&
      dispatchedCaller.stop.originalSigV4 === true && deadline.sameCapturedId === true && deadline.stop.attempts === 1 &&
      deadline.stop.status === 200 && deadline.stop.bytes === 0 && deadline.stop.finished === true &&
      deadline.stop.socketClosed === true && deadline.stop.originalSigV4 === true && deadline.capturedQueryId !== dispatchedCaller.capturedQueryId,
    originalTypedErrors: dispatchedCaller.prototypeExact === true && deadline.prototypeExact === true &&
      dispatchedCaller.cancelled === true && deadline.cancelled === true && dispatchedCaller.causeLeaked === false &&
      deadline.causeLeaked === false && dispatchedCaller.credentialCallsUnchanged === true &&
      deadline.credentialCallsUnchanged === true && dispatchedCaller.reuseAdditional === 4 && deadline.reuseAdditional === 4
  },
  lateCredentialsBody: {
    credentialsCancelPhysicalLease: lease.cancelled === true && lease.reasonCaller === true && lease.prototypeExact === true &&
      lease.privateHidden === true && lease.causeLeaked === false && lease.delivered === false && lease.valueAbsent === true &&
      lease.provider.callsDuringCancellation === 1 && lease.provider.entered === true && lease.provider.settledWhilePending === false &&
      lease.provider.settledAfterRelease === true && lease.busyBeforeProviderSettlement.validRead === "busy" &&
      lease.busyBeforeProviderSettlement.emptyBatch === "busy" && lease.busyBeforeProviderSettlement.providerCalls === 1 &&
      lease.busyBeforeProviderSettlement.fetchCalls === 0 && lease.busyBeforeProviderSettlement.awsActions === 0 &&
      lease.capacity.admitted === true && lease.capacity.empty === true && same(lease.capacity.actual, []) &&
      lease.lateAttemptDispatchedRequests === 0 &&
      same(lease.actions, ["GetWorkGroup", "StartQueryExecution", "GetQueryExecution", "GetQueryResults"]) &&
      lease.recovery.fetchCalls === 4 && lease.recovery.providerCalls === 2 && lease.recovery.state === "SUCCEEDED" &&
      lease.recovery.complete === true && lease.sameClient === true,
    bodyCancelPhysicalLease: lateFetch.heldFetch.calls === 1 && lateFetch.heldFetch.withheld === true &&
      lateFetch.heldFetch.ignoredSignal === true && lateFetch.heldFetch.realResponse === true &&
      lateFetch.heldFetch.unlockedBody === true && lateFetch.heldFetch.cancelEntries === 1 &&
      lateFetch.heldFetch.readerAcquisitions === 0 && lateFetch.cancellation.cancelled === true &&
      lateFetch.cancellation.reasonCaller === true && lateFetch.cancellation.prototypeExact === true &&
      lateFetch.cancellation.privateHidden === true && lateFetch.cancellation.causeLeaked === false &&
      lateFetch.cancellation.delivered === false && lateFetch.cancellation.valueAbsent === true &&
      lateFetch.busyBeforeSettlement.validRead === "busy" && lateFetch.busyBeforeSettlement.emptyBatch === "busy" &&
      lateFetch.retainedCleanup.emptyBatchBusyWhileCancelPending === true && lateFetch.retainedCleanup.cancelEntries === 1 &&
      lateFetch.capacity.admitted === true && lateFetch.capacity.empty === true && same(lateFetch.capacity.actual, []) &&
      same(lateFetch.recovery.actions, ["GetWorkGroup", "StartQueryExecution", "GetQueryExecution", "GetQueryResults"]) &&
      lateFetch.recovery.starts === 1 && lateFetch.recovery.results === 1 && lateFetch.recovery.fetchCalls === 5 &&
      lateFetch.recovery.providerCalls === 2 && lateFetch.recovery.state === "SUCCEEDED" &&
      lateFetch.recovery.complete === true && lateFetch.sameClient === true,
    realQuotaRejection: quota.defaults.maxCursorBytes === 16_777_216 && quota.defaults.maxCursorNodes === 65_536 &&
      quota.defaults.maxConcurrent === 4 && quota.journeys.cursors === 6 && quota.journeys.queryIds.length === 6 &&
      new Set(quota.journeys.queryIds).size === 6 && same(quota.journeys.ordinals, [0, 0, 0, 0, 0, 0]) &&
      quota.journeys.emptyFirstRows === true && same(quota.journeys.sourceIds, ["owned"]) && quota.journeys.hasMore === true &&
      quota.nativeRow.idLength === 1_048_576 && quota.nativeRow.noteLength === 2_097_152 && quota.nativeRow.amountNull === true &&
      quota.nativeRow.withinResponseLimit === true && quota.nativeRow.responseLimit === 4_194_304 &&
      quota.principalGeneration.principalCode === "permission" &&
      quota.principalGeneration.generationCode === "permission" && quota.principalGeneration.httpDuring === 0 &&
      quota.principalGeneration.awsActionsDuring === 0 && quota.principalGeneration.handlesPreserved === true &&
      quota.principalGeneration.restored === true && quota.retainedFactory.count === 4 && quota.retainedFactory.factoryEntries === 4 &&
      quota.retainedFactory.verified === 4 && quota.retainedFactory.safeTransportErrors === 4 &&
      quota.retainedFactory.privateTextHidden === true && quota.retainedFactory.noSuccessorDelivered === true &&
      quota.retainedFactory.activeFactories === 0 && quota.capacity.admitted === true && quota.capacity.empty === 0 &&
      quota.capacity.providerCalls === 0 && quota.capacity.fetchCalls === 0 && quota.capacity.awsActions === 0 &&
      quota.refusedFifth.code === "bounds" && quota.refusedFifth.providerCalls === 1 && quota.refusedFifth.fetchCalls === 0 &&
      quota.refusedFifth.starts === 0 && quota.refusedFifth.results === 0 && quota.refusedFifth.factoryEntries === 0 &&
      quota.refusedFifth.handlePreserved === true && quota.refusedFresh.code === "bounds" && quota.refusedFresh.providerCalls === 0 &&
      quota.refusedFresh.fetchCalls === 0 && quota.refusedFresh.awsActions === 0 && quota.refusedFresh.factoryEntries === 0 &&
      quota.retryFirst.queryId === quota.journeys.queryIds[0] && quota.retryFirst.resultRequests === 0 &&
      quota.retryFirst.starts === 0 && quota.retryFirst.complete === true && quota.retryFirst.nextCursor === null &&
      quota.retryFifth.queryId === quota.journeys.queryIds[4] && quota.retryFifth.resultRequests === 1 &&
      quota.retryFifth.starts === 0 && quota.retryFifth.nextCursor === null &&
      quota.drained.count === 3 && quota.drained.resultRequests === 0 &&
      quota.drained.starts === 0 && quota.wire.total === 29 && quota.oldOutputUnchanged === true && quota.sourceUnchanged === true
  },
  cleanup: {
    socket: cleanup.liveConnections === 0,
    handler: cleanup.activeHandlers === 0,
    process: cleanup.liveConnections === 0 && cleanup.activeHandlers === 0 && cleanup.acceptedConnections >= 99,
    data: quota.sourceUnchanged === true && quota.oldOutputUnchanged === true
  }
};
process.stdout.write(JSON.stringify(summary) + "\n");
