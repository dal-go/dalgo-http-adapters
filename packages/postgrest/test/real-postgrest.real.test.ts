import { UnsupportedError, collection, key } from "@dalgo/core";
import { describe, expect, it } from "vitest";

import { PostgrestCursorError, PostgrestDatabase, PostgrestHttpError } from "../src/index.js";

const environment = (globalThis as {
  process?: { env?: Record<string, string | undefined> };
}).process?.env ?? {};
const baseUrl = environment.POSTGREST_TEST_URL;
const jwt = environment.POSTGREST_TEST_JWT;
const corsOrigin = environment.POSTGREST_TEST_CORS_ORIGIN ?? "https://datatug.example";
const schema = environment.POSTGREST_TEST_SCHEMA ?? "api";

function database(options: Partial<ConstructorParameters<typeof PostgrestDatabase>[0]> = {}) {
  if (baseUrl === undefined || jwt === undefined) throw new Error("real PostgREST test environment is not configured");
  return new PostgrestDatabase({
    baseUrl,
    allowInsecureLoopbackHttp: true,
    schema,
    headers: () => ({ authorization: `Bearer ${jwt}`, apikey: "synthetic-publishable-anon-key" }),
    ...options,
  });
}

const items = collection<{ title: string; priority: number; done: boolean; score: number | null; tags: string[] | null }>("items");

describe.skipIf(baseUrl === undefined || jwt === undefined)("real PostgREST v16 fixture", () => {
  it("discovers only the role-visible relations, declared fields and primary keys", async () => {
    const db = database();
    const discovery = await db.discover();

    expect(discovery).toMatchObject({
      status: "available",
      protocol: "postgrest-openapi",
      schema,
      relationCount: 2,
      truncated: false,
    });
    expect(discovery.relations.map((relation) => relation.name).sort()).toEqual(["items", "items_view"]);

    const itemRelation = discovery.relations.find((relation) => relation.name === "items");
    expect(itemRelation).toMatchObject({
      readable: true,
      fieldsStatus: "declared",
      primaryKey: { status: "declared", columns: ["id"] },
      idColumn: { name: "id", present: true, declaredPrimaryKey: true },
      adapterQueryable: true,
    });
    expect(itemRelation?.methods).toEqual(expect.arrayContaining(["get"]));
    expect(itemRelation?.fields.find((field) => field.name === "id")).toMatchObject({
      type: "string",
      format: "text",
      declaredPrimaryKey: true,
      nullable: false,
    });
    expect(itemRelation?.fields.find((field) => field.name === "priority")).toMatchObject({
      type: "integer",
      nullable: false,
    });
    expect(itemRelation?.fields.find((field) => field.name === "score")).toMatchObject({ nullable: true });
    expect(itemRelation?.fields.find((field) => field.name === "tags")).toMatchObject({
      array: true,
      itemsType: "string",
    });

    await expect(db.testConnection()).resolves.toMatchObject({
      ok: true,
      status: "connected",
      relationCount: 2,
      schema,
    });
  });

  it("pages a real relation with small provider pages, stable tie-breakers and honest end-of-pages", async () => {
    const db = database({ maxQueryLimit: 2 });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const builder = items.query()
        .where("done", "==", false)
        .orderBy("priority")
        .limit(2);
      const page = await db.queryWithSignal(
        cursor === undefined ? builder.build() : builder.startAfter(cursor).build(),
        new AbortController().signal,
      );
      pages += 1;
      expect(page.records.length).toBeLessThanOrEqual(2);
      seen.push(...page.records.map((record) => String(record.key.id)));
      for (const record of page.records) {
        expect(typeof record.data.priority).toBe("number");
        expect(record.data.done).toBe(false);
        expect(record.data.score === null || typeof record.data.score === "number").toBe(true);
      }
      cursor = page.nextCursor?.values[0] as string | undefined;
      if (cursor === undefined) break;
      expect(pages).toBeLessThan(10);
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual(["i3", "i1", "i4", "i2", "i5"]);

    const bounded = items.query().where("id", "in", ["i1", "i2"]).orderBy("priority").limit(1).build();
    const first = await db.queryWithSignal(bounded, new AbortController().signal);
    const second = await db.queryWithSignal(
      items.query().where("id", "in", ["i1", "i2"]).orderBy("priority").limit(1)
        .startAfter(first.nextCursor?.values[0]).build(),
      new AbortController().signal,
    );
    expect(second.nextCursor).toBeDefined();
    const empty = await db.queryWithSignal(
      items.query().where("id", "in", ["i1", "i2"]).orderBy("priority").limit(1)
        .startAfter(second.nextCursor?.values[0]).build(),
      new AbortController().signal,
    );
    expect(empty).toEqual({ records: [] });
  });

  it("continues past nullable order keys against the real database", async () => {
    const db = database({ maxQueryLimit: 2 });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const builder = items.query().orderBy("score").limit(2);
      const page = await db.queryWithSignal(
        cursor === undefined ? builder.build() : builder.startAfter(cursor).build(),
        new AbortController().signal,
      );
      pages += 1;
      seen.push(...page.records.map((record) => String(record.key.id)));
      cursor = page.nextCursor?.values[0] as string | undefined;
      if (cursor === undefined) break;
      expect(pages).toBeLessThan(10);
    }
    expect(seen).toEqual(["i3", "i5", "i6", "i1", "i2", "i4", "i7"]);
  });

  it("rejects changed or foreign cursors and unsupported cursor combinations before HTTP", async () => {
    const db = database({ maxQueryLimit: 2 });
    const first = await db.queryWithSignal(
      items.query().orderBy("priority").limit(2).build(),
      new AbortController().signal,
    );
    const cursor = first.nextCursor?.values[0];
    expect(typeof cursor).toBe("string");
    if (typeof cursor !== "string") throw new Error("real PostgREST cursor missing");

    await expect(db.queryWithSignal(
      items.query().orderBy("priority").limit(2).where("done", "==", true).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "PostgrestCursorError", reason: "changed-query" });

    await expect(db.queryWithSignal(
      items.query().orderBy("title").limit(2).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "PostgrestCursorError", reason: "changed-query" });

    await expect(db.queryWithSignal(
      items.query().orderBy("priority").limit(1).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: "PostgrestCursorError", reason: "changed-query" });

    await expect(db.queryWithSignal(
      collection("items_view").query().orderBy("priority").limit(2).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(PostgrestCursorError);

    await expect(db.queryWithSignal(
      items.query().orderBy("priority").limit(2).offset(1).startAfter(cursor).build(),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(UnsupportedError);
  });

  it("maps bad auth and a read-only role to explicit, redacted failures", async () => {
    if (baseUrl === undefined) throw new Error("real PostgREST test environment is not configured");
    const bad = new PostgrestDatabase({
      baseUrl,
      allowInsecureLoopbackHttp: true,
      schema,
      headers: () => ({ authorization: "Bearer bad.token.value", apikey: "synthetic-publishable-anon-key" }),
    });
    await expect(bad.testConnection()).resolves.toMatchObject({ ok: false, status: "unauthorized", httpStatus: 401 });
    const badRead = await bad.queryWithSignal(items.query().limit(1).build(), new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(badRead).toEqual(new PostgrestHttpError(401));
    expect(String(badRead)).not.toContain("row");

    const readOnly = database();
    const denied = await readOnly.insert(key("items", "i-denied"), {
      title: "must not be written",
      priority: 1,
      done: false,
      score: null,
      tags: null,
    }).catch((reason: unknown) => reason);
    expect(denied).toBeInstanceOf(PostgrestHttpError);
    expect([401, 403]).toContain((denied as PostgrestHttpError).status);
    expect(String(denied)).not.toContain("permission");
    await expect(readOnly.get(key("items", "i-denied"))).resolves.toEqual({ key: key("items", "i-denied"), exists: false });
  });

  it("returns explicit no-relations metadata for the unauthenticated role", async () => {
    if (baseUrl === undefined) throw new Error("real PostgREST test environment is not configured");
    const anon = new PostgrestDatabase({
      baseUrl,
      allowInsecureLoopbackHttp: true,
      schema,
      headers: () => ({ apikey: "synthetic-publishable-anon-key" }),
    });
    const discovery = await anon.discover();
    expect(discovery).toMatchObject({ status: "unavailable", reason: "no-relations", relationCount: 0 });
    expect(discovery.detail).toContain("not evidence that the database is empty");
    await expect(anon.testConnection()).resolves.toMatchObject({ ok: true, status: "connected", relationCount: 0 });
  });

  it("honours exact-origin CORS and controlled profile/auth headers against the real service", async () => {
    if (baseUrl === undefined) throw new Error("real PostgREST test environment is not configured");
    const preflight = await globalThis.fetch(`${baseUrl}/items`, {
      method: "OPTIONS",
      headers: {
        origin: corsOrigin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,apikey,accept-profile,content-profile,prefer",
      },
    });
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(corsOrigin);
    const allowed = preflight.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
    for (const header of ["authorization", "apikey", "accept-profile", "content-profile", "prefer"]) {
      expect(allowed).toContain(header);
    }

    const actual = await globalThis.fetch(`${baseUrl}/items?select=*&limit=1`, {
      headers: {
        origin: corsOrigin,
        authorization: `Bearer ${jwt ?? ""}`,
        apikey: "synthetic-publishable-anon-key",
        "accept-profile": schema,
      },
    });
    expect(actual.status).toBe(200);
    expect(actual.headers.get("access-control-allow-origin")).toBe(corsOrigin);

    const wrong = await globalThis.fetch(`${baseUrl}/items?select=*&limit=1`, {
      headers: { origin: "https://evil.example", authorization: `Bearer ${jwt ?? ""}` },
    });
    expect(wrong.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("reports disabled or missing metadata as unavailable rather than an empty database", async () => {
    if (baseUrl === undefined) throw new Error("real PostgREST test environment is not configured");
    const missing = new PostgrestDatabase({
      baseUrl: `${baseUrl}/not-a-postgrest-root`,
      allowInsecureLoopbackHttp: true,
      headers: () => ({ authorization: `Bearer ${jwt ?? ""}` }),
    });
    const discovery = await missing.discover();
    expect(discovery.status).toBe("unavailable");
    expect(["metadata-disabled", "request-failed"]).toContain(discovery.reason);
    expect(discovery.relations).toEqual([]);
  });
});
