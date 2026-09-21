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
    expect(body(fetch).databaseId).toBe("");
    expect(body(fetch).keys).toEqual([{ partitionId: { projectId: "test-project", databaseId: "(default)" }, path: [{ kind: "items", name: "milk" }] }, { partitionId: { projectId: "test-project", databaseId: "(default)" }, path: [{ kind: "items", name: "eggs" }] }]);
    expect(accessToken).toHaveBeenCalledOnce();
  });

  it("uses Datastore insert, upsert, and delete mutations", async () => {
    const { database: db, fetch } = database();
    fetch.mockImplementation(() => Promise.resolve(response(200, { mutationResults: [{}] })));
    await db.insert(key("items", "milk"), { title: "Buy", nested: { urgent: true }, tags: ["shop"] });
    expect(body(fetch).databaseId).toBe("");
    expect(body(fetch).mutations).toEqual([{ insert: { key: { partitionId: { projectId: "test-project", databaseId: "(default)" }, path: [{ kind: "items", name: "milk" }] }, properties: { title: { stringValue: "Buy" }, nested: { entityValue: { properties: { urgent: { booleanValue: true } } } }, tags: { arrayValue: { values: [{ stringValue: "shop" }] } } } } }]);
    await db.set(key("items", "milk"), { title: "Replace" });
    expect(body(fetch, 1).mutations).toHaveLength(1); expect((body(fetch, 1).mutations as { upsert: unknown }[])[0]?.upsert).toBeDefined();
    await db.delete(key("items", "milk"));
    expect((body(fetch, 2).mutations as { delete: unknown }[])[0]?.delete).toBeDefined();
  });

  it("maps conflict and rejects partial updates before network access", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(409, { error: { message: "do not leak row" } }));
    await expect(db.insert(key("items", "milk"), {})).rejects.toMatchObject({ name: "AlreadyExistsError" });
    await expect(db.update(key("items", "missing"), {})).rejects.toBeInstanceOf(UnsupportedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("compiles bounded filters, order, offset, namespace and cursor paging", async () => {
    const { database: db, fetch } = database({ namespaceId: "tenant-a", maxQueryLimit: 10 });
    const items = collection<{ done: boolean; priority: number }>("items");
    fetch.mockResolvedValueOnce(response(200, { batch: { entityResults: [{ entity: entity("milk", { done: { booleanValue: false }, priority: { integerValue: "2" } }) }], endCursor: "next", moreResults: "NOT_FINISHED" } }));
    await expect(db.query(items.query().where("done", "==", false).where("priority", "in", [1, 2]).orderBy(DOCUMENT_ID, "desc").limit(5).offset(2).build())).resolves.toEqual({ records: [{ key: key("items", "milk"), exists: true, data: { done: false, priority: 2 } }], nextCursor: { values: ["dalgo-datastore:v1:bmV4dA"] } });
    const request = body(fetch);
    expect(request.partitionId).toEqual({ namespaceId: "tenant-a" });
    expect(request.query).toMatchObject({ kind: [{ name: "items" }], limit: 5, offset: 2, order: [{ property: { name: "__key__" }, direction: "DESCENDING" }] });
  });

  it("rejects semantics it cannot preserve before network access", async () => {
    const { database: db, fetch } = database(); const items = collection<{ done: boolean }>("items");
    await expect(db.query(items.query().startAt("cursor").build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(items.query().where("done", "array-contains", true).build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(items.query().where("done", "in", []).build())).rejects.toThrow("1 to 10");
    await expect(db.query(items.query().where("done", ">", false).build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.query(items.query().where("done", "!=", false).where("priority" as never, "not-in", [1]).orderBy("done").build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.runReadwriteTransaction(() => Promise.resolve("no"))).rejects.toBeInstanceOf(UnsupportedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses only adapter-generated opaque cursors and rejects nested arrays", async () => {
    const { database: db, fetch } = database();
    const items = collection<{ done: boolean }>("items");
    fetch.mockResolvedValueOnce(response(200, { batch: { entityResults: [], endCursor: "next", moreResults: "MORE_RESULTS_AFTER_LIMIT" } }));
    const page = await db.query(items.query().orderBy("done").limit(2).build());
    const cursor = page.nextCursor;
    if (cursor === undefined) throw new Error("test requires a continuation cursor");
    fetch.mockResolvedValueOnce(response(200, { batch: { entityResults: [], endCursor: "", moreResults: "NO_MORE_RESULTS" } }));
    await db.query(items.query().orderBy("done").startAfter(...cursor.values).build());
    expect((body(fetch, 1).query as { startCursor: string }).startCursor).toBe("next");
    await expect(db.query(items.query().orderBy("done").startAfter("next").build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.insert(key("items", "nested"), { values: [["not allowed"]] })).rejects.toThrow("nested arrays");
  });

  it("rejects undocumented continuation states, empty continuation cursor, and pages above the requested limit", async () => {
    const { database: db, fetch } = database();
    const items = collection<{ done: boolean }>("items");
    fetch.mockResolvedValueOnce(response(200, { batch: { entityResults: [], endCursor: "", moreResults: "MORE_RESULTS_AFTER_CURSOR" } }));
    await expect(db.query(items.query().orderBy("done").limit(1).build())).rejects.toEqual(new DatastoreRequestError());
    fetch.mockResolvedValueOnce(response(200, { batch: { entityResults: [], endCursor: "next", moreResults: "UNKNOWN" } }));
    await expect(db.query(items.query().orderBy("done").limit(1).build())).rejects.toEqual(new DatastoreRequestError());
    fetch.mockResolvedValueOnce(response(200, { batch: { entityResults: [{ entity: entity("one", { done: { booleanValue: true } }) }, { entity: entity("two", { done: { booleanValue: false } }) }], endCursor: "", moreResults: "NO_MORE_RESULTS" } }));
    await expect(db.query(items.query().orderBy("done").limit(1).build())).rejects.toEqual(new DatastoreRequestError());
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
