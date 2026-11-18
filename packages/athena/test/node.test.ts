import { createHash, createHmac } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { createAthenaNodeClient } from "../src/node.js";
import type { AthenaAction } from "../src/types.js";
import { deferred, Fixture, query, result, source } from "./fixture.js";
const accessKeyId = "SYNTHETICREADER123", secretAccessKey = "synthetic-not-an-AWS-secret-value", sessionToken = "synthetic-session";
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sign(key: string | Uint8Array, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }
function verify(headers: IncomingHttpHeaders, body: string): void {
  const auth = headers.authorization; expect(typeof auth).toBe("string"); if (typeof auth !== "string") throw new Error("missing synthetic signature");
  const fields = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/u.exec(auth);
  if (fields === null) throw new Error("invalid synthetic signature");
  expect(fields[1]).toBe(accessKeyId); const scope = fields[2]; if (scope === undefined) throw new Error("scope");
  const parts = scope.split("/"); expect(parts.slice(1)).toEqual(["us-east-1", "athena", "aws4_request"]);
  const names = fields[3]?.split(";"); if (names === undefined) throw new Error("signed headers");
  const canonical = names.map(name => { const value = headers[name]; if (typeof value !== "string") throw new Error("signed field"); return name + ":" + value.trim().replace(/\s+/gu, " ") + "\n"; }).join("");
  const date = headers["x-amz-date"]; if (typeof date !== "string") throw new Error("date");
  const request = "POST\n/\n\n" + canonical + "\n" + names.join(";") + "\n" + hash(body);
  const stringToSign = "AWS4-HMAC-SHA256\n" + date + "\n" + scope + "\n" + hash(request);
  const dateKey = sign("AWS4" + secretAccessKey, parts[0] ?? ""), region = sign(dateKey, "us-east-1"), service = sign(region, "athena"), signing = sign(service, "aws4_request");
  expect(fields[4]).toBe(createHmac("sha256", signing).update(stringToSign).digest("hex")); expect(headers["x-amz-security-token"]).toBe(sessionToken);
}
function responseBody(incoming: import("node:http").IncomingMessage, signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  let settled = false, controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cleanup = () => { incoming.off("data", onData); incoming.off("end", onEnd); incoming.off("error", onError); incoming.off("close", onClose); signal?.removeEventListener("abort", onAbort); };
  const finish = (error?: unknown) => { if (settled) return; settled = true; cleanup(); if (error === undefined) controller?.close(); else controller?.error(error); };
  const onData = (chunk: Buffer) => { if (settled) return; incoming.pause(); try { controller?.enqueue(new Uint8Array(chunk)); } catch (error) { finish(error); } };
  const onEnd = () => { finish(); };
  const onError = (error: Error) => { finish(error); };
  const onClose = () => { if (!incoming.complete) finish(new Error("owned fixture response closed before completion")); };
  const onAbort = () => { incoming.destroy(); finish(signal?.reason ?? new Error("owned fixture request aborted")); };
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value; incoming.on("data", onData); incoming.once("end", onEnd); incoming.once("error", onError); incoming.once("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true }); if (signal?.aborted) onAbort();
    },
    pull() { if (!settled) incoming.resume(); },
    cancel() { if (settled) return; settled = true; cleanup(); incoming.destroy(); }
  });
}
it("uses official signing, fixed HTTPS authority and one-attempt raw bodies over a trusted owned HTTP seam", async () => {
  const fixture = new Fixture(); let mode: "caller" | "deadline" | undefined;
  let entered = deferred<void>(), disconnected = deferred<void>(); let signed = 0; let failures: unknown;
  const sockets = new Set<import("node:net").Socket>(); const socketAcks: Promise<void>[] = [];
  let closing = false;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { if (!(chunk instanceof Buffer) || (size += chunk.byteLength) > 65_536) throw new Error("fixture request bound"); chunks.push(chunk); }
      const body = Buffer.concat(chunks).toString("utf8"); verify(request.headers, body); signed++;
      expect(request.method).toBe("POST"); expect(request.url).toBe("/"); expect(request.headers.host).toBe("athena.us-east-1.amazonaws.com");
      const target = request.headers["x-amz-target"]; if (typeof target !== "string" || !target.startsWith("AmazonAthena.")) throw new Error("target");
      const action = target.slice("AmazonAthena.".length) as AthenaAction;
      if (action === "GetQueryResults" && mode !== undefined) {
        const closed = deferred<void>(); const timer = setTimeout(() => { closed.resolve(undefined); }, 3000);
        response.once("close", () => { if (!response.writableEnded) disconnected.resolve(undefined); clearTimeout(timer); closed.resolve(undefined); });
        entered.resolve(undefined); await closed.promise; return;
      }
      const result = await fixture.request(action, body, { principal: "owned-reader", generation: "one" }, new AbortController().signal);
      response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(new Uint8Array(await result.arrayBuffer()));
    } catch (error) { failures = error; response.destroy(); }
  });
  server.on("connection", socket => {
    sockets.add(socket); socketAcks.push(new Promise<void>(resolve => socket.once("close", () => { sockets.delete(socket); resolve(); }))); if (closing) socket.destroy();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("address");
  const trustedFetch: typeof fetch = (input, init) => {
    if (typeof input !== "string" || input !== "https://athena.us-east-1.amazonaws.com/" || typeof init?.body !== "string") throw new Error("unexpected authority/body");
    expect(init.redirect).toBe("error"); expect(init.method).toBe("POST");
    const headers = new Headers(init.headers); expect(headers.get("host")).toBe("athena.us-east-1.amazonaws.com");
    // Node24 fetch deliberately deletes Host before deriving it from a
    // remapped URL. The owned test seam dials loopback with node:http and
    // forwards the exact signed Host instead; production still uses AWS HTTPS.
    const wire = init.body;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest({ hostname: "127.0.0.1", port: address.port, path: "/", method: "POST", headers: Object.fromEntries(headers),
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
  const ack = async (promise: Promise<void>): Promise<void> => { let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error("expected positive server disconnect ACK")); }, 2000); })]); } finally { if (timer !== undefined) clearTimeout(timer); } };
  const credentials = () => ({ principal: "owned-reader", generation: "one", accessKeyId, secretAccessKey, sessionToken });
  const client = createAthenaNodeClient({ source, credentials, fetch: trustedFetch, pollIntervalMs: 0, timeoutMs: 5000 });
  let deadlineClient: ReturnType<typeof createAthenaNodeClient> | undefined;
  try {
    expect(fixture.calls).toHaveLength(0); expect((await client.queryPage(query())).rows[0]?.[1]).toBe("9007199254740993.0001");
    mode = "caller"; entered = deferred<void>(); disconnected = deferred<void>(); const caller = new AbortController(); const pending = client.queryPage(query(), { signal: caller.signal });
    const callerOutcome = pending.catch(error => error as unknown);
    await Promise.race([entered.promise, callerOutcome.then(() => { throw new Error("caller operation ended before dispatch"); })]); caller.abort(new Error("PRIVATE")); expect(await callerOutcome).toBeInstanceOf(QueryCancelledError); await ack(disconnected.promise);
    mode = undefined; expect((await client.queryPage(query())).rows).toHaveLength(1);
    mode = "deadline"; entered = deferred<void>(); disconnected = deferred<void>(); deadlineClient = createAthenaNodeClient({ source, credentials, fetch: trustedFetch, pollIntervalMs: 0, timeoutMs: 1000 });
    const expired = deadlineClient.queryPage(query()); const outcome = expired.catch(error => error as unknown); await Promise.race([entered.promise, outcome.then(() => { throw new Error("deadline ended before dispatch"); })]); expect(await outcome).toBeInstanceOf(QueryCancelledError); await ack(disconnected.promise);
    mode = undefined; expect((await client.queryPage(query())).rows).toHaveLength(1); expect(failures).toBeUndefined(); expect(signed).toBeGreaterThanOrEqual(20);
  } finally {
    client.close(); deadlineClient?.close(); closing = true;
    const closed = new Promise<void>((resolve, reject) => server.close(error => { if (error) reject(error); else resolve(); }));
    server.closeAllConnections(); for (const socket of sockets) socket.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed.then(async () => { await Promise.all(socketAcks); }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error("owned fixture cleanup timeout")); }, 2500); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    expect(sockets.size).toBe(0); expect(failures).toBeUndefined();
  }
}, 15000);

it("charges maximum Node session credentials before submit and retains resumed authority until physical settlement", async () => {
  const clock = { value: 0 }, clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock.value);
  const fixture = new Fixture(); fixture.pages = [result([], "p1", true), result([["a", "1", null]])];
  const token = "s".repeat(32768); let acquisitions = 0, signed = 0, blocked = false;
  const entered = deferred<void>(), settle = deferred<void>();
  const supplied = { principal: "owned-reader", generation: "one", accessKeyId, secretAccessKey, sessionToken: token };
  const trustedFetch: typeof fetch = (input, init) => {
    expect(input).toBe("https://athena.us-east-1.amazonaws.com/");
    const headers = new Headers(init?.headers); expect(headers.get("x-amz-security-token")).toBe(token);
    expect(headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /u); signed++;
    const target = headers.get("x-amz-target"); if (target === null || !target.startsWith("AmazonAthena.") || typeof init?.body !== "string") throw new Error("signed fixture request");
    return Promise.resolve(fixture.request(target.slice("AmazonAthena.".length) as AthenaAction, init.body, fixture.identity, init.signal ?? new AbortController().signal));
  };
  const client = createAthenaNodeClient({ source, fetch: trustedFetch, credentials: async () => {
    acquisitions++; if (blocked) { entered.resolve(undefined); await settle.promise; } return supplied;
  }, timeoutMs: 5000, cursorTtlMs: 1000, maxColumns: 3, maxPageNodes: 128, maxCursorNodes: 4096, maxPageBytes: 2048, maxCursorBytes: 225000 });
  try {
    const first = await client.queryPage(query()), second = await client.queryPage(query());
    const a = first.nextCursor, b = second.nextCursor; if (a === undefined || b === undefined) throw new Error("cursor");
    const before = acquisitions; await expect(client.queryPage(query())).rejects.toMatchObject({ code: "bounds" }); expect(acquisitions).toBe(before);
    blocked = true; const caller = new AbortController(), pending = client.nextPage(a, caller.signal);
    await entered.promise; caller.abort(); await expect(pending).rejects.toBeInstanceOf(QueryCancelledError);
    await expect(client.nextPage(a)).rejects.toMatchObject({ code: "busy" });
    const retained = acquisitions; await expect(client.queryPage(query())).rejects.toMatchObject({ code: "bounds" }); expect(acquisitions).toBe(retained);
    blocked = false; settle.resolve(undefined); await new Promise(resolve => setImmediate(resolve));
    expect((await client.nextPage(a)).rows[0]?.[0]).toBe("a");
    expect((await client.queryPage(query())).hasMore).toBe(true);
    const full = acquisitions; await expect(client.queryPage(query())).rejects.toMatchObject({ code: "bounds" }); expect(acquisitions).toBe(full);
    clock.value = 1000; expect((await client.queryPage(query())).hasMore).toBe(true);
    expect(signed).toBe(17); expect(fixture.calls.filter(event => event.action === "StartQueryExecution")).toHaveLength(4);
  } finally { settle.resolve(undefined); client.close(); clockSpy.mockRestore(); }
});
