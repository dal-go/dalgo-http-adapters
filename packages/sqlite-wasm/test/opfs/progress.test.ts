import { describe, expect, it, vi } from "vitest";
import { canonicalPath, fetchCanonical, workingPath, type CanonicalPin } from "../../src/opfs/canonical.js";
import { WorkerClient, openLeaderDatabase } from "../../src/opfs/client.js";
import { DemoDbEngine, type EngineOptions, type Sqlite3Like } from "../../src/opfs/engine.js";
import { throttleProgress, type DemoDbProgressEvent, type DemoDbProgressPhase } from "../../src/opfs/progress.js";
import { FakePool, InProcessWorker, emptyDirectory, gzip, pinFor, sampleBytes, serve, sha256, sqliteLike } from "./helpers.js";

const sample = sampleBytes();
const pin = pinFor(sample);

/** A response whose body arrives in `count` chunks. */
function chunked(bytes: Uint8Array, count: number, headers?: HeadersInit): Response {
  const size = Math.ceil(bytes.length / count);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(bytes.slice(offset, offset + size));
      controller.close();
    },
  }), headers === undefined ? {} : { headers });
}

function record(): { readonly events: DemoDbProgressEvent[]; readonly report: (event: DemoDbProgressEvent) => void } {
  const events: DemoDbProgressEvent[] = [];
  return { events, report: (event) => { events.push(event); } };
}

/** The phases in order, each run of the same phase counted once. */
function phases(events: readonly DemoDbProgressEvent[]): DemoDbProgressPhase[] {
  return events.map((event) => event.phase).filter((phase, index, all) => index === 0 || all[index - 1] !== phase);
}

describe("throttleProgress", () => {
  it("passes phase changes and forced events, and at most one event per interval within a phase", () => {
    let now = 1000;
    const { events, report } = record();
    const throttled = throttleProgress(report, { intervalMs: 100, now: () => now });
    throttled({ phase: "fetch", loaded: 0 });
    now += 50;
    throttled({ phase: "fetch", loaded: 1 });
    now += 50;
    throttled({ phase: "fetch", loaded: 2 });
    now += 10;
    throttled({ phase: "fetch", loaded: 3 });
    throttled({ phase: "fetch", loaded: 4 }, true);
    throttled({ phase: "verify" });
    throttled({ phase: "importPristine", total: 9 });
    throttled({ phase: "importPristine", total: 9 });
    expect(events).toEqual([
      { phase: "fetch", loaded: 0 }, { phase: "fetch", loaded: 2 }, { phase: "fetch", loaded: 4 }, { phase: "verify" }, { phase: "importPristine", total: 9 },
    ]);
  });

  it("ignores a listener that throws, and uses Date.now and 100 ms by default", () => {
    const listener = vi.fn(() => { throw new Error("listener bug"); });
    const throttled = throttleProgress(listener);
    expect(() => { throttled({ phase: "open" }); }).not.toThrow();
    throttled({ phase: "open" });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("fetchCanonical progress", () => {
  it("counts the body against the pin's size for an uncompressed file", async () => {
    const { events, report } = record();
    expect(await fetchCanonical(pin, () => Promise.resolve(chunked(sample, 4)), report)).toEqual(sample);
    expect(events[0]).toEqual({ phase: "fetch", loaded: 0, total: pin.bytes });
    expect(events.at(-2)).toEqual({ phase: "fetch", loaded: pin.bytes, total: pin.bytes });
    expect(events.at(-1)).toEqual({ phase: "verify" });
    const loaded = events.filter((event) => event.phase === "fetch").map((event) => event.loaded ?? -1);
    expect(loaded.length).toBeGreaterThanOrEqual(6);
    expect(loaded).toEqual([...loaded].sort((a, b) => a - b));
  });

  it("counts every part against the parts' total", async () => {
    const compressed = gzip(sample);
    const half = Math.ceil(compressed.length / 2);
    const parts = [compressed.slice(0, half), compressed.slice(half)];
    const parted: CanonicalPin = {
      ...pin, url: "https://demo.test/data/", compression: "gzip",
      parts: parts.map((part, index) => ({ url: `p${String(index)}`, sha256: sha256(part), bytes: part.length })),
    };
    const { events, report } = record();
    const fetchFn = (url: string): Promise<Response> => Promise.resolve(chunked(parts[url.endsWith("p0") ? 0 : 1] ?? new Uint8Array(), 2));
    expect(await fetchCanonical(parted, fetchFn, report)).toEqual(sample);
    expect(events.at(-2)).toEqual({ phase: "fetch", loaded: compressed.length, total: compressed.length });
    expect(phases(events)).toEqual(["fetch", "verify"]);
  });

  it("uses Content-Length for a single gzip file only when it is the body's length", async () => {
    const compressed = gzip(sample);
    const gz: CanonicalPin = { ...pin, compression: "gzip" };
    const run = async (headers: HeadersInit | undefined): Promise<DemoDbProgressEvent[]> => {
      const { events, report } = record();
      await fetchCanonical(gz, () => Promise.resolve(chunked(compressed, 3, headers)), report);
      return events.filter((event) => event.phase === "fetch");
    };
    const exact = await run({ "content-length": String(compressed.length) });
    expect(exact[0]).toEqual({ phase: "fetch", loaded: 0 });
    expect(exact.at(-1)).toEqual({ phase: "fetch", loaded: compressed.length, total: compressed.length });
    expect((await run({ "content-length": String(compressed.length), "content-encoding": "br" })).at(-1)).toEqual({ phase: "fetch", loaded: compressed.length });
    expect((await run(undefined)).at(-1)).toEqual({ phase: "fetch", loaded: compressed.length });
    expect((await run({ "content-length": "nonsense" })).at(-1)).toEqual({ phase: "fetch", loaded: compressed.length });
    // A Content-Length smaller than the body (e.g. a hidden Content-Encoding on a cross-origin response) is dropped.
    expect((await run({ "content-length": "10" })).at(-1)).toEqual({ phase: "fetch", loaded: compressed.length });
  });

  it("reads a body-less response as empty", async () => {
    const { events, report } = record();
    await expect(fetchCanonical(pin, () => Promise.resolve(new Response(null)), report)).rejects.toThrow(`is 0 bytes, expected ${String(pin.bytes)}`);
    expect(phases(events)).toEqual(["fetch", "verify"]);
  });
});

function engineWith(pool: FakePool, options: EngineOptions = {}): DemoDbEngine {
  const sqlite3: Sqlite3Like = { ...sqliteLike, installOpfsSAHPoolVfs: () => Promise.resolve(pool) };
  return new DemoDbEngine(sqlite3, { fetch: serve({ [pin.url]: sample }), getDirectory: () => Promise.resolve(emptyDirectory), ...options });
}

describe("DemoDbEngine progress", () => {
  it("reports the phases of a first open, a reopen and a reset in order", async () => {
    const pool = new FakePool();
    const engineEvents = record();
    const engine = engineWith(pool, { onProgress: engineEvents.report });
    const callEvents = record();
    await engine.open(pin, {}, callEvents.report);
    expect(phases(callEvents.events)).toEqual(["fetch", "verify", "importPristine", "importWorking", "open"]);
    expect(engineEvents.events).toEqual(callEvents.events);
    expect(callEvents.events.find((event) => event.phase === "importWorking")).toEqual({ phase: "importWorking", total: pin.bytes });
    const reset = record();
    await engine.reset(reset.report);
    expect(phases(reset.events)).toEqual(["verify", "importWorking", "open"]);
    engine.close();
    const reopen = record();
    await engineWith(pool).open(pin, {}, reopen.report);
    expect(phases(reopen.events)).toEqual(["open"]);
  });

  it("reports the download of a single-copy open and reset, and of a memory open", async () => {
    const single = record();
    const engine = engineWith(new FakePool());
    await engine.open(pin, { storagePolicy: "single-copy" }, single.report);
    expect(phases(single.events)).toEqual(["fetch", "verify", "importWorking", "open"]);
    const reset = record();
    await engine.reset(reset.report);
    expect(phases(reset.events)).toEqual(["fetch", "verify", "importWorking", "open"]);
    await engine.reset();
    const memory = record();
    await new DemoDbEngine(sqliteLike, { fetch: serve({ [pin.url]: sample }), getDirectory: null }).open(pin, {}, memory.report);
    expect(phases(memory.events)).toEqual(["fetch", "verify", "open"]);
  });

  it("reports the repair of a damaged working copy", async () => {
    const pool = new FakePool();
    const first = engineWith(pool);
    await first.open(pin);
    first.close();
    pool.files.set(workingPath(pin), new Uint8Array(4096));
    expect(pool.files.has(canonicalPath(pin))).toBe(true);
    const repair = record();
    const engine = engineWith(pool);
    await engine.open(pin, {}, repair.report);
    expect(phases(repair.events)).toEqual(["open", "verify", "importWorking", "open"]);
  });
});

describe("progress across the worker boundary", () => {
  function worker(pool = new FakePool()): InProcessWorker {
    const sqlite3: Sqlite3Like = { ...sqliteLike, installOpfsSAHPoolVfs: () => Promise.resolve(pool) };
    return new InProcessWorker({ sqlite3: () => Promise.resolve(sqlite3), fetch: serve({ [pin.url]: sample }), getDirectory: () => Promise.resolve(emptyDirectory) });
  }

  it("reaches the leader tab's listener for the open and every reset", async () => {
    const events = record();
    const opened = await openLeaderDatabase(new WorkerClient(worker()), pin, { onProgress: events.report, open: { storagePolicy: "single-copy" } });
    expect(phases(events.events)).toEqual(["fetch", "verify", "importWorking", "open"]);
    events.events.length = 0;
    await opened.reset();
    expect(phases(events.events)).toEqual(["fetch", "verify", "importWorking", "open"]);
  });

  it("is only sent when asked for, and dropped for a call without a listener", async () => {
    const quiet = worker();
    const client = new WorkerClient(quiet);
    await openLeaderDatabase(client, pin);
    expect(quiet.posted[0]).not.toHaveProperty("progress");
    const asked = worker();
    await new WorkerClient(asked).call("open", { pin, progress: true });
    expect(asked.posted[0]).toMatchObject({ progress: true });
  });
});
