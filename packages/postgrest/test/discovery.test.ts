import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { collection, key } from "@dalgo/core";
import { describe, expect, it, vi } from "vitest";

import { PostgrestDatabase } from "../src/index.js";

function response(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status, headers });
}

function openApi(): Record<string, unknown> {
  return {
    swagger: "2.0",
    info: { title: "Synthetic PostgREST", version: "16.5" },
    paths: {
      "/": { get: { summary: "OpenAPI description" } },
      "/items": {
        get: { responses: { "200": { description: "OK" } } },
        post: { responses: { "201": { description: "Created" } } },
        patch: { responses: { "204": { description: "No Content" } } },
        delete: { responses: { "204": { description: "No Content" } } },
      },
      "/items_view": {
        get: { responses: { "200": { description: "OK" } } },
      },
      "/rpc/rebuild": {
        post: { responses: { "200": { description: "OK" } } },
      },
    },
    definitions: {
      items: {
        type: "object",
        required: ["id", "title", "done"],
        properties: {
          id: { type: "string", format: "text", description: "Note:\nThis is a Primary Key.<pk/>" },
          title: { type: "string", format: "text" },
          priority: { type: "integer", format: "int32" },
          done: { type: "boolean", format: "boolean", default: false },
          score: { type: "number", format: "numeric" },
          tags: { type: "array", format: "text[]", items: { type: "string" } },
          remote_ref: { $ref: "https://schemas.example.invalid/remote.json#/definitions/secret" },
        },
      },
      items_view: {
        type: "object",
        properties: {
          id: { type: "string", format: "text", description: "Note:\nThis is a Primary Key.<pk/>" },
          title: { type: "string", format: "text" },
        },
      },
    },
  };
}

function database(options: Partial<ConstructorParameters<typeof PostgrestDatabase>[0]> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const headers = vi.fn(() => ({ authorization: "Bearer opaque", apikey: "synthetic-public-key" }));
  return {
    fetch,
    headers,
    database: new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      fetch,
      headers,
      ...options,
    }),
  };
}

describe("PostgrestDatabase.discover", () => {
  it("reads bounded OpenAPI metadata without resolving remote references", async () => {
    const { database: db, fetch, headers } = database({ schema: "api" });
    fetch.mockResolvedValueOnce(response(200, openApi()));

    const discovery = await db.discover();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe("https://api.example.com/rest/v1/");
    expect((fetch.mock.calls[0]?.[1]?.headers as Headers).get("authorization")).toBe("Bearer opaque");
    expect((fetch.mock.calls[0]?.[1]?.headers as Headers).get("accept-profile")).toBe("api");
    expect(headers).toHaveBeenCalledTimes(1);

    expect(discovery).toMatchObject({
      adapter: "@dal-go/dalgo2postgrest",
      protocol: "postgrest-openapi",
      status: "available",
      schema: "api",
      relationCount: 2,
      truncated: false,
      omittedRelations: 0,
    });
    expect(discovery.relations.map((relation) => relation.name)).toEqual(["items", "items_view"]);
    const items = discovery.relations[0];
    expect(items).toMatchObject({
      methods: ["get", "post", "patch", "delete"],
      readable: true,
      fieldsStatus: "declared",
      primaryKey: { status: "declared", columns: ["id"] },
      idColumn: { name: "id", present: true, declaredPrimaryKey: true },
      adapterQueryable: true,
    });
    expect(items?.fields.find((field) => field.name === "id")).toMatchObject({
      type: "string", format: "text", declaredPrimaryKey: true, nullable: false, typeStatus: "declared",
    });
    expect(items?.fields.find((field) => field.name === "priority")).toMatchObject({
      type: "integer", format: "int32", nullable: true,
    });
    expect(items?.fields.find((field) => field.name === "tags")).toMatchObject({
      type: "array", format: "text[]", array: true, itemsType: "string",
    });
    expect(items?.fields.find((field) => field.name === "done")).toMatchObject({ nullable: false });
    expect(items?.fields.find((field) => field.name === "remote_ref")).toMatchObject({
      array: false, typeStatus: "unavailable",
    });
    expect(items?.fields.some((field) => field.name === "remote_ref" && field.type !== undefined)).toBe(false);
  });

  it("reports unauthorized, forbidden and disabled metadata explicitly", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(401, { details: "row secret" }));
    await expect(db.discover()).resolves.toMatchObject({
      status: "unavailable",
      reason: "unauthorized",
      httpStatus: 401,
      relations: [],
      relationCount: 0,
    });
    fetch.mockResolvedValueOnce(response(401, { details: "row secret" }));
    await expect(db.testConnection()).resolves.toMatchObject({ ok: false, status: "unauthorized", httpStatus: 401 });

    fetch.mockResolvedValueOnce(response(403, { details: "row secret" }));
    await expect(db.discover()).resolves.toMatchObject({ status: "unavailable", reason: "forbidden", httpStatus: 403 });
    fetch.mockResolvedValueOnce(response(403, { details: "row secret" }));
    await expect(db.testConnection()).resolves.toMatchObject({ ok: false, status: "forbidden" });

    fetch.mockResolvedValueOnce(response(404));
    await expect(db.discover()).resolves.toMatchObject({ status: "unavailable", reason: "metadata-disabled", httpStatus: 404 });
    fetch.mockResolvedValueOnce(response(404));
    await expect(db.testConnection()).resolves.toMatchObject({ ok: false, status: "metadata-disabled" });
  });

  it("does not confuse an empty role-visible schema with an empty database", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, { swagger: "2.0", paths: { "/": { get: {} } }, definitions: {} }));

    const discovery = await db.discover();
    expect(discovery).toMatchObject({
      status: "unavailable",
      reason: "no-relations",
      relationCount: 0,
      relations: [],
    });
    expect(discovery.detail).toContain("not evidence that the database is empty");
    fetch.mockResolvedValueOnce(response(200, { swagger: "2.0", paths: { "/": { get: {} } }, definitions: {} }));
    await expect(db.testConnection()).resolves.toMatchObject({ ok: true, status: "connected", relationCount: 0 });
  });

  it("reports malformed metadata and redacted request failures without leaking bodies", async () => {
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, { swagger: "2.0" }));
    await expect(db.discover()).resolves.toMatchObject({ status: "unavailable", reason: "malformed-metadata" });
    fetch.mockResolvedValueOnce(response(200, { swagger: "2.0" }));
    await expect(db.testConnection()).resolves.toMatchObject({ ok: false, status: "metadata-malformed" });

    fetch.mockResolvedValueOnce(response(200, undefined));
    const empty = await db.discover();
    expect(empty.status).toBe("unavailable");
    expect(empty.detail).not.toContain("secret");

    fetch.mockRejectedValueOnce(new Error("Bearer secret-token https://private.example"));
    const failed = await db.discover();
    expect(failed.status).toBe("unavailable");
    expect(failed.reason).toBe("request-failed");
    expect(JSON.stringify(failed)).not.toContain("secret-token");
  });

  it("bounds relation and field counts and reports omission", async () => {
    const { database: db, fetch } = database({
      maxDiscoveryRelations: 1,
      maxDiscoveryFieldsPerRelation: 2,
    });
    fetch.mockResolvedValueOnce(response(200, openApi()));

    const discovery = await db.discover();

    expect(discovery.relationCount).toBe(2);
    expect(discovery.truncated).toBe(true);
    expect(discovery.omittedRelations).toBe(1);
    expect(discovery.relations).toHaveLength(1);
    expect(discovery.relations[0]?.fieldsStatus).toBe("truncated");
    expect(discovery.relations[0]?.fields).toHaveLength(2);
    expect(discovery.relations[0]?.omittedFields).toBe(5);
    expect(discovery.relations[0]?.primaryKey.status).toBe("declared");
  });

  it("collects the complete composite primary key even outside the returned field budget", async () => {
    const document = openApi();
    const definitions = document.definitions as Record<string, Record<string, unknown>>;
    const items = definitions.items as Record<string, unknown>;
    items.properties = {
      id: { type: "string", format: "text", description: "Note:\nThis is a Primary Key.<pk/>" },
      title: { type: "string", format: "text" },
      region: { type: "string", format: "text", description: "Note:\nThis is a Primary Key.<pk/>" },
    };
    const { database: db, fetch } = database({ maxDiscoveryFieldsPerRelation: 1 });
    fetch.mockResolvedValueOnce(response(200, document));

    const discovery = await db.discover();
    const relation = discovery.relations[0];
    expect(relation?.fieldsStatus).toBe("truncated");
    expect(relation?.fields).toHaveLength(1);
    expect(relation?.fields.map((field) => field.name)).toEqual(["id"]);
    // The key scan is not the field projection: both declared key columns are
    // reported even though `region` is outside the returned field list.
    expect(relation?.primaryKey).toEqual({ status: "declared", columns: ["id", "region"] });
    expect(relation?.idColumn).toMatchObject({
      name: "id",
      present: true,
      declaredPrimaryKey: true,
      uniqueStatus: "not-unique",
    });
    // `readable` is provider authorization; `adapterQueryable` is not a claim
    // that the configured ID alone identifies a row or a stable page.
    expect(relation?.readable).toBe(true);
    expect(relation?.adapterQueryable).toBe(false);
    expect(relation?.adapterQueryableReason).toContain("composite");
  });

  it("does not infer uniqueness from ID-column presence when a different primary key is declared", async () => {
    const document = openApi();
    const definitions = document.definitions as Record<string, Record<string, unknown>>;
    const items = definitions.items as Record<string, unknown>;
    items.properties = {
      id: { type: "string", format: "text" },
      title: { type: "string", format: "text" },
      slug: { type: "string", format: "text", description: "Note:\nThis is a Primary Key.<pk/>" },
    };
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, document));

    const relation = (await db.discover()).relations[0];
    expect(relation?.idColumn).toMatchObject({ name: "id", present: true, declaredPrimaryKey: false, uniqueStatus: "not-unique" });
    expect(relation?.adapterQueryable).toBe(false);
    expect(relation?.adapterQueryableReason).toContain("primary key");
  });

  it("reports the configured unique-ID contract for a relation with no declared key", async () => {
    const document = openApi();
    const definitions = document.definitions as Record<string, Record<string, unknown>>;
    definitions.items_view = {
      type: "object",
      properties: {
        id: { type: "string", format: "text" },
        title: { type: "string", format: "text" },
      },
    };
    const { database: db, fetch } = database();
    fetch.mockResolvedValueOnce(response(200, document));

    const view = (await db.discover()).relations.find((relation) => relation.name === "items_view");
    expect(view?.primaryKey).toEqual({ status: "not-declared", columns: [] });
    expect(view?.idColumn).toMatchObject({ name: "id", present: true, uniqueStatus: "configured-contract" });
    expect(view?.adapterQueryable).toBe(true);
  });

  it("uses an explicit profile header for writes and refuses missing ID mappings", async () => {
    const { database: db, fetch } = database({ schema: "api", idColumn: "missing_id" });
    fetch.mockResolvedValueOnce(response(201));
    await db.insert(key("items", "milk"), { title: "Milk" });
    expect((fetch.mock.calls[0]?.[1]?.headers as Headers).get("content-profile")).toBe("api");

    fetch.mockResolvedValueOnce(response(200, openApi()));
    const discovery = await db.discover();
    const items = discovery.relations.find((relation) => relation.name === "items");
    expect(items?.idColumn).toMatchObject({ name: "missing_id", present: false, declaredPrimaryKey: false });
    expect(items?.adapterQueryable).toBe(false);
    expect(items?.adapterQueryableReason).toContain("missing_id");
  });

  it("bounds metadata response bytes without parsing an oversized document", async () => {
    const { database: db, fetch } = database({ maxDiscoveryBytes: 32 });
    fetch.mockResolvedValueOnce(response(200, openApi(), { "content-length": "999999" }));
    const byLength = await db.discover();
    expect(byLength.status).toBe("unavailable");
    expect(byLength.reason).toBe("request-failed");

    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.close();
      },
    });
    fetch.mockResolvedValueOnce(new Response(chunked, { status: 200 }));
    const byStream = await db.discover();
    expect(byStream.status).toBe("unavailable");
    expect(byStream.reason).toBe("request-failed");
  });

  it("propagates caller abort before and during metadata work", async () => {
    const { database: db, fetch, headers } = database();
    const preAborted = new AbortController();
    preAborted.abort(new Error("Bearer secret"));
    await expect(db.discover(preAborted.signal)).rejects.toBeInstanceOf(QueryCancelledError);
    await expect(db.testConnection(preAborted.signal)).rejects.toBeInstanceOf(QueryCancelledError);
    expect(headers).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    const pending = deferred<Response>();
    fetch.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const discovery = db.discover(controller.signal);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    controller.abort();
    await expect(discovery).rejects.toMatchObject({ name: "QueryCancelledError", reason: "caller" });
  });
});

describe("PostgrestDatabase transport configuration", () => {
  it("requires an explicit opt-in for loopback HTTP and keeps hosted origins HTTPS-only", () => {
    expect(() => new PostgrestDatabase({ baseUrl: "http://127.0.0.1:3000/rest/v1" }))
      .toThrow("allowInsecureLoopbackHttp");
    expect(() => new PostgrestDatabase({ baseUrl: "http://localhost:3000/rest/v1", allowInsecureLoopbackHttp: false }))
      .toThrow("allowInsecureLoopbackHttp");
    expect(() => new PostgrestDatabase({ baseUrl: "http://api.example.com/rest/v1", allowInsecureLoopbackHttp: true }))
      .toThrow("HTTPS");
    expect(() => new PostgrestDatabase({ baseUrl: "http://[::1]:3000/rest/v1", allowInsecureLoopbackHttp: true }))
      .not.toThrow();
    expect(() => new PostgrestDatabase({ baseUrl: "https://api.example.com/rest/v1" })).not.toThrow();
  });

  it("binds cursors to an optional non-secret identity scope", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const first = new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      fetch,
      identityScope: "tenant-a",
    });
    const second = new PostgrestDatabase({
      baseUrl: "https://api.example.com/rest/v1",
      fetch,
      identityScope: "tenant-b",
    });
    const items = collection<{ done: boolean }>("items");
    fetch.mockResolvedValueOnce(response(200, [{ id: "milk", done: false }]));
    const page = await first.queryWithSignal(items.query().limit(1).build(), new AbortController().signal);
    const cursor = page.nextCursor?.values[0];
    expect(typeof cursor).toBe("string");
    if (typeof cursor !== "string") throw new Error("cursor missing");

    fetch.mockResolvedValueOnce(response(200, []));
    await expect(first.queryWithSignal(
      items.query().limit(1).startAfter(cursor).build(),
      new AbortController().signal,
    )).resolves.toEqual({ records: [] });
    await expect(second.queryWithSignal(
      items.query().limit(1).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "PostgrestCursorError", reason: "changed-query" });
  });
});

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve(value: T): void {
      resolve?.(value);
    },
    reject(error: unknown): void {
      reject?.(error);
    },
  };
}
