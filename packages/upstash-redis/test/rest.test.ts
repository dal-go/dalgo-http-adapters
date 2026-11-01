import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { UpstashRedisExecutor, RedisReadError, type UpstashRedisOptions } from "../src/index.js";

const endpoint = "https://fixture.upstash.io";
const secret = "synthetic-private-token";
const encoder = new TextEncoder();
const options = (extra: Partial<UpstashRedisOptions> = {}): UpstashRedisOptions => ({ endpoint, token: secret, ...extra });
function reply(value: string | Uint8Array, init: ResponseInit = {}): Response {
  const bytes = typeof value === "string" ? encoder.encode(value) : Uint8Array.from(value);
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  return new Response(bytes, { ...init, headers });
}
function bulk(value: string): string { return `$${String(encoder.encode(value).byteLength)}\r\n${value}\r\n`; }
function scan(cursor: string, keys: readonly string[]): string { return `*2\r\n${bulk(cursor)}*${String(keys.length)}\r\n${keys.map(bulk).join("")}`; }
function commandBody(body: RequestInit["body"]): unknown {
  if (typeof body !== "string") throw new Error("fixture POST body must be a JSON string");
  const parsed: unknown = JSON.parse(body);
  return parsed;
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("official REST command and native values", () => {
  it("is lazy and sends a JSON command array with header-only bearer and RESP2 selection", async () => {
    const token = vi.fn(() => secret);
    const transport = vi.fn<typeof fetch>(() => Promise.resolve(reply("$3\r\nbar\r\n")));
    const db = new UpstashRedisExecutor(options({ token, fetch: transport }));
    expect(token).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
    const input = ["get", "native/key with spaces"];
    expect(await db.execute(input)).toEqual({ kind: "bytes", base64: "YmFy" });
    expect(input[0]).toBe("get");
    const call = transport.mock.calls[0];
    expect(call?.[0]).toBe(endpoint + "/");
    expect(call?.[1]).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", body: '["GET","native/key with spaces"]' });
    expect(call?.[1]?.headers).toEqual({ authorization: `Bearer ${secret}`, "content-type": "application/json", accept: "application/octet-stream", "Upstash-Response-Format": "resp2" });
    expect(token).toHaveBeenCalledTimes(1);
  });

  it("preserves arbitrary bytes, nulls, arrays, native statuses and signed64 boundaries", async () => {
    const bodies = [new Uint8Array([36, 51, 13, 10, 0, 255, 128, 13, 10]), encoder.encode(":9223372036854775807\r\n"), encoder.encode(":-9223372036854775808\r\n"), encoder.encode("*2\r\n$-1\r\n$1\r\nx\r\n"), encoder.encode("+string\r\n")];
    const db = new UpstashRedisExecutor(options({ fetch: () => {
      const value = bodies.shift(); if (value === undefined) throw new Error("fixture exhausted");
      return Promise.resolve(reply(value));
    } }));
    expect(await db.execute(["GET", "k"])).toEqual({ kind: "bytes", base64: "AP+A" });
    expect(await db.execute(["HLEN", "k"])).toEqual({ kind: "integer", value: "9223372036854775807" });
    expect(await db.execute(["TTL", "k"])).toEqual({ kind: "integer", value: "-9223372036854775808" });
    expect(await db.execute(["MGET", "a", "b"])).toEqual({ kind: "array", values: [null, { kind: "bytes", base64: "eA==" }] });
    expect(await db.execute(["TYPE", "k"])).toBe("string");
  });

  it("refuses unsafe endpoints, commands and JSON escape expansion before acquiring credentials", async () => {
    for (const value of ["http://fixture.upstash.io", "https://u:secret@fixture.upstash.io", "https://fixture.upstash.io/path", "https://fixture.upstash.io/?_token=secret", "https://fixture.upstash.io/#secret", "bad-secret-url"]) {
      expect(() => new UpstashRedisExecutor(options({ endpoint: value }))).toThrow(RedisReadError);
    }
    expect(() => new UpstashRedisExecutor(options({ endpoint: "http://127.0.0.1:17017" }))).toThrow(RedisReadError);
    expect(() => new UpstashRedisExecutor(options({ endpoint: "http://127.0.0.1:17017", allowInsecureLoopbackHttp: true }))).not.toThrow();
    const token = vi.fn(() => secret); const transport = vi.fn<typeof fetch>();
    const db = new UpstashRedisExecutor(options({ token, fetch: transport }));
    for (const command of [["SET", "k", "v"], ["KEYS", "*"], ["EVAL", "x"], ["AUTH", "x"], ["MULTI"], ["SCAN", "0"]]) {
      await expect(db.execute(command)).rejects.toMatchObject({ code: "policy" });
    }
    const escaped = new UpstashRedisExecutor(options({ token, fetch: transport, maxCommandBytes: 20 }));
    await expect(escaped.execute(["GET", "\0\0\0\0"])).rejects.toMatchObject({ code: "limit" });
    expect(token).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });

  it("rejects lone UTF16 surrogates without changing valid astral keys or prefixes", async () => {
    const token = vi.fn(() => secret);
    const transport = vi.fn<typeof fetch>(() => Promise.resolve(reply(bulk("ok"))));
    const db = new UpstashRedisExecutor(options({ token, fetch: transport }));
    for (const malformed of ["\ud800", "\udc00", "key\ud800x", "key\udc00"]) {
      await expect(db.execute(["GET", malformed])).rejects.toMatchObject({ code: "policy" });
      await expect(db.execute(["HGET", "key", malformed])).rejects.toMatchObject({ code: "policy" });
      expect(() => new UpstashRedisExecutor(options({ scanPrefix: malformed, token, fetch: transport }))).toThrow(RedisReadError);
    }
    expect(token).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
    const key = "tenant:\u{1f680}key";
    expect(await db.execute(["GET", key])).toEqual({ kind: "bytes", base64: "b2s=" });
    expect(commandBody(transport.mock.calls[0]?.[1]?.body)).toEqual(["GET", key]);
    const scanTransport = vi.fn<typeof fetch>(() => Promise.resolve(reply(scan("0", [key]))));
    const scoped = new UpstashRedisExecutor(options({ scanPrefix: "tenant:\u{1f680}", fetch: scanTransport }));
    expect(await scoped.execute(["SCAN", "0"])).toMatchObject({ kind: "array" });
    expect(commandBody(scanTransport.mock.calls[0]?.[1]?.body)).toEqual(["SCAN", "0", "COUNT", "100", "MATCH", "tenant:\u{1f680}*"]);
  });

  it("rejects wrong command-specific reply types and partial multi-get arrays as a whole", async () => {
    for (const command of [["MGET", "a", "b"], ["HMGET", "hash", "a", "b"]]) {
      for (const value of ["*1\r\n$-1\r\n", "*3\r\n$-1\r\n$-1\r\n$-1\r\n", "*2\r\n:1\r\n$-1\r\n", "*2\r\n$-1\r\n*0\r\n", "*-1\r\n", "+OK\r\n"]) {
        const db = new UpstashRedisExecutor(options({ fetch: () => Promise.resolve(reply(value)) }));
        await expect(db.execute(command)).rejects.toMatchObject({ code: "protocol" });
      }
      const nulls = new UpstashRedisExecutor(options({ fetch: () => Promise.resolve(reply("*2\r\n$-1\r\n$-1\r\n")) }));
      expect(await nulls.execute(command)).toEqual({ kind: "array", values: [null, null] });
      const mixed = new UpstashRedisExecutor(options({ fetch: () => Promise.resolve(reply("*2\r\n$-1\r\n$1\r\nx\r\n")) }));
      expect(await mixed.execute(command)).toEqual({ kind: "array", values: [null, { kind: "bytes", base64: "eA==" }] });
    }
    const wrong: readonly { command: readonly string[]; value: string }[] = [
      { command: ["GET", "k"], value: ":1\r\n" },
      { command: ["HGET", "k", "f"], value: "+secret-server-status\r\n" },
      { command: ["ZSCORE", "k", "m"], value: "*0\r\n" },
      { command: ["TYPE", "k"], value: "$6\r\nstring\r\n" },
      { command: ["EXISTS", "k"], value: "$1\r\n1\r\n" },
      { command: ["HEXISTS", "k", "f"], value: "$-1\r\n" },
    ];
    for (const { command, value } of wrong) {
      const db = new UpstashRedisExecutor(options({ fetch: () => Promise.resolve(reply(value)) }));
      await expect(db.execute(command)).rejects.toThrow("Redis read failed (protocol)");
    }
    for (const command of [["GET", "missing"], ["HGET", "missing", "f"], ["ZSCORE", "missing", "m"]]) {
      const missing = new UpstashRedisExecutor(options({ fetch: () => Promise.resolve(reply("$-1\r\n")) }));
      expect(await missing.execute(command)).toBeNull();
    }
  });

  it("forces escaped literal SCAN and refuses whole malformed/foreign/oversized pages", async () => {
    const transport = vi.fn<typeof fetch>(() => Promise.resolve(reply(scan("18446744073709551615", ["tenant[*]:k", "tenant[*]:k"]))));
    const db = new UpstashRedisExecutor(options({ scanPrefix: "tenant[*]:", fetch: transport }));
    const result = await db.execute(["SCAN", "0", "COUNT", "1"]);
    expect(result).toMatchObject({ kind: "array" });
    expect(commandBody(transport.mock.calls[0]?.[1]?.body)).toEqual(["SCAN", "0", "COUNT", "1", "MATCH", "tenant\\[\\*\\]:*"]);
    await expect(db.execute(["SCAN", "0", "MATCH", "*"])).rejects.toMatchObject({ code: "policy" });
    for (const value of [scan("0", ["tenant:foreign"]), scan("18446744073709551616", []), scan("-1", []), "*1\r\n$1\r\n0\r\n", "*2\r\n:0\r\n*0\r\n", scan("0", Array.from({ length: 257 }, () => "tenant[*]:k"))]) {
      const hostile = new UpstashRedisExecutor(options({ scanPrefix: "tenant[*]:", fetch: () => Promise.resolve(reply(value)) }));
      await expect(hostile.execute(["SCAN", "0"])).rejects.toBeInstanceOf(RedisReadError);
    }
    const empty = new UpstashRedisExecutor(options({ scanPrefix: "tenant:", fetch: () => Promise.resolve(reply(scan("7", []))) }));
    expect(await empty.execute(["SCAN", "0"])).toMatchObject({ kind: "array", values: [{ kind: "bytes", base64: "Nw==" }, { kind: "array", values: [] }] });
  });

  it("redacts service/provider failures and never falls back after a SCAN token refusal", async () => {
    for (const status of [400, 401, 403, 429, 500, 302]) {
      const transport = vi.fn<typeof fetch>(() => Promise.resolve(reply("provider-secret-body", { status })));
      const db = new UpstashRedisExecutor(options({ scanPrefix: "tenant:", fetch: transport }));
      await expect(db.execute(["SCAN", "0"])).rejects.toThrow(/^Redis read failed \((?:denied|transport)\)$/u);
      expect(transport).toHaveBeenCalledTimes(1);
    }
    const noToken = new UpstashRedisExecutor(options({ token: () => { throw new Error("secret-token-cause"); } }));
    await expect(noToken.execute(["GET", "k"])).rejects.toThrow("Redis read failed (transport)");
    for (const token of ["", "bad\r\ntoken", "a".repeat(8193)]) {
      const transport = vi.fn<typeof fetch>();
      await expect(new UpstashRedisExecutor(options({ token, fetch: transport })).execute(["GET", "k"])).rejects.toMatchObject({ code: "denied" });
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it("requires exactly one complete RESP2 reply and caps declared and actual body bytes", async () => {
    for (const value of ["", ":9223372036854775808\r\n", ":1\r\n:2\r\n", "$4\r\nab", "%0\r\n"]) {
      await expect(new UpstashRedisExecutor(options({ fetch: () => Promise.resolve(reply(value)) })).execute(["GET", "k"])).rejects.toMatchObject({ code: "protocol" });
    }
    await expect(new UpstashRedisExecutor(options({ fetch: () => Promise.resolve(new Response('{"result":1}', { headers: { "content-type": "application/json" } })) })).execute(["GET", "k"])).rejects.toMatchObject({ code: "protocol" });
    for (const headers of [{ "content-length": "101" }, { "content-length": "not-a-length" }]) {
      await expect(new UpstashRedisExecutor(options({ maxReplyBytes: 100, fetch: () => Promise.resolve(reply(":1\r\n", { headers })) })).execute(["GET", "k"])).rejects.toMatchObject({ code: "limit" });
    }
    await expect(new UpstashRedisExecutor(options({ maxReplyBytes: 5, fetch: () => Promise.resolve(reply(bulk("long-value"))) })).execute(["GET", "k"])).rejects.toMatchObject({ code: "limit" });
  });
});

describe("whole-request caller/deadline and response ownership", () => {
  it("does no work after preabort and bounds never-resolving token acquisition", async () => {
    vi.useFakeTimers();
    const token = vi.fn(() => new Promise<string>(() => undefined));
    const transport = vi.fn<typeof fetch>();
    const db = new UpstashRedisExecutor(options({ token, fetch: transport, timeoutMs: 20 }));
    const aborted = new AbortController(); aborted.abort(new Error("secret-abort-cause"));
    await expect(db.execute(["GET", "k"], aborted.signal)).rejects.toMatchObject({ reason: "caller" });
    expect(token).not.toHaveBeenCalled();
    const work = db.execute(["GET", "k"]);
    const failure = expect(work).rejects.toMatchObject({ reason: "deadline" });
    await vi.advanceTimersByTimeAsync(20); await failure;
    expect(transport).not.toHaveBeenCalled();
  });

  it("withholds late responses after caller cancellation and cancels their body without waiting", async () => {
    let complete: ((value: Response) => void) | undefined;
    let started: (() => void) | undefined;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    let first = true;
    const transport: typeof fetch = () => {
      if (!first) return Promise.resolve(reply(":1\r\n"));
      first = false;
      return new Promise<Response>(resolve => { complete = resolve; started?.(); });
    };
    const caller = new AbortController();
    const db = new UpstashRedisExecutor(options({ fetch: transport }));
    const work = db.execute(["GET", "k"], caller.signal);
    await dispatched;
    caller.abort(new Error("secret-caller-cause"));
    await expect(work).rejects.toBeInstanceOf(QueryCancelledError);
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const late = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "content-type": "application/octet-stream" } });
    if (complete === undefined) throw new Error("fixture was not dispatched");
    complete(late);
    await Promise.resolve(); await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await db.execute(["EXISTS", "k"])).toEqual({ kind: "integer", value: "1" });
  });

  it("cancels during asynchronous token acquisition without starting fetch", async () => {
    let started: (() => void) | undefined;
    const acquiring = new Promise<void>(resolve => { started = resolve; });
    const token = (): Promise<string> => { started?.(); return new Promise<string>(() => undefined); };
    const transport = vi.fn<typeof fetch>();
    const caller = new AbortController();
    const work = new UpstashRedisExecutor(options({ token, fetch: transport })).execute(["GET", "k"], caller.signal);
    await acquiring; caller.abort(new Error("secret-token-caller-cause"));
    await expect(work).rejects.toMatchObject({ reason: "caller" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("consumes late fetch rejection and synchronous abort+reject without exposing causes", async () => {
    const caller = new AbortController();
    const transport: typeof fetch = () => { caller.abort(new Error("secret-abort-cause")); return Promise.reject(new Error("secret-fetch-rejection")); };
    await expect(new UpstashRedisExecutor(options({ fetch: transport })).execute(["GET", "k"], caller.signal)).rejects.toMatchObject({ reason: "caller" });
    await Promise.resolve();
  });

  it("consumes a deferred fetch rejection after the cancellation result was delivered", async () => {
    let rejectFetch: ((error: Error) => void) | undefined;
    let started: (() => void) | undefined;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    const transport: typeof fetch = () => new Promise<Response>((_resolve, reject) => { rejectFetch = reject; started?.(); });
    const caller = new AbortController();
    const work = new UpstashRedisExecutor(options({ fetch: transport })).execute(["GET", "k"], caller.signal);
    await dispatched; caller.abort();
    await expect(work).rejects.toMatchObject({ reason: "caller" });
    if (rejectFetch === undefined) throw new Error("fixture was not dispatched");
    rejectFetch(new Error("secret-late-fetch-cause"));
    await Promise.resolve(); await Promise.resolve();
  });

  it("bounds an ignoring fetch deadline and cleans up a response arriving afterwards", async () => {
    vi.useFakeTimers();
    let complete: ((value: Response) => void) | undefined;
    let started: (() => void) | undefined;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    const transport: typeof fetch = () => new Promise<Response>(resolve => { complete = resolve; started?.(); });
    const work = new UpstashRedisExecutor(options({ fetch: transport, timeoutMs: 20 })).execute(["GET", "k"]);
    const failure = expect(work).rejects.toMatchObject({ reason: "deadline" });
    await dispatched; await vi.advanceTimersByTimeAsync(20); await failure;
    const cancel = vi.fn(() => { throw new Error("secret-cancel-failure"); });
    if (complete === undefined) throw new Error("fixture was not dispatched");
    complete(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "content-type": "application/octet-stream" } }));
    await Promise.resolve(); await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels a stalled body on deadline without waiting for its rejecting cleanup", async () => {
    vi.useFakeTimers();
    let opened: (() => void) | undefined;
    const reading = new Promise<void>(resolve => { opened = resolve; });
    const cancel = vi.fn(() => Promise.reject(new Error("secret-cancel-rejection")));
    const stream = new ReadableStream<Uint8Array>({ pull() { opened?.(); }, cancel }, { highWaterMark: 0 });
    const db = new UpstashRedisExecutor(options({ fetch: () => Promise.resolve(new Response(stream, { headers: { "content-type": "application/octet-stream" } })), timeoutMs: 20 }));
    const work = db.execute(["GET", "k"]);
    const failure = expect(work).rejects.toMatchObject({ reason: "deadline" });
    await reading; await vi.advanceTimersByTimeAsync(20); await failure;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("checks caller cancellation after reader cleanup before returning success", async () => {
    const caller = new AbortController();
    const response = reply(":1\r\n");
    const body = response.body;
    if (body === null) throw new Error("fixture body missing");
    const reader = body.getReader();
    Object.defineProperty(body, "getReader", { value: () => reader });
    vi.spyOn(reader, "cancel").mockImplementation(() => { caller.abort(new Error("secret-cleanup-cause")); return Promise.resolve(); });
    await expect(new UpstashRedisExecutor(options({ fetch: () => Promise.resolve(response) })).execute(["EXISTS", "k"], caller.signal)).rejects.toMatchObject({ reason: "caller" });
  });

  it("checks elapsed deadline even before an event-loop timer is serviced", async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const transport = vi.fn<typeof fetch>();
    const db = new UpstashRedisExecutor(options({ timeoutMs: 10, token: () => { clock.mockReturnValue(11); return secret; }, fetch: transport }));
    await expect(db.execute(["GET", "k"])).rejects.toMatchObject({ reason: "deadline" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("withholds success when the elapsed deadline is crossed during reader cleanup", async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const response = reply(":1\r\n");
    const body = response.body;
    if (body === null) throw new Error("fixture body missing");
    const reader = body.getReader();
    Object.defineProperty(body, "getReader", { value: () => reader });
    vi.spyOn(reader, "cancel").mockImplementation(() => { clock.mockReturnValue(11); return Promise.resolve(); });
    await expect(new UpstashRedisExecutor(options({ timeoutMs: 10, fetch: () => Promise.resolve(response) })).execute(["EXISTS", "k"])).rejects.toMatchObject({ reason: "deadline" });
  });
});
