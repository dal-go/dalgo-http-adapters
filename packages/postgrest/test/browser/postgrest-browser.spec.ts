import { expect, test, type Page } from "@playwright/test";

// Run through scripts/real-postgrest-browser.mjs, which starts a disposable
// PostgREST service whose exact CORS origin is this static page's origin.
interface PostgrestError {
  readonly name: string;
  readonly status?: number;
  readonly message: string;
}

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
  readonly query: PostgrestError;
  readonly connection: { readonly ok: boolean; readonly status: string; readonly httpStatus?: number };
}

interface Harness {
  origin(): string;
  allowed(token: string): Promise<AllowedResult>;
  attempt(token: string): Promise<{ readonly ok: true; readonly value: AllowedResult } | { readonly ok: false; readonly error: PostgrestError }>;
  badCredential(token: string): Promise<BadCredentialResult>;
  cancelled(token: string): Promise<PostgrestError>;
}

declare global {
  var harness: Harness;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required; run pnpm test:browser`);
  return value;
}

const postgrestUrl = required("POSTGREST_BROWSER_URL");
const allowedOrigin = required("POSTGREST_BROWSER_ALLOWED_ORIGIN");
const jwt = required("POSTGREST_BROWSER_JWT");
const staticPort = required("PORT");
const pageUrl = `/?postgrest=${encodeURIComponent(postgrestUrl)}`;

async function load(page: Page, url = pageUrl): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => typeof globalThis.harness === "object");
}

test.describe("real Chromium -> real PostgREST", () => {
  test("allows the exact fixture origin and reads native rows across short pages", async ({ page }) => {
    await load(page);
    expect(await page.evaluate(() => globalThis.harness.origin())).toBe(allowedOrigin);

    const result = await page.evaluate((token) => globalThis.harness.allowed(token), jwt);

    expect(result.origin).toBe(allowedOrigin);
    expect(result.discovery).toMatchObject({
      status: "available",
      relationCount: 2,
    });
    const items = result.discovery.relations.find((relation) => relation.name === "items");
    expect(items).toMatchObject({
      readable: true,
      fieldsStatus: "declared",
      primaryKey: { status: "declared", columns: ["id"] },
      idColumn: { name: "id", present: true, declaredPrimaryKey: true, uniqueStatus: "declared-primary-key" },
      adapterQueryable: true,
    });
    expect(result.connection).toMatchObject({ ok: true, status: "connected", schema: "api" });

    // The fixture caps responses at two rows; the requested page size is five.
    expect(result.recordsPerPage).toEqual([2, 2, 2, 1, 0]);
    expect(result.nonEmptyPages).toBe(4);
    expect(result.pages).toBe(5);
    expect(result.cursorOnEmptyPage).toBe(false);
    expect(result.requests).toBe(7); // two metadata reads plus five page reads
    expect(result.rows.map((row) => row.id)).toEqual(["i3", "i6", "i1", "i4", "i7", "i2", "i5"]);
    expect(new Set(result.rows.map((row) => row.id)).size).toBe(7);
    for (const row of result.rows) {
      expect(typeof row.priority).toBe("number");
      expect(typeof row.done).toBe("boolean");
      expect(row.score === null || typeof row.score === "number").toBe(true);
      expect(row.tags === null || Array.isArray(row.tags)).toBe(true);
    }
  });

  test("reports a bad credential as a redacted HTTP status, not a CORS or body leak", async ({ page }) => {
    await load(page);
    const result = await page.evaluate(() => globalThis.harness.badCredential("bad.token.value"));

    expect(result.query).toMatchObject({ name: "PostgrestHttpError", status: 401 });
    expect(result.query.message).toBe("PostgREST request failed with HTTP 401");
    expect(result.query.message).not.toMatch(/row|detail|permission/iu);
    expect(result.connection).toMatchObject({ ok: false, status: "unauthorized", httpStatus: 401 });
  });

  test("refuses a genuinely different browser origin through real CORS", async ({ page }) => {
    // `localhost` is a different origin from `127.0.0.1` even on the same
    // port, and the fixture allows only the latter.
    const disallowedOrigin = `http://localhost:${staticPort}`;
    expect(disallowedOrigin).not.toBe(allowedOrigin);
    await load(page, `${disallowedOrigin}${pageUrl}`);
    expect(await page.evaluate(() => globalThis.harness.origin())).toBe(disallowedOrigin);

    const result = await page.evaluate((token) => globalThis.harness.attempt(token), jwt);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a disallowed browser origin must not read PostgREST");
    // The browser blocks the cross-origin response before a status is exposed.
    expect(result.error.name).toBe("PostgrestRequestError");
    expect(result.error.message).toBe("PostgREST request could not be completed");
  });

  test("honours the caller abort in the browser without a request", async ({ page }) => {
    await load(page);
    const error = await page.evaluate((token) => globalThis.harness.cancelled(token), jwt);
    expect(error.name).toBe("QueryCancelledError");
    expect(error.message).toContain("cancelled");
  });
});
