import { DOCUMENT_ID, collection, key } from "@dalgo/core";
import { describe, expect, it } from "vitest";

import {
  LibSQLDatabase,
  LibSQLHttpError,
  NativeLibSQLDatabase,
  type LibSQLDatabaseOptions,
  type NativeLibSQLDatabaseOptions,
} from "../src/index.js";

const environment = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const url = environment.LIBSQL_TEST_URL;
const readerToken = environment.LIBSQL_TEST_READER_TOKEN;

function authorization(): Record<string, string> {
  if (readerToken === undefined) throw new Error("real libSQL test environment is not configured");
  return { authorization: `Bearer ${readerToken}` };
}

const managedTables: LibSQLDatabaseOptions["tables"] = {
  items: {
    table: "items",
    uniqueKey: true,
    keyColumn: { column: "id", nullable: false },
    columns: {
      title: { column: "title", nullable: false },
      rank: { column: "rank", nullable: true },
      score: { column: "score", nullable: true },
      done: { column: "done", nullable: false },
      code: { column: "code", nullable: false },
    },
  },
};

const nativeTables: NativeLibSQLDatabaseOptions["tables"] = {
  items: {
    table: "items",
    uniqueKey: true,
    key: { column: "id", type: "integer" },
    columns: {
      title: { column: "title", nullable: false },
      rank: { column: "rank", nullable: true },
      score: { column: "score", nullable: true },
      done: { column: "done", nullable: false },
      code: { column: "code", nullable: false },
    },
  },
  labels: {
    table: "labels",
    uniqueKey: true,
    key: { column: "code", type: "text" },
    columns: { label: { column: "label", nullable: true } },
  },
  metrics: {
    table: "metrics",
    uniqueKey: true,
    key: { column: "ratio", type: "real" },
    columns: { label: { column: "label", nullable: true } },
  },
  items_view: {
    table: "items_view",
    uniqueKey: true,
    key: { column: "id", type: "integer" },
    columns: { title: { column: "title", nullable: false }, rank: { column: "rank", nullable: true } },
  },
  blobs: {
    table: "blobs",
    uniqueKey: true,
    key: { column: "id", type: "integer" },
    columns: { payload: { column: "payload", nullable: true } },
  },
  bigints: {
    table: "bigints",
    uniqueKey: true,
    key: { column: "id", type: "integer" },
    columns: { label: { column: "label", nullable: true } },
  },
};

function managed(overrides: Partial<LibSQLDatabaseOptions> = {}): LibSQLDatabase {
  if (url === undefined) throw new Error("real libSQL test environment is not configured");
  return new LibSQLDatabase({
    serverUrl: url,
    allowInsecureLoopbackHttp: true,
    headers: authorization,
    identityScope: "real-reader",
    maxRows: 100,
    timeoutMs: 10_000,
    tables: managedTables,
    ...overrides,
  });
}

function native(overrides: Partial<NativeLibSQLDatabaseOptions> = {}): NativeLibSQLDatabase {
  if (url === undefined) throw new Error("real libSQL test environment is not configured");
  return new NativeLibSQLDatabase({
    serverUrl: url,
    allowInsecureLoopbackHttp: true,
    headers: authorization,
    identityScope: "real-reader",
    maxQueryLimit: 100,
    timeoutMs: 10_000,
    tables: nativeTables,
    ...overrides,
  });
}

const items = collection<{ title: string; rank: number | null; score: number | null; done: number; code: string }, number>("items");

describe.skipIf(url === undefined || readerToken === undefined)("real commit-pinned libSQL server", () => {
  it("discovers real tables, views, declared types and uniqueness without inventing a key", async () => {
    const db = native();
    const discovery = await db.discover();
    expect(discovery).toMatchObject({
      status: "available",
      protocol: "sqlite-hrana-pipeline",
      tableCount: 8,
      truncated: false,
    });
    expect(discovery.tables.map((table) => table.name).sort())
      .toEqual(["bigints", "blobs", "composite", "items", "items_view", "labels", "metrics", "nullable_pk"]);

    const itemsTable = discovery.tables.find((table) => table.name === "items");
    expect(itemsTable).toMatchObject({
      kind: "table",
      allowlisted: true,
      fieldsStatus: "declared",
      primaryKey: { status: "declared", columns: ["id"] },
      unique: { status: "declared-primary-key" },
      configuredKey: { collection: "items", column: "id", type: "integer" },
      adapterQueryable: true,
    });
    expect(itemsTable?.fields.find((field) => field.name === "id")).toMatchObject({ declaredType: "INTEGER", affinity: "integer", primaryKeyPosition: 1 });
    expect(itemsTable?.fields.find((field) => field.name === "rank")).toMatchObject({ declaredType: "INTEGER", nullable: true });
    expect(itemsTable?.fields.find((field) => field.name === "score")).toMatchObject({ declaredType: "REAL", affinity: "real", nullable: true });

    expect(discovery.tables.find((table) => table.name === "labels")).toMatchObject({
      unique: { status: "configured-contract" },
      adapterQueryable: true,
    });
    expect(discovery.tables.find((table) => table.name === "metrics")).toMatchObject({
      unique: { status: "configured-contract" },
      adapterQueryable: true,
    });
    expect(discovery.tables.find((table) => table.name === "items_view")).toMatchObject({
      kind: "view",
      unique: { status: "configured-contract" },
      adapterQueryable: true,
    });
    expect(discovery.tables.find((table) => table.name === "composite")).toMatchObject({
      unique: { status: "not-unique" },
      adapterQueryable: false,
    });
    expect(discovery.tables.find((table) => table.name === "nullable_pk")).toMatchObject({
      unique: { status: "not-unique" },
      adapterQueryable: false,
    });
    expect(discovery.tables.find((table) => table.name === "blobs")?.fields.find((field) => field.name === "payload"))
      .toMatchObject({ declaredType: "BLOB", affinity: "blob" });

    await expect(db.testConnection()).resolves.toMatchObject({ ok: true, status: "connected", tableCount: 8 });
    const description = await db.describe();
    expect(description.readOnly).toBe(true);
    expect(description.storage).toBe("native-rows");
  });

  it("pages nullable native sort values with safe integer IDs, no duplicates and a sticky empty page", async () => {
    const db = native();
    const seen: number[] = [];
    const recordsPerPage: number[] = [];
    let shortPageHadCursor = false;
    let emptyPageHadCursor = false;
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const builder = items.query().orderBy("rank").limit(5);
      const page = await db.queryWithSignal(
        cursor === undefined ? builder.build() : builder.startAfter(cursor).build(),
        new AbortController().signal,
      );
      recordsPerPage.push(page.records.length);
      if (page.records.length === 0) {
        emptyPageHadCursor = page.nextCursor !== undefined;
        break;
      }
      if (page.records.length < 5) shortPageHadCursor = page.nextCursor !== undefined;
      for (const record of page.records) {
        expect(typeof record.key.id).toBe("number");
        expect(record.metadata).toEqual({ id: record.key.id });
        expect(record.data).not.toHaveProperty("id");
        seen.push(record.key.id as number);
      }
      cursor = page.nextCursor?.values[0] as string | undefined;
      if (cursor === undefined) break;
    }
    expect(recordsPerPage).toEqual([5, 5, 2, 0]);
    expect(shortPageHadCursor).toBe(true);
    expect(emptyPageHadCursor).toBe(false);
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    expect(seen).toEqual([4, 8, 3, 6, 10, 1, 2, 7, 11, 5, 9, 12]);

    const desc: number[] = [];
    let descCursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const builder = items.query().orderBy("rank", "desc").limit(5);
      const page = await db.queryWithSignal(
        descCursor === undefined ? builder.build() : builder.startAfter(descCursor).build(),
        new AbortController().signal,
      );
      if (page.records.length === 0) break;
      desc.push(...page.records.map((record) => record.key.id as number));
      descCursor = page.nextCursor?.values[0] as string | undefined;
    }
    expect(desc).toHaveLength(12);
    expect(new Set(desc).size).toBe(12);
    expect(desc.slice(0, 3)).toEqual([5, 9, 12]);
    expect(desc.slice(-2)).toEqual([4, 8]);
  });

  it("continues a short non-empty page instead of treating it as end-of-data", async () => {
    const db = native();
    const done = collection<{ title: string; rank: number | null; score: number | null; done: number; code: string }, number>("items");
    const first = await db.queryWithSignal(
      done.query().where("done", "==", 1).orderBy("rank").limit(5).build(),
      new AbortController().signal,
    );
    expect(first.records).toHaveLength(3);
    expect(first.nextCursor).toBeDefined();
    const second = await db.queryWithSignal(
      done.query().where("done", "==", 1).orderBy("rank").limit(5).startAfter(first.nextCursor?.values[0]).build(),
      new AbortController().signal,
    );
    expect(second).toEqual({ records: [] });
  });

  it("preserves text and fractional native keys and refuses unsafe integers and blobs", async () => {
    const db = native();
    await expect(db.get(key("labels", "a1"))).resolves.toMatchObject({
      key: key("labels", "a1"),
      exists: true,
      data: { label: "Alpha" },
      metadata: { id: "a1" },
    });
    await expect(db.get(key("metrics", 0.1))).resolves.toMatchObject({
      key: key("metrics", 0.1),
      exists: true,
      data: { label: "tenth" },
      metadata: { id: 0.1 },
    });
    const metrics = collection<{ label: string | null }, number>("metrics");
    const metricPage = await db.queryWithSignal(metrics.query().orderBy(DOCUMENT_ID).limit(2).build(), new AbortController().signal);
    expect(metricPage.records.map((record) => record.key.id)).toEqual([0.1, 0.2]);

    await expect(db.get(key("blobs", 1))).rejects.toThrow("blob");
    const huge = collection<{ label: string | null }, number>("bigints");
    await expect(db.queryWithSignal(huge.query().orderBy("label").limit(2).build(), new AbortController().signal))
      .rejects.toThrow("safe-integer");
    await expect(db.get(key("items", 9_007_199_254_740_992))).rejects.toThrow("safe integers");
  });

  it("keeps managed queryWithSignal keyset paging and legacy position cursors working", async () => {
    const db = managed();
    const modern: number[] = [];
    let modernCursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const builder = items.query().orderBy("done").limit(5);
      const page = await db.queryWithSignal(
        modernCursor === undefined ? builder.build() : builder.startAfter(modernCursor).build(),
        new AbortController().signal,
      );
      if (page.records.length === 0) break;
      modern.push(...page.records.map((record) => record.key.id as number));
      modernCursor = page.nextCursor?.values[0] as string | undefined;
      expect(modernCursor).toBeDefined();
    }
    expect(modern).toHaveLength(12);
    expect(new Set(modern).size).toBe(12);

    const legacy: number[] = [];
    let legacyCursor: readonly unknown[] | undefined;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const builder = items.query().orderBy("done").limit(5);
      const page = await db.query(
        legacyCursor === undefined ? builder.build() : (builder.startAfter(...legacyCursor).build()),
      );
      legacy.push(...page.records.map((record) => record.key.id as number));
      legacyCursor = page.nextCursor?.values;
      if (legacyCursor === undefined) break;
    }
    expect(legacy).toHaveLength(12);
    expect(new Set(legacy).size).toBe(12);
    expect(legacy.slice(0, 2)).toEqual([1, 2]);
  });

  it("queries a real view through an explicit configured contract only", async () => {
    const view = collection<{ title: string; rank: number | null }, number>("items_view");
    const page = await native().queryWithSignal(view.query().orderBy(DOCUMENT_ID).limit(3).build(), new AbortController().signal);
    expect(page.records).toHaveLength(3);
    expect(page.records.map((record) => record.key.id)).toEqual([1, 2, 3]);
    const configMismatch = native({
      tables: {
        labels: { table: "labels", uniqueKey: true, key: { column: "code", type: "integer" }, columns: { label: { column: "label", nullable: true } } },
      },
    });
    const discovery = await configMismatch.discover();
    expect(discovery.tables.find((table) => table.name === "labels")?.adapterQueryable).toBe(false);
    await expect(configMismatch.get(key("labels", "a1"))).rejects.toThrow("numbers for a integer key column");
  });

  it("proves the real reader token cannot write and keeps adapter mutation refusal separate", async () => {
    const db = native();
    const probe = await globalThis.fetch(`${url ?? ""}/v3/pipeline`, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${readerToken ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify({
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "INSERT INTO items (id, title) VALUES (99, 'reader must fail')", args: [], want_rows: false } },
          { type: "close" },
        ],
      }),
    });
    expect(probe.status).toBe(403);
    const body = await probe.text();
    expect(body).not.toContain(readerToken ?? "unreachable");

    const after = await managed().query(items.query().limit(100).build());
    expect(after.records).toHaveLength(12);

    await expect(db.insert(items.key(99), { title: "no", rank: null, score: null, done: 0, code: "no" }))
      .rejects.toThrow("read-only: insert");
  });

  it("reports bad credentials and unreachable metadata as redacted explicit failures", async () => {
    const bad = managed({ headers: () => ({ authorization: "Bearer bad.token.value" }) });
    await expect(bad.discover()).resolves.toMatchObject({ status: "unavailable", reason: "unauthorized", httpStatus: 401 });
    await expect(bad.testConnection()).resolves.toMatchObject({ ok: false, status: "unauthorized", httpStatus: 401 });
    const failure = await bad.queryWithSignal(items.query().limit(1).build(), new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LibSQLHttpError);
    expect((failure as LibSQLHttpError).status).toBe(401);
    expect(String(failure)).not.toContain("bad.token.value");

    const badNative = native({ headers: () => ({ authorization: "Bearer bad.token.value" }) });
    await expect(badNative.describe()).resolves.toMatchObject({
      connection: { ok: false, status: "unauthorized", httpStatus: 401 },
      discovery: { status: "unavailable", reason: "unauthorized" },
    });
  });
});
