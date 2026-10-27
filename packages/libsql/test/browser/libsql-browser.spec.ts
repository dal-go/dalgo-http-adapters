import { expect, test, type Page } from "@playwright/test";

interface AttemptError {
  readonly name: string;
  readonly status?: number;
  readonly message: string;
}

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

interface Harness {
  origin(): string;
  read(token: string): Promise<ReadResult>;
  badCredential(token: string): Promise<{
    query: AttemptError;
    connection: { ok: boolean; status: string; httpStatus?: number };
  }>;
  readerWriteProbe(token: string): Promise<{ status: number; leakedToken: boolean }>;
  adapterMutationRefused(token: string): Promise<{ error: AttemptError; requests: number }>;
  cancelled(token: string): Promise<AttemptError>;
}

declare global {
  var harness: Harness;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required; run pnpm test:browser`);
  return value;
}

const libsqlUrl = required("LIBSQL_BROWSER_URL");
const token = required("LIBSQL_BROWSER_READER_TOKEN");
const expectedOrigin = new URL(libsqlUrl).origin;
const pageUrl = `/?libsql=${encodeURIComponent(libsqlUrl)}`;

async function load(page: Page): Promise<void> {
  await page.goto(pageUrl);
  await page.waitForFunction(() => typeof globalThis.harness === "object");
}

test.describe("real Chromium -> real libSQL server", () => {
  test("reads native tables across a genuine cross-origin fetch with its own auth header", async ({ page }) => {
    await load(page);
    const result = await page.evaluate((reader) => globalThis.harness.read(reader), token);

    expect(result.serverOrigin).toBe(expectedOrigin);
    expect(result.origin).not.toBe(result.serverOrigin);
    expect(result.discovery).toMatchObject({
      status: "available",
      tableCount: 8,
      items: {
        adapterQueryable: true,
        uniqueStatus: "declared-primary-key",
        primaryKey: ["id"],
      },
    });
    expect(result.connection).toMatchObject({ ok: true, status: "connected", tableCount: 8 });

    expect(result.recordsPerPage).toEqual([5, 5, 2, 0]);
    expect(result.pages).toBe(4);
    expect(result.shortPageHadCursor).toBe(true);
    expect(result.emptyPageHadCursor).toBe(false);
    expect(result.rows.map((row) => row.id)).toEqual([4, 8, 3, 6, 10, 1, 2, 7, 11, 5, 9, 12]);
    expect(new Set(result.rows.map((row) => row.id)).size).toBe(12);
    for (const row of result.rows) {
      expect(typeof row.done).toBe("number");
      expect(row.rank === null || typeof row.rank === "number").toBe(true);
      expect(row.score === null || typeof row.score === "number").toBe(true);
    }
    expect(result.rows.find((row) => row.id === 4)?.rank).toBeNull();
    expect(result.rows.find((row) => row.id === 1)?.rank).toBe(2);
    expect(result.labelId).toBe("a1");
    expect(result.metricId).toBe(0.1);

    // describe() = metadata list + per-table metadata = 2 requests; four
    // native pages, then two point reads. The managed adapter adds four pages.
    expect(result.requests).toBe(8);
    expect(result.managed.pages).toBe(4);
    expect(result.managed.requests).toBe(4);
    expect(new Set(result.managed.ids).size).toBe(12);
    expect(result.managed.ids).toHaveLength(12);
  });

  test("proves the reader JWT cannot write through the real service", async ({ page }) => {
    await load(page);
    const probe = await page.evaluate((reader) => globalThis.harness.readerWriteProbe(reader), token);
    expect(probe.status).toBe(403);
    expect(probe.leakedToken).toBe(false);
  });

  test("keeps adapter mutation refusal separate and before any request", async ({ page }) => {
    await load(page);
    const result = await page.evaluate((reader) => globalThis.harness.adapterMutationRefused(reader), token);
    expect(result.error.name).toBe("UnsupportedError");
    expect(result.error.message).toContain("read-only: insert");
    expect(result.requests).toBe(0);
  });

  test("reports a bad JWT as a redacted status rather than a leaked token or body", async ({ page }) => {
    await load(page);
    const result = await page.evaluate(() => globalThis.harness.badCredential("bad.token.value"));
    expect(result.query).toMatchObject({ name: "LibSQLHttpError", status: 401 });
    expect(result.query.message).toBe("libSQL pipeline request failed with HTTP 401");
    expect(result.query.message).not.toContain("bad.token.value");
    expect(result.connection).toMatchObject({ ok: false, status: "unauthorized", httpStatus: 401 });
  });

  test("honours the caller abort in Chromium without a request", async ({ page }) => {
    await load(page);
    const error = await page.evaluate((reader) => globalThis.harness.cancelled(reader), token);
    expect(error.name).toBe("QueryCancelledError");
    expect(error.message).toContain("cancelled");
  });
});
