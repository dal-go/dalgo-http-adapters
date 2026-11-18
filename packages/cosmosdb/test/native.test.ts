import { collection, identityCodec, key, type Codec } from "@dalgo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeNativeCosmosJson, NativeCosmosError, NativeCosmosHttpError, NativeCosmosNoSqlDatabase, nativeCosmosAadToken, nativeCosmosNumber, nativeCosmosResourceToken } from "../src/index.js";
import { nativeDocument, nativeKey, page, requestHeaders, response, setup } from "./native-fixture.js";

afterEach(() => { vi.restoreAllMocks(); });
describe("native existing Cosmos documents", () => {
  it("preserves original IDs and lossless JSON with explicit partition and typed once-encoded auth", async () => {
    const { database, fetch, authorization } = setup(); fetch.mockResolvedValueOnce(response(nativeDocument, { "x-ms-request-charge": "1.2500", "x-ms-activity-id": "owned-activity" }));
    const result = await database.getNative(nativeKey);
    expect(encodeNativeCosmosJson(result.document?.data)).toBe(nativeDocument);
    expect(result.document?.key).toEqual(nativeKey); expect(result.document?.metadata.etag).toBe("revision");
    expect(result.metadata.requestCharge?.lexeme).toBe("1.2500");
    expect(fetch.mock.calls[0]?.[0]).toBe("https://owned.documents.azure.com/dbs/app/colls/items/docs/original");
    const headers = requestHeaders(fetch);
    expect(headers.get("authorization")).toBe(encodeURIComponent("type=resource&ver=1.0&sig=owned+/="));
    expect(headers.get("x-ms-documentdb-partitionkey")).toBe('["tenant:a"]');
    expect(headers.has("x-ms-consistency-level")).toBe(false);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(authorization.mock.calls[0]).toHaveLength(1);
    database.close();
  });
  it("keeps AAD raw envelope, redacts credentials and refuses guessed/master/encoded headers", async () => {
    const token = nativeCosmosAadToken("owned.jwt-token"); expect(String(token)).not.toContain("jwt"); expect(JSON.stringify(token)).toBe("{}");
    const { database, fetch } = setup({ authorization: () => token }); fetch.mockResolvedValueOnce(response());
    await database.getNative(nativeKey); expect(requestHeaders(fetch).get("authorization")).toBe("type=aad&ver=1.0&sig=owned.jwt-token");
    for (const raw of ["master-secret", "type=master&ver=1.0&sig=owned", "type%3Dresource%26ver%3D1.0%26sig%3Downed", "type=resource&ver=1.0&sig=x&extra=y"]) expect(() => nativeCosmosResourceToken(raw)).toThrow(NativeCosmosError);
    expect(() => nativeCosmosAadToken("Bearer private")).toThrow(NativeCosmosError); database.close();
  });
  it("distinguishes missing and unknown charge from zero, with safe429 and no retry", async () => {
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(response("", undefined, 404));
    expect(await database.getNative(nativeKey)).toEqual({ document: null, metadata: {} });
    fetch.mockResolvedValueOnce(response("PRIVATE_BODY", { "x-ms-request-charge": "0", "x-ms-retry-after-ms": "250" }, 429));
    const error: unknown = await database.getNative(nativeKey).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(NativeCosmosHttpError); expect(error).toMatchObject({ status: 429, retryAfterMs: 250, metadata: { requestCharge: nativeCosmosNumber("0") } });
    expect(String(error)).not.toContain("PRIVATE"); expect(fetch).toHaveBeenCalledTimes(2); database.close();
  });
  it("preflights all native batch keys, preserves order/duplicates/missing and never rewrites partitions", async () => {
    const { database, fetch, authorization } = setup(); fetch.mockResolvedValueOnce(response()).mockResolvedValueOnce(response("", undefined, 404)).mockResolvedValueOnce(response());
    const result = await database.getManyNative([nativeKey, { id: "missing", partition: "other" }, nativeKey]);
    expect(result.documents.map(document => document?.key.id ?? null)).toEqual(["original", null, "original"]);
    expect(requestHeaders(fetch, 1).get("x-ms-documentdb-partitionkey")).toBe('["other"]');
    await expect(database.getManyNative([nativeKey, { id: "invalid/id", partition: "other" }])).rejects.toMatchObject({ code: "input" });
    expect(authorization).toHaveBeenCalledTimes(3);
    expect((await database.getManyNative([])).documents).toEqual([]); database.close();
  });
  it("exposes only configured DALgo bindings and leaves provider writes/transactions as not implemented", async () => {
    const { database, fetch, authorization } = setup(); fetch.mockResolvedValue(response());
    expect(await database.get(key("items", "original"))).toMatchObject({ exists: true, key: key("items", "original") });
    await expect(database.get(key("other", "original"))).rejects.toMatchObject({ code: "input" });
    await expect(database.get(key("items", 1))).rejects.toMatchObject({ code: "input" });
    const callback = vi.fn<() => Promise<void>>(() => Promise.resolve(undefined));
    await expect(database.insert(key("items", "a"), {})).rejects.toThrow("not implemented");
    await expect(database.runReadwriteTransaction(callback)).rejects.toThrow("not implemented");
    await expect(database.query(collection("items").query().build())).rejects.toThrow("not implemented");
    expect(callback).not.toHaveBeenCalled(); expect(authorization).toHaveBeenCalledTimes(1);
    expect(database.configuredMetadata()).toMatchObject({ provenance: "trusted configuration", discovery: false }); database.close();
  });
  it("snapshots source native identity/revision before an in-place caller codec", async () => {
    const codec: Codec<Record<string, unknown>> = { ...identityCodec, decode: value => {
      if (typeof value !== "object" || value === null) throw new Error("fixture object");
      Object.assign(value, { id: "changed", _etag: "changed" }); return { transformed: true };
    } };
    const { database, fetch } = setup(); fetch.mockResolvedValueOnce(response()).mockResolvedValueOnce(page(["original"]));
    const point = await database.getNative(nativeKey, { codec });
    expect(point.document).toMatchObject({ key: nativeKey, metadata: { etag: "revision" }, data: { transformed: true } });
    const query = await database.queryNative({ sql: "SELECT * FROM c", partition: "tenant:a", limit: 1 }, { codec });
    expect(query.documents[0]).toMatchObject({ key: nativeKey, metadata: { etag: "revision" } }); database.close();
  });
  it("refuses foreign/missing physical identity, malformed count, duplicate page IDs and projection replies", async () => {
    const { database, fetch } = setup();
    for (const body of ['{"id":"foreign","tenant":"tenant:a"}', '{"id":"original"}', '{"id":"original","tenant":"other"}']) {
      fetch.mockResolvedValueOnce(response(body)); await expect(database.getNative(nativeKey)).rejects.toMatchObject({ code: "protocol" });
    }
    for (const body of ['{"Documents":[{"count":1}]}', '{"Documents":[],"_count":1}', `{"Documents":[${nativeDocument},${nativeDocument}]}`]) {
      fetch.mockResolvedValueOnce(response(body)); await expect(database.queryNative({ sql: "SELECT * FROM c", partition: "tenant:a", limit: 2 })).rejects.toMatchObject({ code: "protocol" });
    }
    database.close();
  });
  it("refuses unsupported partition forms, reserved physical fields and aggregate escaped input before auth", async () => {
    const { database, authorization, fetch } = setup({ maxRequestBytes: 512 });
    const get = vi.fn(() => "private"); const hostile = Object.defineProperty({}, "x", { get, enumerable: true });
    for (const value of ["\u0000".repeat(1000), hostile, { n: 9007199254740992 }]) await expect(database.queryNative({ sql: "SELECT * FROM c WHERE c.x=@x", partition: "tenant:a", parameters: [{ name: "@x", value }] })).rejects.toBeInstanceOf(NativeCosmosError);
    await expect(database.getNative({ id: "original", partition: "" })).rejects.toMatchObject({ code: "input" });
    expect(get).not.toHaveBeenCalled(); expect(authorization).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(() => new NativeCosmosNoSqlDatabase({ endpoint: "https://owned.example", databaseId: "app", containerId: "items", partitionKeyField: "_etag", authScopeId: "owned", authorization: () => nativeCosmosAadToken("owned") })).toThrow(NativeCosmosError);
    database.close();
  });
});
