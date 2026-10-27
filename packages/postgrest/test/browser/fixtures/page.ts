// The page the Playwright suite drives. It is bundled by test/browser/server.ts
// and runs the real adapter source in Chromium. The only input from the runner
// is the real PostgREST URL in the query string and a synthetic JWT passed to
// each call; no PostgREST response is served or intercepted by the page.
import { collection } from "@dalgo/core";

import { PostgrestDatabase, PostgrestHttpError } from "../../../src/index.js";

interface ItemRow {
  readonly title: string;
  readonly priority: number;
  readonly done: boolean;
  readonly score: number | null;
  readonly tags: string[] | null;
}

interface AttemptError {
  readonly name: string;
  readonly status?: number;
  readonly message: string;
}

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AttemptError };

interface AllowedResult {
  readonly origin: string;
  readonly discovery: {
    readonly status: string;
    readonly reason?: string;
    readonly relationCount: number;
    readonly relations: readonly {
      readonly name: string;
      readonly readable: boolean;
      readonly fieldsStatus: string;
      readonly primaryKey: { readonly status: string; readonly columns: readonly string[] };
      readonly idColumn: {
        readonly name: string;
        readonly present: boolean;
        readonly declaredPrimaryKey: boolean;
        readonly uniqueStatus: string;
      };
      readonly adapterQueryable: boolean;
    }[];
  };
  readonly connection: { readonly ok: boolean; readonly status: string; readonly schema?: string };
  readonly pages: number;
  readonly nonEmptyPages: number;
  readonly recordsPerPage: readonly number[];
  readonly requests: number;
  readonly cursorOnEmptyPage: boolean;
  readonly rows: readonly {
    readonly id: string;
    readonly priority: number;
    readonly done: boolean;
    readonly score: number | null;
    readonly tags: readonly string[] | null;
  }[];
}

interface BadCredentialResult {
  readonly query: AttemptError;
  readonly connection: { readonly ok: boolean; readonly status: string; readonly httpStatus?: number };
}

function baseUrl(): string {
  const value = new URLSearchParams(location.search).get("postgrest");
  if (value === null || value === "") throw new Error("the postgrest query parameter is required");
  return value;
}

function database(token: string, requests: { count: number }): PostgrestDatabase {
  return new PostgrestDatabase({
    baseUrl: baseUrl(),
    allowInsecureLoopbackHttp: true,
    schema: "api",
    headers: () => ({
      authorization: `Bearer ${token}`,
      // A synthetic publishable key. It is not a service-role or admin key.
      apikey: "synthetic-publishable-anon-key",
    }),
    fetch: (input, init) => {
      requests.count += 1;
      return globalThis.fetch(input, init);
    },
  });
}

function attemptError(error: unknown): AttemptError {
  if (error instanceof PostgrestHttpError) {
    return { name: error.name, status: error.status, message: error.message };
  }
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

const items = collection<ItemRow>("items");

const harness = {
  origin: (): string => location.origin,

  async allowed(token: string): Promise<AllowedResult> {
    const requests = { count: 0 };
    const db = database(token, requests);
    const discovery = await db.discover();
    const connection = await db.testConnection();

    const rows: AllowedResult["rows"][number][] = [];
    const recordsPerPage: number[] = [];
    let pages = 0;
    let nonEmptyPages = 0;
    let cursorOnEmptyPage = false;
    let cursor: string | undefined;
    for (;;) {
      const builder = items.query().orderBy("priority").limit(5);
      const page = await db.queryWithSignal(
        cursor === undefined ? builder.build() : builder.startAfter(cursor).build(),
        new AbortController().signal,
      );
      pages += 1;
      recordsPerPage.push(page.records.length);
      if (page.records.length === 0) {
        cursorOnEmptyPage = page.nextCursor !== undefined;
        break;
      }
      nonEmptyPages += 1;
      for (const record of page.records) {
        rows.push({
          id: String(record.key.id),
          priority: record.data.priority,
          done: record.data.done,
          score: record.data.score,
          tags: record.data.tags,
        });
      }
      cursor = page.nextCursor?.values[0] as string | undefined;
      if (cursor === undefined) break;
      if (pages > 10) throw new Error("pagination did not terminate");
    }

    return {
      origin: location.origin,
      discovery: {
        status: discovery.status,
        ...(discovery.reason === undefined ? {} : { reason: discovery.reason }),
        relationCount: discovery.relationCount,
        relations: discovery.relations.map((relation) => ({
          name: relation.name,
          readable: relation.readable,
          fieldsStatus: relation.fieldsStatus,
          primaryKey: relation.primaryKey,
          idColumn: relation.idColumn,
          adapterQueryable: relation.adapterQueryable,
        })),
      },
      connection,
      pages,
      nonEmptyPages,
      recordsPerPage,
      requests: requests.count,
      cursorOnEmptyPage,
      rows,
    };
  },

  async attempt(token: string): Promise<Attempt<AllowedResult>> {
    return attempt(() => this.allowed(token));
  },

  async badCredential(token: string): Promise<BadCredentialResult> {
    const requests = { count: 0 };
    const db = database(token, requests);
    const query = (await attempt(() => db.queryWithSignal(items.query().limit(1).build(), new AbortController().signal)));
    const connection = await db.testConnection();
    return {
      query: query.ok ? { name: "none", message: "query unexpectedly succeeded" } : query.error,
      connection,
    };
  },

  async cancelled(token: string): Promise<AttemptError> {
    const requests = { count: 0 };
    const db = database(token, requests);
    const controller = new AbortController();
    controller.abort();
    const result = await attempt(() => db.queryWithSignal(items.query().limit(1).build(), controller.signal));
    return result.ok ? { name: "none", message: "query unexpectedly succeeded" } : result.error;
  },
};

(globalThis as unknown as { harness: typeof harness }).harness = harness;
