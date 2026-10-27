// The page the Playwright suite drives. It bundles the real adapter source and
// calls the real disposable libSQL server from Chromium with the browser's own
// fetch. The only runner input is the server URL and a synthetic reader JWT.
import { collection } from "@dalgo/core";

import {
  LibSQLDatabase,
  LibSQLHttpError,
  NativeLibSQLDatabase,
  type LibSQLDatabaseOptions,
  type NativeLibSQLDatabaseOptions,
} from "../../../src/index.js";

interface ItemRow {
  readonly title: string;
  readonly rank: number | null;
  readonly score: number | null;
  readonly done: number;
  readonly code: string;
}

interface AttemptError {
  readonly name: string;
  readonly status?: number;
  readonly message: string;
}

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AttemptError };

interface ReadResult {
  readonly origin: string;
  readonly serverOrigin: string;
  readonly discovery: {
    readonly status: string;
    readonly tableCount: number;
    readonly items: {
      readonly adapterQueryable: boolean;
      readonly uniqueStatus: string;
      readonly primaryKey: readonly string[];
    } | null;
  };
  readonly connection: { readonly ok: boolean; readonly status: string; readonly tableCount?: number };
  readonly pages: number;
  readonly recordsPerPage: readonly number[];
  readonly shortPageHadCursor: boolean;
  readonly emptyPageHadCursor: boolean;
  readonly requests: number;
  readonly rows: readonly {
    readonly id: number;
    readonly rank: number | null;
    readonly score: number | null;
    readonly done: number;
    readonly code: string;
  }[];
  readonly labelId: string;
  readonly metricId: number;
  readonly managed: { readonly pages: number; readonly ids: readonly number[]; readonly requests: number };
}

interface BadCredentialResult {
  readonly query: AttemptError;
  readonly connection: { readonly ok: boolean; readonly status: string; readonly httpStatus?: number };
}

interface WriteProbeResult {
  readonly status: number;
  readonly leakedToken: boolean;
}

interface MutationRefusalResult {
  readonly error: AttemptError;
  readonly requests: number;
}

function serverUrl(): string {
  const value = new URLSearchParams(location.search).get("libsql");
  if (value === null || value === "") throw new Error("the libsql query parameter is required");
  return value;
}

function nativeOptions(token: string, requests: { count: number }): NativeLibSQLDatabaseOptions {
  return {
    serverUrl: serverUrl(),
    allowInsecureLoopbackHttp: true,
    identityScope: "browser-fixture",
    headers: () => ({ authorization: `Bearer ${token}` }),
    fetch: (input, init) => {
      requests.count += 1;
      return globalThis.fetch(input, init);
    },
    maxQueryLimit: 100,
    tables: {
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
    },
  };
}

function managedOptions(token: string, requests: { count: number }): LibSQLDatabaseOptions {
  return {
    serverUrl: serverUrl(),
    allowInsecureLoopbackHttp: true,
    identityScope: "browser-fixture",
    headers: () => ({ authorization: `Bearer ${token}` }),
    fetch: (input, init) => {
      requests.count += 1;
      return globalThis.fetch(input, init);
    },
    maxRows: 100,
    tables: {
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
    },
  };
}

function attemptError(error: unknown): AttemptError {
  if (error instanceof LibSQLHttpError) return { name: error.name, status: error.status, message: error.message };
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: typeof error, message: String(error) };
}

async function attempt<T>(work: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: attemptError(error) };
  }
}

const items = collection<ItemRow, number>("items");

const harness = {
  origin: (): string => location.origin,

  async read(token: string): Promise<ReadResult> {
    const requests = { count: 0 };
    const db = new NativeLibSQLDatabase(nativeOptions(token, requests));
    const description = await db.describe();

    const rows: ReadResult["rows"][number][] = [];
    const recordsPerPage: number[] = [];
    let shortPageHadCursor = false;
    let emptyPageHadCursor = false;
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const builder = items.query().orderBy("rank").limit(5);
      const page = await db.queryWithSignal(
        cursor === undefined ? builder.build() : builder.startAfter(cursor).build(),
        new AbortController().signal,
      );
      pages += 1;
      recordsPerPage.push(page.records.length);
      if (page.records.length === 0) {
        emptyPageHadCursor = page.nextCursor !== undefined;
        break;
      }
      if (page.records.length < 5) shortPageHadCursor = page.nextCursor !== undefined;
      for (const record of page.records) {
        rows.push({
          id: record.key.id as number,
          rank: record.data.rank,
          score: record.data.score,
          done: record.data.done,
          code: record.data.code,
        });
      }
      cursor = page.nextCursor?.values[0] as string | undefined;
      if (cursor === undefined) break;
      if (pages > 10) throw new Error("pagination did not terminate");
    }

    const label = await db.get(collection<{ label: string | null }, string>("labels").key("a1"));
    const metric = await db.get(collection<{ label: string | null }, number>("metrics").key(0.1));
    if (!label.exists || !metric.exists) throw new Error("expected native point records are missing");

    const managedRequests = { count: 0 };
    const managed = new LibSQLDatabase(managedOptions(token, managedRequests));
    const managedIds: number[] = [];
    let managedCursor: string | undefined;
    let managedPages = 0;
    for (;;) {
      const builder = items.query().orderBy("done").limit(5);
      const page = await managed.queryWithSignal(
        managedCursor === undefined ? builder.build() : builder.startAfter(managedCursor).build(),
        new AbortController().signal,
      );
      managedPages += 1;
      if (page.records.length === 0) break;
      managedIds.push(...page.records.map((record) => record.key.id as number));
      managedCursor = page.nextCursor?.values[0] as string | undefined;
      if (managedPages > 10) throw new Error("managed pagination did not terminate");
    }

    const itemsTable = description.discovery.tables.find((table) => table.name === "items");
    return {
      origin: location.origin,
      serverOrigin: new URL(serverUrl()).origin,
      discovery: {
        status: description.discovery.status,
        tableCount: description.discovery.tableCount,
        items: itemsTable === undefined
          ? null
          : {
            adapterQueryable: itemsTable.adapterQueryable,
            uniqueStatus: itemsTable.unique.status,
            primaryKey: itemsTable.primaryKey.columns,
          },
      },
      connection: {
        ok: description.connection.ok,
        status: description.connection.status,
        ...(description.connection.tableCount === undefined ? {} : { tableCount: description.connection.tableCount }),
      },
      pages,
      recordsPerPage,
      shortPageHadCursor,
      emptyPageHadCursor,
      requests: requests.count,
      rows,
      labelId: label.key.id as string,
      metricId: metric.key.id as number,
      managed: { pages: managedPages, ids: managedIds, requests: managedRequests.count },
    };
  },

  async badCredential(token: string): Promise<BadCredentialResult> {
    const requests = { count: 0 };
    const db = new NativeLibSQLDatabase(nativeOptions(token, requests));
    const query = await attempt(() => db.queryWithSignal(items.query().limit(1).build(), new AbortController().signal));
    const connection = await db.testConnection();
    return {
      query: query.ok ? { name: "none", message: "query unexpectedly succeeded" } : query.error,
      connection,
    };
  },

  async readerWriteProbe(token: string): Promise<WriteProbeResult> {
    const response = await globalThis.fetch(`${serverUrl()}/v3/pipeline`, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        baton: null,
        requests: [
          { type: "execute", stmt: { sql: "INSERT INTO items (id, title) VALUES (99, 'browser reader must fail')", args: [], want_rows: false } },
          { type: "close" },
        ],
      }),
    });
    const body = await response.text();
    return { status: response.status, leakedToken: body.includes(token) };
  },

  async adapterMutationRefused(token: string): Promise<MutationRefusalResult> {
    const requests = { count: 0 };
    const db = new NativeLibSQLDatabase(nativeOptions(token, requests));
    const result = await attempt(() => db.insert(items.key(99), {
      title: "no",
      rank: null,
      score: null,
      done: 0,
      code: "no",
    }));
    return {
      error: result.ok ? { name: "none", message: "mutation unexpectedly succeeded" } : result.error,
      requests: requests.count,
    };
  },

  async cancelled(token: string): Promise<AttemptError> {
    const requests = { count: 0 };
    const db = new NativeLibSQLDatabase(nativeOptions(token, requests));
    const controller = new AbortController();
    controller.abort();
    const result = await attempt(() => db.queryWithSignal(items.query().limit(1).build(), controller.signal));
    return result.ok ? { name: "none", message: "query unexpectedly succeeded" } : result.error;
  },
};

(globalThis as unknown as { harness: typeof harness }).harness = harness;
