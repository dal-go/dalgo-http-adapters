import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import type { CanonicalPin, DemoDbProgressEvent, OpenReport } from "../../src/opfs/index.js";
import type { OpenOptions } from "./fixtures/page.js";

interface Harness {
  crossOriginIsolated(): boolean;
  wipe(): Promise<void>;
  pins(): Promise<Record<"chinook" | "chinookV2" | "chinookParts", CanonicalPin>>;
  open(pin: CanonicalPin, options?: OpenOptions): Promise<OpenReport>;
  openError(pin: CanonicalPin, options?: OpenOptions): Promise<unknown>;
  portCalls(payloads: readonly unknown[]): Promise<{ readonly results: unknown[]; readonly disposed: boolean }>;
  progress(): DemoDbProgressEvent[];
  requests(): Promise<Record<string, number>>;
  role(): string;
  report(): OpenReport | undefined;
  events(): string[];
  logs(): string[];
  request(payload: unknown): Promise<unknown>;
  requestRetrying(payload: unknown): Promise<unknown>;
  portRequest(payload: unknown): Promise<unknown>;
  stuckPool(pin: CanonicalPin, memoryWhenLocked: boolean): Promise<unknown>;
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

// Each test gets a fresh browser context. Chromium and Firefox get an
// ephemeral one, which has its own empty OPFS. WebKit refuses OPFS in
// ephemeral contexts (see the "ephemeral context" test below), so it gets a
// fresh persistent profile; Playwright's WebKit keeps OPFS data outside the
// profile directory, so those tests also start and end by wiping the
// origin's OPFS. (Persistent Firefox and WebKit contexts cannot open new
// pages on Linux CI runners, which is why the others stay ephemeral.)
const test = base.extend({
  context: async ({ browser, browserName, playwright, baseURL }, use, testInfo) => {
    const options = baseURL === undefined ? {} : { baseURL };
    if (browserName !== "webkit") {
      const context = await browser.newContext(options);
      await use(context);
      await context.close();
      return;
    }
    const context = await playwright.webkit.launchPersistentContext(testInfo.outputPath("profile"), options);
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

function open(page: Page, pin: CanonicalPin, noOpfs = false, options: OpenOptions = {}): Promise<OpenReport> {
  return page.evaluate(([p, o]) => harness.open(p, o), [pin, { ...options, noOpfs }] as const);
}

async function downloads(page: Page, path: string): Promise<number> {
  return (await page.evaluate(() => harness.requests()))[path] ?? 0;
}

/** The phases in order, each run of the same phase counted once. */
function phases(events: readonly DemoDbProgressEvent[]): string[] {
  return events.map((event) => event.phase).filter((phase, index, all) => index === 0 || all[index - 1] !== phase);
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

test("reset works after the working copy grew past the pristine size, and again later", async ({ page }) => {
  const pins = await load(page);
  await open(page, pins.chinook);
  await request(page, rename(1, "x".repeat(2_000_000)));
  expect(await page.evaluate(() => harness.reset())).toEqual({ canonical: { sha256: pins.chinook.sha256 } });
  expect(await request(page, artist(1))).toEqual({ ArtistId: 1, Name: "AC/DC" });
  await request(page, rename(2, "y".repeat(3_000_000)));
  expect(await page.evaluate(() => harness.reset())).toEqual({ canonical: { sha256: pins.chinook.sha256 } });
  expect(await request(page, artist(2))).toEqual({ ArtistId: 2, Name: "Accept" });
  await page.reload();
  await page.waitForFunction(() => typeof globalThis.harness === "object");
  expect(await open(page, pins.chinook)).toMatchObject({ imported: false, persistent: true });
  expect(await request(page, artist(1))).toEqual({ ArtistId: 1, Name: "AC/DC" });
  expect(await page.evaluate(() => harness.reset())).toEqual({ canonical: { sha256: pins.chinook.sha256 } });
});

test("a pool that stays locked fails as retriable instead of dropping edits to memory", async ({ page }) => {
  const pins = await load(page);
  expect(await page.evaluate((pin) => harness.stuckPool(pin, false), pins.chinook)).toEqual({ error: "PoolUnavailableError", reason: "locked", retriable: true });
  expect(await page.evaluate((pin) => harness.stuckPool(pin, true), pins.chinook)).toMatchObject({ persistent: false, fallback: { kind: "memory", reason: "locked" } });
});

test("two tabs opening at the same moment keep the stored edits", async ({ context }) => {
  const writer = await context.newPage();
  const pins = await load(writer);
  await open(writer, pins.chinook);
  await request(writer, rename(9, "written before"));
  await writer.close();
  const first = await context.newPage();
  const second = await context.newPage();
  await load(first);
  await load(second);
  const reports = await Promise.all([open(first, pins.chinook), open(second, pins.chinook)]);
  expect(reports.map((report) => report.persistent)).toEqual([true, true]);
  expect(reports.map((report) => report.imported)).toEqual([false, false]);
  expect((await Promise.all([first, second].map((page) => page.evaluate(() => harness.role())))).sort()).toEqual(["follower", "leader"]);
  expect(await request(first, artist(9))).toEqual({ ArtistId: 9, Name: "written before" });
  expect(await request(second, artist(9))).toEqual({ ArtistId: 9, Name: "written before" });
});

test("a follower makes many sequential requests over one port without the port closing itself", async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  const pins = await load(first);
  await load(second);
  await open(first, pins.chinook);
  await open(second, pins.chinook);
  expect(await second.evaluate(() => harness.role())).toBe("follower");
  const payloads = Array.from({ length: 30 }, (_, index) => artist(index + 1));
  const follower = await second.evaluate((p) => harness.portCalls(p), payloads);
  expect(follower.disposed).toBe(false);
  expect(follower.results).toHaveLength(30);
  expect(follower.results[0]).toEqual({ ArtistId: 1, Name: "AC/DC" });
  expect(follower.results[29]).toMatchObject({ ArtistId: 30 });
  const leader = await first.evaluate((p) => harness.portCalls(p), payloads.slice(0, 5));
  expect(leader).toMatchObject({ disposed: false });
  expect(leader.results).toHaveLength(5);
});

test("progress phases arrive in order, and the download is counted against the pin", async ({ page }) => {
  const pins = await load(page);
  await open(page, pins.chinook);
  const events = await page.evaluate(() => harness.progress());
  test.info().annotations.push({ type: "progress events", description: String(events.length) });
  expect(phases(events)).toEqual(["fetch", "verify", "importPristine", "importWorking", "open"]);
  const fetches = events.filter((event) => event.phase === "fetch");
  expect(fetches[0]).toEqual({ phase: "fetch", loaded: 0, total: pins.chinook.bytes });
  expect(fetches.at(-1)).toEqual({ phase: "fetch", loaded: pins.chinook.bytes, total: pins.chinook.bytes });
  const loaded = fetches.map((event) => event.loaded ?? 0);
  expect(loaded).toEqual([...loaded].sort((a, b) => a - b));
  await page.reload();
  await page.waitForFunction(() => typeof globalThis.harness === "object");
  await open(page, pins.chinook);
  expect(phases(await page.evaluate(() => harness.progress()))).toEqual(["open"]);
});

test("single-copy storage: reset downloads and verifies the pin again", async ({ page }) => {
  const pins = await load(page);
  const path = "/data/chinook.sqlite";
  const before = await downloads(page, path);
  expect(await open(page, pins.chinook, false, { storagePolicy: "single-copy" })).toMatchObject({ persistent: true, imported: true });
  expect(phases(await page.evaluate(() => harness.progress()))).toEqual(["fetch", "verify", "importWorking", "open"]);
  expect(await downloads(page, path)).toBe(before + 1);
  await request(page, rename(1, "x".repeat(2_000_000)));
  expect(await page.evaluate(() => harness.reset())).toEqual({ canonical: { sha256: pins.chinook.sha256 } });
  expect(await downloads(page, path)).toBe(before + 2);
  expect(await request(page, artist(1))).toEqual({ ArtistId: 1, Name: "AC/DC" });
  await request(page, rename(2, "kept"));
  await page.reload();
  await page.waitForFunction(() => typeof globalThis.harness === "object");
  expect(await open(page, pins.chinook, false, { storagePolicy: "single-copy" })).toMatchObject({ imported: false, persistent: true });
  expect(await request(page, artist(2))).toEqual({ ArtistId: 2, Name: "kept" });
  expect(await downloads(page, path)).toBe(before + 2);
});

test("memoryFallback: forbid fails with the typed OPFS error before downloading", async ({ page }) => {
  const pins = await load(page);
  const path = "/data/chinook.sqlite";
  const before = await downloads(page, path);
  const result = await page.evaluate((pin) => harness.openError(pin, { noOpfs: true, memoryFallback: "forbid" }), pins.chinook);
  expect(result).toEqual({ name: "PoolUnavailableError", reason: "missing-api", code: "opfs_unavailable", role: "failed" });
  expect(await downloads(page, path)).toBe(before);
});
