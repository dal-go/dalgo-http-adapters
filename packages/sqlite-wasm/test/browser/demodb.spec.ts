import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import type { CanonicalPin, OpenReport } from "../../src/opfs/index.js";

interface Harness {
  crossOriginIsolated(): boolean;
  wipe(): Promise<void>;
  pins(): Promise<Record<"chinook" | "chinookV2" | "chinookParts", CanonicalPin>>;
  open(pin: CanonicalPin, options?: { readonly noOpfs?: boolean }): Promise<OpenReport>;
  role(): string;
  report(): OpenReport | undefined;
  events(): string[];
  logs(): string[];
  request(payload: unknown): Promise<unknown>;
  requestRetrying(payload: unknown): Promise<unknown>;
  portRequest(payload: unknown): Promise<unknown>;
  lockedPool(pin: CanonicalPin, holdMs: number): Promise<{ readonly report: OpenReport; readonly name: unknown; readonly waitedMs: number }>;
  reset(): Promise<unknown>;
  persistence(): Promise<string | undefined>;
  close(): void;
}

declare global {
  var harness: Harness;
}

type Pins = Awaited<ReturnType<Harness["pins"]>>;

async function wipe(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await page.goto("/");
  await page.waitForFunction(() => typeof globalThis.harness === "object");
  await page.evaluate(() => harness.wipe());
  await page.close();
}

// Each test gets a fresh persistent profile, like a normal browser window.
// WebKit refuses OPFS in Playwright's default ephemeral contexts (see the
// "ephemeral context" test below). Playwright's WebKit keeps OPFS data
// outside the profile directory, so every test also starts and ends by
// wiping the origin's OPFS.
const test = base.extend({
  context: async ({ browserName, playwright, baseURL }, use, testInfo) => {
    const context = await playwright[browserName].launchPersistentContext(testInfo.outputPath("profile"), baseURL === undefined ? {} : { baseURL });
    await wipe(context);
    await use(context);
    for (const page of context.pages()) await page.close();
    await wipe(context);
    await context.close();
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? await context.newPage());
  },
});

async function load(page: Page): Promise<Pins> {
  await page.goto("/");
  await page.waitForFunction(() => typeof globalThis.harness === "object");
  return page.evaluate(() => harness.pins());
}

function open(page: Page, pin: CanonicalPin, noOpfs = false): Promise<OpenReport> {
  return page.evaluate(([p, n]) => harness.open(p, { noOpfs: n }), [pin, noOpfs] as const);
}

function request(page: Page, payload: unknown, retrying = false): Promise<unknown> {
  return page.evaluate(([p, r]) => (r ? harness.requestRetrying(p) : harness.request(p)), [payload, retrying] as const);
}

const artist = (id: number) => ({ op: "get", table: "Artist", id });
const rename = (id: number, name: string) => ({ op: "update", table: "Artist", id, data: { Name: name } });

test("an ephemeral (private-like) context: OPFS where the browser allows it, memory otherwise", async ({ browser, browserName, baseURL }) => {
  const context: BrowserContext = await browser.newContext(baseURL === undefined ? {} : { baseURL });
  const page = await context.newPage();
  const pins = await load(page);
  const report = await open(page, pins.chinook);
  if (browserName === "webkit") {
    // WebKit rejects navigator.storage.getDirectory() with UnknownError here.
    expect(report).toMatchObject({ persistent: false, fallback: { kind: "memory", reason: "other" } });
  } else {
    expect(report).toMatchObject({ persistent: true });
  }
  expect(await request(page, { op: "count", table: "Artist" })).toBe(275);
  await context.close();
});

test("opens Chinook from OPFS without cross-origin isolation", async ({ page }) => {
  const pins = await load(page);
  expect(await page.evaluate(() => harness.crossOriginIsolated())).toBe(false);
  const report = await open(page, pins.chinook);
  expect(report).toEqual({
    dataset: "chinook", canonical: { sha256: pins.chinook.sha256 }, persistent: true, replacedPreviousVersion: false, imported: true,
  });
  expect(await page.evaluate(() => harness.role())).toBe("leader");
  expect(await request(page, { op: "count", table: "Artist" })).toBe(275);
});

test("an edit survives a reload", async ({ page }) => {
  const pins = await load(page);
  await open(page, pins.chinook);
  await request(page, rename(1, "AC/DC (edited)"));
  const persistence = await page.evaluate(() => harness.persistence());
  expect(["granted", "denied", "pending"]).toContain(persistence);
  test.info().annotations.push({ type: "navigator.storage.persist()", description: String(persistence) });
  await page.reload();
  await page.waitForFunction(() => typeof globalThis.harness === "object");
  const report = await open(page, pins.chinook);
  expect(report.imported).toBe(false);
  expect(await request(page, artist(1))).toEqual({ ArtistId: 1, Name: "AC/DC (edited)" });
  await request(page, rename(1, "AC/DC (edited twice)"));
  await page.reload();
  await page.waitForFunction(() => typeof globalThis.harness === "object");
  await open(page, pins.chinook);
  expect(await request(page, artist(1))).toEqual({ ArtistId: 1, Name: "AC/DC (edited twice)" });
});

test("a delete survives a reload", async ({ page }) => {
  const pins = await load(page);
  await open(page, pins.chinook);
  await request(page, { op: "delete", table: "Artist", id: 25 });
  await page.reload();
  await page.waitForFunction(() => typeof globalThis.harness === "object");
  await open(page, pins.chinook);
  expect(await request(page, artist(25))).toBeNull();
  expect(await request(page, { op: "count", table: "Artist" })).toBe(274);
});

test("reset restores the pristine file, and it stays restored", async ({ page }) => {
  const pins = await load(page);
  await open(page, pins.chinook);
  await request(page, rename(1, "edited"));
  await request(page, { op: "delete", table: "Artist", id: 25 });
  expect(await page.evaluate(() => harness.reset())).toEqual({ canonical: { sha256: pins.chinook.sha256 } });
  expect(await request(page, artist(1))).toEqual({ ArtistId: 1, Name: "AC/DC" });
  expect(await request(page, { op: "count", table: "Artist" })).toBe(275);
  await page.reload();
  await page.waitForFunction(() => typeof globalThis.harness === "object");
  await open(page, pins.chinook);
  expect(await request(page, artist(1))).toEqual({ ArtistId: 1, Name: "AC/DC" });
});

test("a changed pin replaces the old version and its edits", async ({ page }) => {
  const pins = await load(page);
  await open(page, pins.chinook);
  await request(page, rename(2, "edited in v1"));
  await page.reload();
  await page.waitForFunction(() => typeof globalThis.harness === "object");
  const report = await open(page, pins.chinookV2);
  expect(report).toMatchObject({ canonical: { sha256: pins.chinookV2.sha256 }, replacedPreviousVersion: true, imported: true, persistent: true });
  expect(await request(page, artist(1))).toEqual({ ArtistId: 1, Name: "AC/DC (v2)" });
  expect(await request(page, artist(2))).toEqual({ ArtistId: 2, Name: "Accept" });
  await page.reload();
  await page.waitForFunction(() => typeof globalThis.harness === "object");
  expect(await open(page, pins.chinookV2)).toMatchObject({ replacedPreviousVersion: false, imported: false });
});

test("a gzip file served in parts is verified and opened", async ({ page }) => {
  const pins = await load(page);
  expect(await open(page, pins.chinookParts)).toMatchObject({ persistent: true, imported: true });
  expect(await request(page, { op: "count", table: "Track" })).toBe(3503);
});

test("without OPFS the dataset runs in memory and says so", async ({ page }) => {
  const pins = await load(page);
  const report = await open(page, pins.chinook, true);
  expect(report).toMatchObject({ persistent: false, fallback: { kind: "memory", reason: "missing-api" } });
  await request(page, rename(1, "in memory"));
  expect(await request(page, artist(1))).toEqual({ ArtistId: 1, Name: "in memory" });
  expect(await page.evaluate(() => harness.reset())).toEqual({ canonical: { sha256: pins.chinook.sha256 } });
  expect(await request(page, artist(1))).toEqual({ ArtistId: 1, Name: "AC/DC" });
  await request(page, rename(1, "in memory again"));
  await page.reload();
  await page.waitForFunction(() => typeof globalThis.harness === "object");
  await open(page, pins.chinook, true);
  expect(await request(page, artist(1))).toEqual({ ArtistId: 1, Name: "AC/DC" });
});

test("two tabs read and write through one leader", async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  const pins = await load(first);
  await load(second);
  await open(first, pins.chinook);
  const followerReport = await open(second, pins.chinook);
  expect(followerReport.canonical.sha256).toBe(pins.chinook.sha256);
  expect(await first.evaluate(() => harness.role())).toBe("leader");
  expect(await second.evaluate(() => harness.role())).toBe("follower");
  await Promise.all([
    request(first, rename(3, "from the leader")),
    request(second, rename(4, "from the follower")),
  ]);
  expect(await request(second, artist(3))).toEqual({ ArtistId: 3, Name: "from the leader" });
  expect(await request(first, artist(4))).toEqual({ ArtistId: 4, Name: "from the follower" });
  expect(await second.evaluate((payload) => harness.portRequest(payload), artist(4))).toEqual({ ArtistId: 4, Name: "from the follower" });
  expect(await first.evaluate((payload) => harness.portRequest(payload), artist(3))).toEqual({ ArtistId: 3, Name: "from the leader" });
});

test("when the leader tab closes another tab takes over without losing writes", async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  const pins = await load(first);
  await load(second);
  await open(first, pins.chinook);
  await open(second, pins.chinook);
  await request(second, rename(5, "written via the first leader"));
  await first.close();
  expect(await request(second, artist(5), true)).toEqual({ ArtistId: 5, Name: "written via the first leader" });
  await expect.poll(() => second.evaluate(() => harness.role())).toBe("leader");
  await request(second, rename(6, "written by the new leader"), true);
  const third = await context.newPage();
  await load(third);
  await open(third, pins.chinook);
  expect(await third.evaluate(() => harness.role())).toBe("follower");
  expect(await request(third, artist(6))).toEqual({ ArtistId: 6, Name: "written by the new leader" });
});

test("fast reloads do not wedge on stale OPFS locks", async ({ page }) => {
  const pins = await load(page);
  await open(page, pins.chinook);
  await request(page, rename(7, "before reloads"));
  await page.reload();
  await page.waitForFunction(() => typeof globalThis.harness === "object");
  for (let round = 0; round < 6; round += 1) {
    // Reload right after an open, or in the middle of one, while the previous
    // worker still holds its sync access handles.
    if (round % 2 === 0) await open(page, pins.chinook);
    else void page.evaluate((pin) => harness.open(pin), pins.chinook).catch(() => undefined);
    await page.reload();
    await page.waitForFunction(() => typeof globalThis.harness === "object");
  }
  await open(page, pins.chinook);
  expect(await request(page, artist(7))).toEqual({ ArtistId: 7, Name: "before reloads" });
  // Evidence only: whether a reload met a still-locked pool depends on timing.
  test.info().annotations.push({ type: "pool retries during the reloads", description: JSON.stringify(await page.evaluate(() => harness.logs())) });
});

test("a pool still locked by a terminating worker is waited for, not wiped", async ({ page }) => {
  const pins = await load(page);
  const result = await page.evaluate((pin) => harness.lockedPool(pin, 500), pins.chinook);
  test.info().annotations.push({ type: "second open", description: JSON.stringify(result) });
  expect(result.report).toMatchObject({ persistent: true, imported: false });
  expect(result.name).toBe("held");
  expect(result.waitedMs).toBeGreaterThanOrEqual(400);
  const logs = await page.evaluate(() => harness.logs());
  expect(logs.length).toBeGreaterThan(0);
  expect(logs.every((line) => line.includes(": locked ("))).toBe(true);
  test.info().annotations.push({ type: "pool retries", description: JSON.stringify(logs) });
});
