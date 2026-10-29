import process from "node:process";

import { expect, test } from "@playwright/test";

const endpoint = process.env.TYPESENSE_BROWSER_URL;
const searchKey = process.env.TYPESENSE_BROWSER_SEARCH_KEY;
const metadataKey = process.env.TYPESENSE_BROWSER_METADATA_KEY;
const configured = endpoint !== undefined && searchKey !== undefined && metadataKey !== undefined;

interface BrowserHit {
  readonly id: string;
  readonly textMatch?: string;
  readonly document: Readonly<Record<string, unknown>>;
}

interface BrowserSearchResult {
  readonly hits: readonly BrowserHit[];
  readonly found: number;
  readonly returned: number;
  readonly complete: boolean;
  readonly provenance: string;
}

interface BrowserDatabase {
  search(request: Readonly<Record<string, unknown>>): Promise<BrowserSearchResult>;
  searchWithSignal(request: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<BrowserSearchResult>;
  query(query: Readonly<Record<string, unknown>>): Promise<{ readonly records: readonly { readonly key: { readonly id: string } }[] }>;
  queryWithSignal(query: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>;
  get(key: unknown): Promise<unknown>;
  close(): void;
}

interface BrowserAdapterModule {
  readonly TypesenseDatabase: new (options: Readonly<Record<string, unknown>>) => BrowserDatabase;
  readonly TypesenseJsonNumberError: new (...args: never[]) => Error;
}

interface BrowserVerifierModule {
  readonly createVerifier: (
    node: unknown,
  ) => (data: Readonly<Record<string, unknown>>, check: () => void) => Promise<boolean>;
  readonly predicateRoot: (query: unknown, options: { readonly maxFilterBytes: number }) => unknown;
}

interface BrowserConfig {
  readonly url: string;
  readonly searchKey: string;
  readonly metadataKey: string;
}

function config(): BrowserConfig {
  if (endpoint === undefined || searchKey === undefined || metadataKey === undefined) {
    throw new Error("browser Typesense test environment is not configured");
  }
  return { url: endpoint, searchKey, metadataKey };
}

test.describe("real Chromium Typesense SDK", () => {
  test.skip(!configured, "browser Typesense test environment is not configured");

  test("cross-origin default fetch returns an ordinary native full-text hit with an exact decimal score", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => { pageErrors.push(error.message); });
    await page.goto("/");
    await page.waitForFunction(() => (globalThis as unknown as { TypesenseAdapter?: unknown }).TypesenseAdapter !== undefined);

    const result = await page.evaluate(async (browserConfig) => {
      const { TypesenseDatabase } = (globalThis as unknown as { TypesenseAdapter: BrowserAdapterModule }).TypesenseAdapter;
      const db = new TypesenseDatabase({
        baseUrl: browserConfig.url,
        allowInsecureLoopbackHttp: true,
        collection: "books",
        headers: () => ({ "X-TYPESENSE-API-KEY": browserConfig.searchKey }),
        timeoutMs: 15_000,
        maxQueryLimit: 20,
        maxRowsPerPage: 20,
      });
      try {
        const found = await db.search({
          q: "Neuromancer",
          queryBy: ["title", "author"],
          filterBy: "genre:=`cyberpunk`",
          limit: 1,
        });
        return {
          origin: globalThis.location.origin,
          endpoint: browserConfig.url,
          hits: found.hits.map((hit) => ({ id: hit.id, textMatch: hit.textMatch, title: hit.document.title })),
          found: found.found,
          returned: found.returned,
          complete: found.complete,
          provenance: found.provenance,
        };
      } finally {
        db.close();
      }
    }, config());

    expect(pageErrors).toEqual([]);
    // A genuinely cross-origin page origin reaching the Typesense origin proves
    // Chromium applied the server's CORS response to the real request.
    expect(result.origin).not.toBe(new URL(result.endpoint).origin);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.id).toBe("004");
    expect(result.hits[0]?.title).toBe("Neuromancer");
    expect(result.hits[0]?.textMatch).toMatch(/^(?:0|[1-9]\d*)$/u);
    expect(typeof result.hits[0]?.textMatch).toBe("string");
    expect(result.found).toBe(1);
    expect(result.returned).toBe(1);
    expect(result.complete).toBe(true);
    expect(result.provenance).toBe("typesense-native-search");
  });

  test("structured exact reads keep string ids and missing versus null in Chromium", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => (globalThis as unknown as { TypesenseAdapter?: unknown }).TypesenseAdapter !== undefined);
    const result = await page.evaluate(async (browserConfig) => {
      const { TypesenseDatabase } = (globalThis as unknown as { TypesenseAdapter: BrowserAdapterModule }).TypesenseAdapter;
      const db = new TypesenseDatabase({
        baseUrl: browserConfig.url,
        allowInsecureLoopbackHttp: true,
        collection: "books",
        headers: () => ({ "X-TYPESENSE-API-KEY": browserConfig.searchKey }),
        timeoutMs: 15_000,
        maxQueryLimit: 20,
        maxRowsPerPage: 20,
      });
      try {
        const page = await db.query({
          source: { kind: "collection", name: "books" },
          filters: [{ field: "id", operator: "in", value: ["001", "005", "1"] }],
          orders: [{ field: "seq", direction: "asc" }],
          projection: ["title", "note"],
          limit: 10,
        });
        return page.records.map((record) => ({
          id: String(record.key.id),
          title: (record as unknown as { data: { title?: string } }).data.title,
          hasNote: Object.hasOwn((record as unknown as { data: Record<string, unknown> }).data, "note"),
          note: (record as unknown as { data: { note?: unknown } }).data.note,
        }));
      } finally {
        db.close();
      }
    }, config());

    expect(result).toEqual([
      { id: "1", title: "Numeric One", hasNote: false, note: undefined },
      { id: "001", title: "Dune", hasNote: false, note: undefined },
      { id: "005", title: "Foundation", hasNote: false, note: undefined },
    ]);
  });

  test("refuses an unsafe application integer at the real browser transport", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => (globalThis as unknown as { TypesenseAdapter?: unknown }).TypesenseAdapter !== undefined);
    const outcome = await page.evaluate(async (browserConfig) => {
      const { TypesenseDatabase, TypesenseJsonNumberError } = (globalThis as unknown as { TypesenseAdapter: BrowserAdapterModule }).TypesenseAdapter;
      const db = new TypesenseDatabase({
        baseUrl: browserConfig.url,
        allowInsecureLoopbackHttp: true,
        collection: "unsafe",
        headers: () => ({ "X-TYPESENSE-API-KEY": browserConfig.searchKey }),
        timeoutMs: 15_000,
        maxQueryLimit: 5,
        maxRowsPerPage: 5,
      });
      try {
        await db.query({
          source: { kind: "collection", name: "unsafe" },
          filters: [{ field: "id", operator: "==", value: "u1" }],
          orders: [],
          limit: 1,
        });
        return { refused: false, jsonError: false };
      } catch (error) {
        return { refused: true, jsonError: error instanceof TypesenseJsonNumberError };
      } finally {
        db.close();
      }
    }, config());
    expect(outcome).toEqual({ refused: true, jsonError: true });
  });

  test("a caller abort after a real cross-origin response is canonical", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => { pageErrors.push(error.message); });
    await page.goto("/");
    await page.waitForFunction(() => (globalThis as unknown as { TypesenseAdapter?: unknown }).TypesenseAdapter !== undefined);

    const outcome = await page.evaluate(async (browserConfig) => {
      const { TypesenseDatabase } = (globalThis as unknown as { TypesenseAdapter: BrowserAdapterModule }).TypesenseAdapter;
      const controller = new AbortController();
      const acknowledgement = { status: 0, contentType: "" };
      const db = new TypesenseDatabase({
        baseUrl: browserConfig.url,
        allowInsecureLoopbackHttp: true,
        collection: "books",
        headers: () => ({ "X-TYPESENSE-API-KEY": browserConfig.searchKey }),
        timeoutMs: 15_000,
        maxQueryLimit: 20,
        maxRowsPerPage: 20,
        // This wrapper starts the genuine default browser fetch without
        // proxying, routing or rewriting it, awaits the real cross-origin
        // response and then aborts the caller signal. It proves request
        // acknowledgement and canonical cancellation; it makes no claim about
        // body receipt or buffered verification.
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await globalThis.fetch(input, init);
          acknowledgement.status = response.status;
          acknowledgement.contentType = response.headers.get("content-type") ?? "";
          controller.abort();
          return response;
        },
      });
      try {
        await db.searchWithSignal({
          q: "Neuromancer",
          queryBy: ["title", "author"],
          filterBy: "genre:=`cyberpunk`",
          limit: 1,
        }, controller.signal);
        return { resolved: true, name: undefined, reason: undefined, acknowledgement, origin: globalThis.location.origin, endpoint: browserConfig.url };
      } catch (error) {
        const failure = error as { name?: string; reason?: string };
        return { resolved: false, name: failure.name, reason: failure.reason, acknowledgement, origin: globalThis.location.origin, endpoint: browserConfig.url };
      } finally {
        db.close();
      }
    }, config());

    expect(pageErrors).toEqual([]);
    // Chromium's default fetch reached the separately-originated provider and
    // exposed its response headers through CORS before the caller aborted.
    expect(outcome.origin).not.toBe(new URL(outcome.endpoint).origin);
    expect(outcome.resolved).toBe(false);
    expect(outcome.name).toBe("QueryCancelledError");
    expect(outcome.reason).toBe("caller");
    expect(outcome.acknowledgement.status).toBe(200);
    expect(outcome.acknowledgement.contentType).toContain("application/json");
  });
});

test.describe("real Chromium verifier cadence", () => {
  test("a timer armed before verification can fire only once the real verifier yields a macrotask", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => { pageErrors.push(error.message); });
    await page.goto("/verifier.html");
    await page.waitForFunction(() => (globalThis as unknown as { TypesenseVerifier?: unknown }).TypesenseVerifier !== undefined);

    const outcome = await page.evaluate(async () => {
      const { createVerifier, predicateRoot } = (globalThis as unknown as { TypesenseVerifier: BrowserVerifierModule }).TypesenseVerifier;
      // A real admitted AST built through the production admission path: an OR
      // of 40 false exact comparisons stays inside the 64-condition bound.
      const conditions: Record<string, unknown>[] = [];
      for (let index = 1; index <= 40; index += 1) {
        conditions.push({
          left: { kind: "field", field: { field: "rank", source: "" } },
          operator: "==",
          right: { kind: "literal", value: -index },
        });
      }
      const node = predicateRoot({
        source: { kind: "collection", name: "books" },
        filters: [],
        orders: [],
        where: { kind: "or", conditions },
      }, { maxFilterBytes: 8_192 });
      const verifier = createVerifier(node);
      let reads = 0;
      const data = new Proxy<Record<string, unknown>>({ rank: 0 }, {
        getOwnPropertyDescriptor(target, property) {
          reads += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      });

      // The timer is armed in the same synchronous task that starts the real
      // verification, so it cannot fire before verification has begun. A
      // verifier that only chained microtasks would finish without ever letting
      // this macrotask run.
      let timerFired = false;
      let readsWhenTimerFired = -1;
      setTimeout(() => {
        timerFired = true;
        readsWhenTimerFired = reads;
      }, 0);

      const cancellation = new Error("verifier-timer-fired");
      let completed = false;
      let failure: string | undefined;
      try {
        await verifier(data, () => {
          if (timerFired) throw cancellation;
        });
        completed = true;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      return { completed, timerFired, failure, readsWhenTimerFired, reads };
    });

    expect(pageErrors).toEqual([]);
    expect(outcome.timerFired).toBe(true);
    expect(outcome.completed).toBe(false);
    expect(outcome.failure).toBe("verifier-timer-fired");
    // The timer fired while real verification work was in progress: at least
    // one leaf had been read, and the verifier did not reach its 40th leaf.
    expect(outcome.readsWhenTimerFired).toBeGreaterThan(0);
    expect(outcome.readsWhenTimerFired).toBeLessThan(40);
  });
});
