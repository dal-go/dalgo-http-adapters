import { identityCodec, type Codec } from "@dalgo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeCosmosAadToken } from "../src/index.js";
import { deferred, nativeKey, page, requestHeaders, response, setup } from "./native-fixture.js";

const query = { sql: "SELECT * FROM c WHERE c.kind=@kind", parameters: [{ name: "@kind", value: "owned" }], partition: "tenant:a", limit: 1 };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("native Cosmos continuation/session ownership", () => {
  it("traverses empty and short evaluated pages and sends only parameterized single-partition requests", async () => {
    const { database, fetch } = setup({ pageSize: 2 });
    fetch.mockResolvedValueOnce(page([], "empty-position")).mockResolvedValueOnce(page(["a"], "short-position")).mockResolvedValueOnce(page(["b"]));
    const result = await database.queryNative({ ...query, limit: 2 });
    expect(result.documents.map(document => document.key.id)).toEqual(["a", "b"]); expect(result.pages).toBe(3); expect(result.nextCursor).toBeUndefined();
    expect(requestHeaders(fetch, 1).get("x-ms-continuation")).toBe("empty-position"); expect(requestHeaders(fetch, 2).get("x-ms-continuation")).toBe("short-position");
    expect(requestHeaders(fetch).get("x-ms-documentdb-query-enablecrosspartition")).toBe(null);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe('{"query":"SELECT * FROM c WHERE c.kind=@kind","parameters":[{"name":"@kind","value":"owned"}]}');
    expect(requestHeaders(fetch, 2).get("x-ms-max-item-count")).toBe("1"); database.close();
  });
  it("binds exact query/partition/parameters/limit and instance before auth, then consumes a successful handle once", async () => {
    const { database, fetch, authorization } = setup(); fetch.mockResolvedValueOnce(page(["a"], "private-position"));
    const first = await database.queryNative(query); const cursor = first.nextCursor;
    if (cursor === undefined) throw new Error("fixture needs cursor");
    expect(JSON.stringify(cursor)).not.toContain("private");
    for (const changed of [{ ...query, sql: "SELECT * FROM c" }, { ...query, partition: "other" }, { ...query, limit: 2 }, { ...query, parameters: [{ name: "@kind", value: "changed" }] }]) await expect(database.queryNative({ ...changed, cursor })).rejects.toMatchObject({ code: "cursor" });
    const other = setup(); await expect(other.database.queryNative({ ...query, cursor })).rejects.toMatchObject({ code: "cursor" }); expect(other.authorization).not.toHaveBeenCalled(); other.database.close();
    expect(authorization).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(page(["b"])); expect((await database.queryNative({ ...query, cursor })).documents[0]?.key.id).toBe("b");
    await expect(database.queryNative({ ...query, cursor })).rejects.toMatchObject({ code: "cursor" }); database.close();
  });
  it("rejects repeated service tokens and duplicate native identities before caller codec, preserving old handle for progressing retry", async () => {
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(page(["a"], "first"));
    const first = await database.queryNative(query); const decode = vi.fn((value: unknown) => value); const codec: Codec<unknown> = { ...identityCodec, decode };
    fetch.mockResolvedValueOnce(page(["b"], "first")); await expect(database.queryNative({ ...query, cursor: first.nextCursor }, { codec })).rejects.toMatchObject({ code: "protocol" });
    fetch.mockResolvedValueOnce(page(["a"], "second")); await expect(database.queryNative({ ...query, cursor: first.nextCursor }, { codec })).rejects.toMatchObject({ code: "protocol" });
    expect(decode).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(page(["b"], "second")); expect((await database.queryNative({ ...query, cursor: first.nextCursor }, { codec })).documents[0]?.key.id).toBe("b");
    expect(decode).toHaveBeenCalledTimes(1); database.close();
  });
  it("never silently upgrades default consistency from observed session headers", async () => {
    const { database, fetch } = setup();
    fetch.mockResolvedValueOnce(page([], "position", { "x-ms-session-token": "observed-one" })).mockResolvedValueOnce(page(["a"], undefined, { "x-ms-session-token": "observed-two" }));
    const result = await database.queryNative(query); expect(result.metadata[0]?.session).toBeDefined();
    for (let i = 0; i < 2; i++) { expect(requestHeaders(fetch, i).get("x-ms-session-token")).toBe(null); expect(requestHeaders(fetch, i).get("x-ms-consistency-level")).toBe(null); }
    expect(JSON.stringify(result)).not.toContain("observed-"); database.close();
  });
  it("explicitly opts into same-partition session consistency and echoes latest only within that traversal", async () => {
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(response(undefined, { "x-ms-session-token": "seed" }));
    const session = (await database.getNative(nativeKey)).metadata.session;
    if (session === undefined) throw new Error("fixture needs session");
    fetch.mockResolvedValueOnce(page([], "position", { "x-ms-session-token": "latest" })).mockResolvedValueOnce(page(["a"]));
    await database.queryNative(query, { session });
    expect(requestHeaders(fetch, 1).get("x-ms-session-token")).toBe("seed"); expect(requestHeaders(fetch, 2).get("x-ms-session-token")).toBe("latest"); expect(requestHeaders(fetch, 2).get("x-ms-consistency-level")).toBe("Session");
    await expect(database.getNative({ ...nativeKey, partition: "other" }, { session })).rejects.toMatchObject({ code: "session" });
    const other = setup(); await expect(other.database.getNative(nativeKey, { session })).rejects.toMatchObject({ code: "session" }); expect(other.authorization).not.toHaveBeenCalled(); other.database.close(); database.close();
  });
  it("refuses exact credential rotation for cursors and sessions before HTTP instead of trusting only authScopeId", async () => {
    let token = "first"; const { database, fetch } = setup({ authorization: () => nativeCosmosAadToken(token) });
    fetch.mockResolvedValueOnce(page(["a"], "position", { "x-ms-session-token": "observed" }));
    const first = await database.queryNative(query); token = "rotated";
    await expect(database.queryNative({ ...query, cursor: first.nextCursor })).rejects.toMatchObject({ code: "cursor" });
    const session = first.metadata[0]?.session; if (session === undefined) throw new Error("fixture needs session");
    await expect(database.getNative(nativeKey, { session })).rejects.toMatchObject({ code: "session" });
    expect(fetch).toHaveBeenCalledTimes(1); token = "first"; fetch.mockResolvedValueOnce(page(["b"]));
    expect((await database.queryNative({ ...query, cursor: first.nextCursor })).documents[0]?.key.id).toBe("b"); database.close();
  });
  it("retains spent page/request/byte work across failed resume and does not reset the original deadline", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const { database, fetch, authorization } = setup({ timeoutMs: 100, maxPages: 2 }); fetch.mockResolvedValueOnce(page(["a"], "first"));
    const first = await database.queryNative(query); fetch.mockResolvedValueOnce(page(["b"], "first"));
    await expect(database.queryNative({ ...query, cursor: first.nextCursor })).rejects.toMatchObject({ code: "protocol" });
    await expect(database.queryNative({ ...query, cursor: first.nextCursor })).rejects.toMatchObject({ code: "bounds" });
    expect(fetch).toHaveBeenCalledTimes(2); expect(authorization).toHaveBeenCalledTimes(2);
    now = 101; await expect(database.queryNative({ ...query, cursor: first.nextCursor })).rejects.toMatchObject({ code: "cursor" }); database.close();
  });
  it("applies aggregate cursor retention at net replacement and preserves the old handle on quota refusal", async () => {
    const a = "a".repeat(200); const b = "b".repeat(200);
    const { database, fetch } = setup({ maxCursorBytes: 1000 }); fetch.mockResolvedValueOnce(page([a], "first"));
    const first = await database.queryNative(query);
    fetch.mockResolvedValueOnce(page([b], "second")); await expect(database.queryNative({ ...query, cursor: first.nextCursor })).rejects.toMatchObject({ code: "bounds" });
    // Terminal retry consumes the existing cursor and needs no retained successor.
    fetch.mockResolvedValueOnce(page([b])); expect((await database.queryNative({ ...query, cursor: first.nextCursor })).documents[0]?.key.id).toBe(b);
    fetch.mockResolvedValueOnce(page([a], "fresh")); expect((await database.queryNative(query)).nextCursor).toBeDefined(); database.close();
  });
  it("bounds observed sessions in the same registry and releases them on TTL or Close", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const { database, fetch } = setup({ maxHandles: 1, cursorTtlMs: 10 }); fetch.mockImplementation(() => Promise.resolve(response(undefined, { "x-ms-session-token": "observed" })));
    const first = await database.getNative(nativeKey); await expect(database.getNative(nativeKey)).rejects.toMatchObject({ code: "bounds" });
    now = 11; await expect(database.getNative(nativeKey, { session: first.metadata.session })).rejects.toMatchObject({ code: "session" });
    expect((await database.getNative(nativeKey)).metadata.session).toBeDefined(); database.close();
    await expect(database.getNative(nativeKey)).rejects.toMatchObject({ code: "closed" });
  });
  it("does not ACK after codec cancellation, and gates concurrent resume until ignored I/O physically settles", async () => {
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(page(["a"], "first")); const first = await database.queryNative(query);
    const caller = new AbortController(); const entered = deferred<undefined>(); const late = deferred<Response>(); const cleaned = deferred<undefined>();
    fetch.mockImplementationOnce(() => { entered.resolve(undefined); return late.promise; });
    const failed = expect(database.queryNative({ ...query, cursor: first.nextCursor }, { signal: caller.signal })).rejects.toMatchObject({ reason: "caller" });
    await entered.promise;
    await expect(database.queryNative({ ...query, cursor: first.nextCursor })).rejects.toMatchObject({ code: "busy" });
    caller.abort(); await failed;
    await expect(database.queryNative({ ...query, cursor: first.nextCursor })).rejects.toMatchObject({ code: "busy" });
    late.resolve(new Response(new ReadableStream<Uint8Array>({ cancel: () => { cleaned.resolve(undefined); } })));
    await cleaned.promise; fetch.mockImplementation(() => Promise.resolve(page(["b"])));
    await vi.waitFor(async () => { expect((await database.queryNative({ ...query, cursor: first.nextCursor })).documents[0]?.key.id).toBe("b"); });
    database.close();
  });
  it("preserves a prior cursor when caller codec revokes delivery, then retries its source page", async () => {
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(page(["a"], "first")); const first = await database.queryNative(query);
    const caller = new AbortController(); const codec: Codec<unknown> = { ...identityCodec, decode: value => { caller.abort(); return value; } };
    fetch.mockResolvedValueOnce(page(["b"], "second")); await expect(database.queryNative({ ...query, cursor: first.nextCursor }, { signal: caller.signal, codec })).rejects.toMatchObject({ reason: "caller" });
    fetch.mockResolvedValueOnce(page(["b"])); expect((await database.queryNative({ ...query, cursor: first.nextCursor })).documents[0]?.key.id).toBe("b"); database.close();
  });
});
