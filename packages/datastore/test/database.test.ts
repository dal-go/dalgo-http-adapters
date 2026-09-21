import { DOCUMENT_ID, UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";

import { DatastoreDatabase, DatastoreHttpError, DatastoreRequestError } from "../src/index.js";

function response(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers });
}

function entity(id: string, properties: Record<string, unknown>): unknown {
  return { key: { path: [{ kind: "items", name: id }] }, properties };
}

function database(options: Partial<ConstructorParameters<typeof DatastoreDatabase>[0]> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const accessToken = vi.fn(() => "opaque-token");
  return { fetch, accessToken, database: new DatastoreDatabase({ projectId: "test-project", accessToken, fetch, apiBaseUrl: "https://datastore.example/v1/", ...options }) };
}

function body(fetch: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> { return JSON.parse(fetch.mock.calls[call]?.[1]?.body as string) as Record<string, unknown>; }

describe("DatastoreDatabase", () => {
  it("looks up ordered keys and maps JSON values without retaining a token", async () => {
    const { database: db, fetch, accessToken } = database();
    fetch.mockResolvedValueOnce(response(200, { found: [{ entity: entity("milk", { title: { stringValue: "Buy milk" }, done: { booleanValue: false }, count: { integerValue: "2" } }) }], missing: [{ entity: entity("eggs", {}) }] }));
    await expect(db.getMany([key("items", "milk"), key("items", "eggs")])).resolves.toEqual([
      { key: key("items", "milk"), exists: true, data: { title: "Buy milk", done: false, count: 2 } }, { key: key("items", "eggs"), exists: false },
    ]);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe("https://datastore.example/v1/projects/test-project:lookup");
    expect((fetch.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer opaque-token");
    expect(body(fetch).keys).toEqual([{ partitionId: { projectId: "test-project", databaseId: "(default)" }, path: [{ kind: "items", name: "milk" }] }, { partitionId: { projectId: "test-project", databaseId: "(default)" }, path: [{ kind: "items", name: "eggs" }] }]);
    expect(accessToken).toHaveBeenCalledOnce();
  });

  it("uses Datastore insert, upsert, update, and delete mutations", async () => {
    const { database: db, fetch } = database();
    fetch.mockImplementation(() => Promise.resolve(response(200, { mutationResults: [{}] })));
    await db.insert(key("items", "milk"), { title: "Buy", nested: { urgent: true }, tags: ["shop"] });
    expect(body(fetch).mutations).toEqual([{ insert: { key: { partitionId: { projectId: "test-project", databaseId: "(default)" }, path: [{ kind: "items", name: "milk" }] }, properties: { title: { stringValue: "Buy" }, nested: { entityValue: { properties: { urgent: { booleanValue: true } } } }, tags: { arrayValue: { values: [{ stringValue: "shop" }] } } } } }]);
    await db.set(key("items", "milk"), { title: "Replace" });
    expect(body(fetch, 1).mutations).toHaveLength(1); expect((body(fetch, 1).mutations as { upsert: unknown }[])[0]?.upsert).toBeDefined();
    await db.update(key("items", "milk"), { title: "Patch" });
    expect((body(fetch, 2).mutations as { update: unknown }[])[0]?.update).toBeDefined();
    await db.delete(key("items", "milk"));
    expect((body(fetch, 3).mutations as { delete: unknown }[])[0]?.delete).toBeDefined();
  });

  it("maps conflict and update-missing statuses to DALgo errors", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(409, { error: { message: "do not leak row" } }));
    await expect(db.insert(key("items", "milk"), {})).rejects.toMatchObject({ name: "AlreadyExistsError" });
    fetch.mockResolvedValueOnce(response(404, { error: { message: "do not leak row" } }));
    await expect(db.update(key("items", "missing"), {})).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("compiles bounded filters, order, offset, namespace and cursor paging", async () => {
    const { database: db, fetch } = database({ namespaceId: "tenant-a", maxQueryLimit: 10 });
    const items = collection<{ done: boolean; priority: number }>("items");
    fetch.mockResolvedValueOnce(response(200, { batch: { entityResults: [{ entity: entity("milk", { done: { booleanValue: false }, priority: { integerValue: "2" } }) }], endCursor: "next", moreResults: "NOT_FINISHED" } }));
    await expect(db.query(items.query().where("done", "==", false).where("priority", "in", [1, 2]).orderBy(DOCUMENT_ID, "desc").limit(5).offset(2).startAfter("cursor").build())).resolves.toEqual({ records: [{ key: key("items", "milk"), exists: true, data: { done: false, priority: 2 } }], nextCursor: { values: ["next"] } });
    const request = body(fetch);
    expect(request.partitionId).toEqual({ namespaceId: "tenant-a" });
    expect(request.query).toMatchObject({ kind: [{ name: "items" }], limit: 5, offset: 2, startCursor: "cursor", order: [{ property: { name: "__key__" }, direction: "DESCENDING" }] });
  });

  it("rejects semantics it cannot preserve before network access", async () => {
    const { database: db, fetch } = database(); const items = collection<{ done: boolean }>("items");
    await expect(db.query(items.query().startAt("cursor").build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(items.query().where("done", "array-contains", true).build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(items.query().where("done", "in", []).build())).rejects.toThrow("1 to 10");
    await expect(db.runReadwriteTransaction(() => Promise.resolve("no"))).rejects.toBeInstanceOf(UnsupportedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsafe JSON, secrets in transport failures, bad endpoints, malformed responses and oversized bodies", async () => {
    const { database: db, fetch } = database({ maxRequestBytes: 20, maxResponseBytes: 20 });
    await expect(db.insert(key("items", "milk"), { text: "too long for cap" })).rejects.toThrow("maxRequestBytes");
    fetch.mockResolvedValueOnce(response(500, { secret: "never expose" }));
    const normal = database({ fetch }).database;
    await expect(normal.get(key("items", "milk"))).rejects.toEqual(new DatastoreHttpError(500));
    fetch.mockRejectedValueOnce(new Error("Bearer opaque-token must never surface"));
    await expect(normal.get(key("items", "milk"))).rejects.toEqual(new DatastoreRequestError());
    fetch.mockResolvedValueOnce(response(200, { found: [] }, { "content-length": "999" }));
    await expect(normal.get(key("items", "milk"))).rejects.toEqual(new DatastoreRequestError());
    expect(() => new DatastoreDatabase({ projectId: "p", accessToken: () => "x", apiBaseUrl: "https://user:password@datastore.example/v1" })).toThrow("credentials");
  });
});
