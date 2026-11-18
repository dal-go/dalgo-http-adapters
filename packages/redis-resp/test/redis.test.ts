import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { RedisHttpExecutor, RedisReadError, validateRedisRead } from "../src/index.js";
import { RedisNodeExecutor, createRedisHttpHandler } from "../src/node.js";
import { parseRedisReply } from "../src/resp.js";
import { isRedisValue, resolveRedisLimits, type RedisValue } from "../src/contracts.js";

describe("read-command admission", () => {
  it("copies inputs and admits only bounded read operations", () => {
    const command = ["get", "application:key"];
    expect(validateRedisRead(command)).toEqual(["GET", "application:key"]);
    expect(command[0]).toBe("get");
    expect(validateRedisRead(["SCAN", "0", "MATCH", "application:*"])).toEqual(["SCAN", "0", "MATCH", "application:*", "COUNT", "100"]);
    for (const name of ["SET", "KEYS", "EVAL", "EVAL_RO", "MONITOR", "AUTH", "SELECT", "HGETALL", "SMEMBERS", "LRANGE", "XREAD"]) {
      expect(() => validateRedisRead([name, "k"])).toThrow(RedisReadError);
    }
    expect(() => validateRedisRead(["GET", "a", "b"])).toThrow(RedisReadError);
    expect(() => validateRedisRead(["SCAN", "0", "COUNT", "1001"])).toThrow(RedisReadError);
    expect(() => validateRedisRead(["SCAN", "0", "COUNT", "2", "COUNT", "2"])).toThrow(RedisReadError);
    expect(() => validateRedisRead(["SCAN", "0", "MATCH"])).toThrow(RedisReadError);
    expect(() => validateRedisRead(["SCAN", "18446744073709551616"])).toThrow(RedisReadError);
    expect(validateRedisRead(["SCAN", "18446744073709551615"])).toEqual(["SCAN", "18446744073709551615", "COUNT", "100"]);
    expect(() => validateRedisRead(["MGET", "a", "b"], resolveRedisLimits({ maxArguments: 1 }))).toThrow(RedisReadError);
    expect(() => validateRedisRead(["GET", "☃☃"], resolveRedisLimits({ maxCommandBytes: 8 }))).toThrow(RedisReadError);
    const sparse = ["GET", "k"];
    Reflect.deleteProperty(sparse, "1");
    expect(() => validateRedisRead(sparse)).toThrow(RedisReadError);
  });
});

describe("bounded RESP2 decoder", () => {
  it("does not round signed64 integers or reinterpret arbitrary bytes as UTF8", () => {
    expect(parseRedisReply(Buffer.from(":9223372036854775807\r\n"), 100)?.value).toEqual({ kind: "integer", value: "9223372036854775807" });
    expect(parseRedisReply(Buffer.from(":+0012\r\n"), 100)?.value).toEqual({ kind: "integer", value: "12" });
    expect(parseRedisReply(Buffer.from([36, 51, 13, 10, 0, 255, 128, 13, 10]), 100)?.value).toEqual({ kind: "bytes", base64: "AP+A" });
    expect(parseRedisReply(Buffer.from("*-1\r\n"), 100)?.value).toBeNull();
    expect(parseRedisReply(Buffer.from("*2\r\n$-1\r\n:1\r\n"), 100)?.value).toEqual({ kind: "array", values: [null, { kind: "integer", value: "1" }] });
  });

  it("handles every fragmentation boundary and rejects malformed/oversized headers early", () => {
    const bytes = Buffer.from("*2\r\n$2\r\n42\r\n$4\r\nname\r\n");
    for (let end = 0; end < bytes.length; end++) expect(parseRedisReply(bytes.subarray(0, end), 100)).toBeUndefined();
    expect(parseRedisReply(bytes, 100)?.offset).toBe(bytes.length);
    for (const raw of ["$999999999\r\n", "*999999999\r\n", ":9223372036854775808\r\n", "$-2\r\n", "$1\r\nx!!", "%0\r\n"]) {
      expect(() => parseRedisReply(Buffer.from(raw), 100)).toThrow(RedisReadError);
    }
    expect(() => parseRedisReply(Buffer.from("-WRONGTYPE secret-server-info\r\n"), 100)).toThrow("Redis read failed (denied)");
    expect(isRedisValue({ kind: "integer", value: "9223372036854775808" })).toBe(false);
    expect(isRedisValue({ kind: "bytes", base64: "eA==", secret: "unexpected" })).toBe(false);
  });
});

async function withRedisServer(run: (options: { port: number; commands: string[][]; sockets: Set<Socket> }) => Promise<void>, reply: (command: string[], socket: Socket) => void): Promise<void> {
  const commands: string[][] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); });
    socket.on("error", () => undefined);
    let input: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      for (;;) {
        const parsed = parseRedisReply(input, 65_536);
        if (parsed === undefined) break;
        if (parsed.value === null || typeof parsed.value === "string" || parsed.value.kind !== "array") throw new Error("invalid test request");
        const args = parsed.value.values.map(value => {
          if (value === null || typeof value === "string" || value.kind !== "bytes") throw new Error("invalid test argument");
          return Buffer.from(value.base64, "base64").toString("utf8");
        });
        commands.push(args);
        input = input.subarray(parsed.offset);
        reply(args, socket);
      }
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test address");
  try { await run({ port: address.port, commands, sockets }); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
  }
}

describe("independent Node RESP executor", () => {
  it("authenticates and selects server-owned database, preserves raw bytes and reconnects per operation", async () => {
    await withRedisServer(async ({ port, commands }) => {
      const executor = new RedisNodeExecutor({ host: "127.0.0.1", port, username: "reader", password: "secret", database: 2 });
      expect(await executor.execute(["GET", "k"])).toEqual({ kind: "bytes", base64: "AP+A" });
      expect(await executor.execute(["TTL", "k"])).toEqual({ kind: "integer", value: "9223372036854775807" });
      expect(commands).toEqual([["AUTH", "reader", "secret"], ["SELECT", "2"], ["GET", "k"], ["AUTH", "reader", "secret"], ["SELECT", "2"], ["TTL", "k"]]);
    }, (command, socket) => {
      if (command[0] === "AUTH" || command[0] === "SELECT") socket.write("+OK\r\n");
      else if (command[0] === "GET") socket.write(Buffer.from([36, 51, 13, 10, 0, 255, 128, 13, 10]));
      else socket.write(":9223372036854775807\r\n");
    });
  });

  it("rejects prohibited operations before connecting", async () => {
    await withRedisServer(async ({ port, commands }) => {
      const executor = new RedisNodeExecutor({ host: "127.0.0.1", port });
      await expect(executor.execute(["SET", "k", "v"])).rejects.toMatchObject({ code: "policy" });
      await expect(executor.execute(["SCAN", "0"])).rejects.toMatchObject({ code: "policy" });
      const scoped = new RedisNodeExecutor({ host: "127.0.0.1", port, scanPrefix: "app:*" });
      await expect(scoped.execute(["SCAN", "0", "MATCH", "*"])).rejects.toMatchObject({ code: "policy" });
      await expect(scoped.execute(["SCAN", "0", "MATCH", "app:**"])).rejects.toMatchObject({ code: "policy" });
      expect(commands).toEqual([]);
    }, () => { throw new Error("prohibited command reached server"); });
  });

  it("forces a server-owned literal SCAN prefix, escaping Redis glob metacharacters", async () => {
    await withRedisServer(async ({ port, commands }) => {
      const executor = new RedisNodeExecutor({ host: "127.0.0.1", port, scanPrefix: "app:*?[x]\\" });
      expect(await executor.execute(["SCAN", "0", "COUNT", "5"])).toEqual({ kind: "array", values: [{ kind: "bytes", base64: "MA==" }, { kind: "array", values: [] }] });
      expect(commands).toEqual([["SCAN", "0", "COUNT", "5", "MATCH", "app:\\*\\?\\[x\\]\\\\*"]]);
    }, (_command, socket) => { socket.write("*2\r\n$1\r\n0\r\n*0\r\n"); });
  });

  it("rejects malformed and out-of-scope SCAN replies from the service without leaking a partial page", async () => {
    const bulk = (bytes: Uint8Array): Buffer => Buffer.concat([Buffer.from(`$${String(bytes.length)}\r\n`), bytes, Buffer.from("\r\n")]);
    const cursor = (value: string): Buffer => bulk(Buffer.from(value));
    const emptyKeys = Buffer.from("*0\r\n");
    const page = (cursor: Buffer, keys: Buffer): Buffer => Buffer.concat([Buffer.from("*2\r\n"), cursor, keys]);
    const foreign = Buffer.from("foreign:private-service-detail");
    const outsideKeys = Buffer.concat([Buffer.from("*2\r\n"), bulk(Buffer.from("tenant:allowed")), bulk(foreign)]);
    const maskedPrefix = Buffer.from([...Buffer.from("tenant:")].map(byte => byte | 128));
    const invalidPrefix = Buffer.concat([Buffer.from("*1\r\n"), bulk(maskedPrefix)]);
    const replies = [
      Buffer.from("+OK\r\n"), Buffer.from("*-1\r\n"), Buffer.from(":0\r\n"),
      Buffer.from("*1\r\n$1\r\n0\r\n"),
      page(Buffer.from(":0\r\n"), emptyKeys),
      page(cursor(""), emptyKeys), page(cursor("-1"), emptyKeys), page(cursor("+1"), emptyKeys),
      page(cursor("18446744073709551616"), emptyKeys),
      page(bulk(Buffer.from([176])), emptyKeys),
      page(cursor("0"), Buffer.from("$-1\r\n")),
      page(cursor("0"), Buffer.from("*1\r\n:1\r\n")),
      page(cursor("0"), outsideKeys), page(cursor("0"), invalidPrefix),
    ];
    for (const reply of replies) {
      await withRedisServer(async ({ port }) => {
        const executor = new RedisNodeExecutor({ host: "127.0.0.1", port, scanPrefix: "tenant:" });
        await expect(executor.execute(["SCAN", "0"])).rejects.toThrow("Redis read failed (protocol)");
        expect(await executor.execute(["GET", "tenant:allowed"])).toEqual({ kind: "bytes", base64: "b2s=" });
      }, (command, socket) => { socket.write(command[0] === "SCAN" ? reply : Buffer.from("$2\r\nok\r\n")); });
    }
  });

  it("preserves uint64 cursors, empty nonterminal pages, duplicate keys and binary bytes after the literal prefix", async () => {
    const prefix = "tenant:☃:";
    const key = Buffer.concat([Buffer.from(prefix), Buffer.from([0, 255, 128])]);
    const maxCursor = "18446744073709551615";
    let page = 0;
    await withRedisServer(async ({ port, commands }) => {
      const executor = new RedisNodeExecutor({ host: "127.0.0.1", port, scanPrefix: prefix });
      expect(await executor.execute(["SCAN", "0"])).toEqual({
        kind: "array", values: [{ kind: "bytes", base64: Buffer.from(maxCursor).toString("base64") }, { kind: "array", values: [] }],
      });
      const bytes = { kind: "bytes", base64: key.toString("base64") };
      expect(await executor.execute(["SCAN", maxCursor])).toEqual({
        kind: "array", values: [{ kind: "bytes", base64: "MA==" }, { kind: "array", values: [bytes, bytes] }],
      });
      expect(commands).toEqual([
        ["SCAN", "0", "COUNT", "100", "MATCH", prefix + "*"],
        ["SCAN", maxCursor, "COUNT", "100", "MATCH", prefix + "*"],
      ]);
    }, (_command, socket) => {
      if (page++ === 0) socket.write(`*2\r\n$20\r\n${maxCursor}\r\n*0\r\n`);
      else {
        const bulk = Buffer.concat([Buffer.from(`$${String(key.length)}\r\n`), key, Buffer.from("\r\n")]);
        socket.write(Buffer.concat([Buffer.from("*2\r\n$1\r\n0\r\n*2\r\n"), bulk, bulk]));
      }
    });
  });

  it("keeps foreign SCAN keys out of the authorized HTTP response", async () => {
    await withRedisServer(async ({ port }) => {
      const executor = new RedisNodeExecutor({ host: "127.0.0.1", port, scanPrefix: "tenant:" });
      const handler = createRedisHttpHandler({ authorize: () => Promise.resolve(executor) });
      const response = await handler(new Request("https://app.example.test/redis", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: ["SCAN", "0"] }),
      }));
      expect(response.status).toBe(502);
      expect(await response.text()).toBe(JSON.stringify({ error: "protocol" }));
    }, (_command, socket) => {
      socket.write("*2\r\n$1\r\n0\r\n*1\r\n$22\r\nforeign:private-secret\r\n");
    });
  });

  it("enforces received-byte limits and redacts credentials and server errors", async () => {
    await withRedisServer(async ({ port }) => {
      await expect(new RedisNodeExecutor({ host: "127.0.0.1", port, maxReplyBytes: 20 }).execute(["GET", "k"])).rejects.toMatchObject({ code: "limit" });
    }, (_command, socket) => { socket.write("$1000000\r\n"); });
    await withRedisServer(async ({ port }) => {
      const executor = new RedisNodeExecutor({ host: "127.0.0.1", port, password: "must-not-leak" });
      await expect(executor.execute(["GET", "k"])).rejects.toThrow("Redis read failed (denied)");
    }, (_command, socket) => { socket.write("-ERR must-not-leak internal-host\r\n"); });
  });

  it("cancels an in-flight read and distinguishes its deadline", async () => {
    await withRedisServer(async ({ port }) => {
      const controller = new AbortController();
      const pending = new RedisNodeExecutor({ host: "127.0.0.1", port, timeoutMs: 1_000 }).execute(["GET", "k"], controller.signal);
      controller.abort("credential-must-not-leak");
      await expect(pending).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
      await expect(new RedisNodeExecutor({ host: "127.0.0.1", port, timeoutMs: 20 }).execute(["GET", "k"])).rejects.toMatchObject({ name: "QueryCancelledError", reason: "deadline" });
    }, () => undefined);
  });
});

describe("trusted HTTP browser path", () => {
  it("executes through an explicitly authorized route without accepting caller connection details", async () => {
    const calls: string[][] = [];
    const result: RedisValue = { kind: "array", values: [{ kind: "bytes", base64: "NDI=" }, null] };
    const handler = createRedisHttpHandler({ authorize: (request) => Promise.resolve(request.headers.get("authorization") === "Bearer synthetic" ? {
      execute: (command: readonly string[]) => { calls.push([...command]); return Promise.resolve(result); },
    } : undefined) });
    const client = new RedisHttpExecutor({ endpoint: "https://app.example.test/redis/resource", headers: () => Promise.resolve({ authorization: "Bearer synthetic" }), fetch: (input, init) => handler(new Request(input, init)) });
    expect(await client.execute(["MGET", "a", "b"])).toEqual(result);
    expect(calls).toEqual([["MGET", "a", "b"]]);
    const injected = await handler(new Request("https://app.example.test/redis/resource", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic" }, body: JSON.stringify({ command: ["GET", "k"], url: "redis://elsewhere" }) }));
    expect(injected.status).toBe(400);
    const denied = await handler(new Request("https://app.example.test/redis/resource", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: ["GET", "k"] }) }));
    expect(denied.status).toBe(403);
  });

  it("bounds hostile responses and propagates cancellation through header acquisition", async () => {
    const client = new RedisHttpExecutor({ endpoint: "https://app.example.test/redis", maxReplyBytes: 20, fetch: () => Promise.resolve(new Response(JSON.stringify({ result: "x".repeat(100) }))) });
    await expect(client.execute(["GET", "k"])).rejects.toMatchObject({ code: "limit" });
    const controller = new AbortController();
    let fetched = false;
    const waiting = new RedisHttpExecutor({ endpoint: "https://app.example.test/redis", headers: () => new Promise(() => undefined), fetch: () => { fetched = true; return Promise.reject(new Error("must not fetch")); } });
    const pending = waiting.execute(["GET", "k"], controller.signal);
    controller.abort("secret");
    await expect(pending).rejects.toBeInstanceOf(QueryCancelledError);
    expect(fetched).toBe(false);
  });

  it("does not return a late HTTP success when caller abort races executor completion", async () => {
    const controller = new AbortController();
    const handler = createRedisHttpHandler({ authorize: () => Promise.resolve({ execute: () => {
      const pending = Promise.resolve(null);
      // The race's fulfillment callback cleans up before this abort microtask;
      // the handler continuation must independently check the now-aborted scope.
      void pending.then(() => { queueMicrotask(() => { controller.abort("redacted"); }); });
      return pending;
    } }) });
    const response = await handler(new Request("https://app.example.test/redis", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: ["GET", "k"] }), signal: controller.signal,
    }));
    expect(response.status).toBe(499);
  });
});
