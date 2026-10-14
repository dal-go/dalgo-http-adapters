import { afterEach, describe, expect, it, vi } from "vitest";
import { Key } from "@dalgo/core";
import type { Sqlite3Like } from "../../src/opfs/engine.js";
import { LeaderChangedError } from "../../src/opfs/tab-bridge.js";
import { DemoDbSession, openDemoDb, type DemoDbEvent, type DemoDbHandlers, type LeaderContext, type OpenDemoDbOptions } from "../../src/opfs/index.js";
import { ChannelHub, FakeLocks, FakePool, InProcessWorker, emptyDirectory, pinFor, sampleBytes, serve, settle, sqliteLike } from "./helpers.js";

const sample = sampleBytes();
const pin = pinFor(sample);

afterEach(() => { vi.unstubAllGlobals(); });

type Operation = { readonly op: "get"; readonly id: number } | { readonly op: "rename"; readonly id: number; readonly name: string };

const handlers: DemoDbHandlers = {
  async request(payload: unknown, { database }: LeaderContext): Promise<unknown> {
    const operation = payload as Operation;
    if (operation.op === "get") return (await database.get(new Key("Artist", operation.id))).data;
    await database.runReadwriteTransaction((tx) => tx.update(new Key("Artist", operation.id), { Name: operation.name }));
    return true;
  },
  port(port, { database }) {
    const listener = (event: MessageEvent): void => {
      void database.get(new Key("Artist", event.data as number)).then((snapshot) => { port.postMessage(snapshot.data); });
    };
    port.addEventListener("message", listener);
    return () => { port.removeEventListener("message", listener); };
  },
};

/** An origin: shared OPFS, locks and channels for several tabs. */
class Origin {
  public readonly pool = new FakePool();
  public readonly locks = new FakeLocks();
  public readonly hub = new ChannelHub();
  public readonly workers: InProcessWorker[] = [];
  public fetchFn = serve({ [pin.url]: sample });

  public worker = (): InProcessWorker => {
    const sqlite3: Sqlite3Like = { ...sqliteLike, installOpfsSAHPoolVfs: () => Promise.resolve(this.pool) };
    const worker = new InProcessWorker({ sqlite3: () => Promise.resolve(sqlite3), fetch: this.fetchFn, getDirectory: () => Promise.resolve(emptyDirectory) });
    this.workers.push(worker);
    return worker;
  };

  public tab(options: Partial<OpenDemoDbOptions> = {}): { readonly session: DemoDbSession; readonly events: DemoDbEvent[]; readonly window: EventTarget } {
    const window = new EventTarget();
    const session = openDemoDb({
      pin, createWorker: this.worker, serve: handlers, locks: this.locks, channel: this.hub.create(), lifecycle: window,
      requestPersistence: () => Promise.resolve(true), ...options,
    });
    const events: DemoDbEvent[] = [];
    session.subscribe((event) => { events.push(event); });
    return { session, events, window };
  }
}

const get = (session: DemoDbSession, id: number): Promise<unknown> => session.request({ op: "get", id });
const rename = (session: DemoDbSession, id: number, name: string): Promise<unknown> => session.request({ op: "rename", id, name });

function pageEvent(type: string, persisted: boolean): Event {
  return Object.assign(new Event(type), { persisted });
}

describe("DemoDbSession", () => {
  it("leads alone: opens the dataset, serves requests, ports and reset", async () => {
    const origin = new Origin();
    const { session, events } = origin.tab({ tabId: "solo" });
    expect(session.tabId).toBe("solo");
    expect(session.role).toBe("connecting");
    const report = await session.ready();
    expect(report).toMatchObject({ persistent: true, imported: true });
    expect(session.role).toBe("leader");
    expect(session.report).toEqual(report);
    expect(session.database?.capabilities()).toMatchObject({ persistent: true, reset: true });
    expect(session.persistence()).toBeUndefined();
    await rename(session, 1, "edited");
    expect(await session.persistence()).toBe("granted");
    expect(await get(session, 1)).toEqual({ ArtistId: 1, Name: "edited" });
    const port = session.connect();
    const answer = new Promise((resolve) => { port.addEventListener("message", (event) => { resolve(event.data); }); });
    port.postMessage(1);
    expect(await answer).toEqual({ ArtistId: 1, Name: "edited" });
    port.close();
    expect(await session.reset()).toEqual({ canonical: { sha256: pin.sha256 } });
    expect(await get(session, 1)).toEqual({ ArtistId: 1, Name: "AC/DC" });
    expect(events.map((event) => event.type === "role" ? event.role : event.type)).toEqual(["opened", "leader"]);
    const late = vi.fn();
    session.subscribe(late)();
    session.close();
    expect(late).not.toHaveBeenCalled();
    session.close();
    expect(session.role).toBe("closed");
    expect(session.database).toBeUndefined();
    await settle();
    expect(origin.locks.held(`demodb:${pin.dataset}`)).toBe(false);
  });

  it("refuses requests and ports it has no handler for", async () => {
    const origin = new Origin();
    const { session } = origin.tab({ serve: {} });
    await session.ready();
    await expect(session.request("x")).rejects.toThrow("this dataset session serves no requests");
    session.connect().postMessage("ignored");
    await settle();
    const bare = openDemoDb({ pin, createWorker: origin.worker, channel: new ChannelHub().create(), locks: new FakeLocks(), lifecycle: null });
    await bare.ready();
    await expect(bare.request("x")).rejects.toThrow("serves no requests");
    session.close();
    bare.close();
  });

  it("follows the leader tab and takes over when it closes", async () => {
    const origin = new Origin();
    const leader = origin.tab();
    await leader.session.ready();
    const follower = origin.tab();
    expect(await follower.session.ready()).toMatchObject({ persistent: true });
    expect(follower.session.role).toBe("follower");
    expect(follower.session.database).toBeUndefined();
    expect(follower.session.persistence()).toBeUndefined();
    await rename(follower.session, 3, "from the follower");
    expect(await get(leader.session, 3)).toEqual({ ArtistId: 3, Name: "from the follower" });
    expect(await follower.session.reset()).toEqual({ canonical: { sha256: pin.sha256 } });
    await rename(follower.session, 2, "kept");
    leader.session.close();
    await vi.waitFor(() => { expect(follower.session.role).toBe("leader"); });
    expect(await get(follower.session, 2)).toEqual({ ArtistId: 2, Name: "kept" });
    expect(follower.events.map((event) => event.type === "role" ? event.role : event.type)).toEqual(["follower", "connecting", "opened", "leader"]);
    follower.session.close();
  });

  it("fails a follower's in-flight request with a retriable error when the leader leaves", async () => {
    const origin = new Origin();
    const leader = origin.tab({ serve: { request: () => new Promise(() => undefined) } });
    await leader.session.ready();
    const follower = origin.tab();
    await follower.session.ready();
    const inFlight = follower.session.request("slow");
    await settle();
    leader.window.dispatchEvent(pageEvent("pagehide", false));
    await expect(inFlight).rejects.toBeInstanceOf(LeaderChangedError);
    follower.session.close();
  });

  it("goes to the back/forward cache and comes back", async () => {
    const origin = new Origin();
    const first = origin.tab();
    await first.session.ready();
    const second = origin.tab();
    await second.session.ready();
    first.window.dispatchEvent(pageEvent("pagehide", true));
    expect(first.session.role).toBe("suspended");
    await vi.waitFor(() => { expect(second.session.role).toBe("leader"); });
    first.window.dispatchEvent(pageEvent("pageshow", false));
    expect(first.session.role).toBe("suspended");
    first.window.dispatchEvent(pageEvent("pageshow", true));
    await vi.waitFor(() => { expect(first.session.role).toBe("follower"); });
    expect(await get(first.session, 1)).toEqual({ ArtistId: 1, Name: "AC/DC" });
    first.session.close();
    first.window.dispatchEvent(pageEvent("pagehide", true));
    first.window.dispatchEvent(pageEvent("pageshow", true));
    expect(first.session.role).toBe("closed");
    second.session.close();
  });

  it("asks for the leader again when the page becomes visible", async () => {
    const origin = new Origin();
    let visibility = "hidden";
    const lonely = origin.tab({ visibilityState: () => visibility, locks: { request: () => new Promise(() => undefined) } });
    const hellos = () => origin.hub.log.filter((message) => (message as { k: string }).k === "hello").length;
    expect(hellos()).toBe(1);
    lonely.window.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    lonely.window.dispatchEvent(new Event("visibilitychange"));
    expect(hellos()).toBe(2);
    vi.stubGlobal("document", { visibilityState: "visible" });
    const other = origin.tab({ locks: { request: () => new Promise(() => undefined) } });
    other.window.dispatchEvent(new Event("visibilitychange"));
    expect(hellos()).toBe(4);
    lonely.session.close();
    other.session.close();
    await expect(lonely.session.ready()).rejects.toThrow("closed");
  });

  it("fails when the dataset cannot be downloaded", async () => {
    const origin = new Origin();
    origin.fetchFn = serve({});
    const { session, events, window } = origin.tab();
    await expect(session.ready()).rejects.toMatchObject({ name: "CanonicalFetchError" });
    expect(session.role).toBe("failed");
    expect(events.map((event) => event.type === "role" ? event.role : event.type)).toEqual(["error", "failed"]);
    expect(origin.workers[0]?.terminated).toBe(true);
    await expect(session.request("x")).rejects.toBeInstanceOf(LeaderChangedError);
    window.dispatchEvent(pageEvent("pagehide", true));
    expect(session.role).toBe("failed");
    session.close();
  });

  it("replaces a crashed worker, up to a limit", async () => {
    const origin = new Origin();
    const { session, events } = origin.tab({ maxWorkerRestarts: 1 });
    await session.ready();
    await rename(session, 1, "before the crash");
    origin.workers[0]?.crash("boom");
    await vi.waitFor(() => { expect(session.role).toBe("leader"); });
    expect(origin.workers).toHaveLength(2);
    expect(await get(session, 1)).toEqual({ ArtistId: 1, Name: "before the crash" });
    origin.workers[0]?.crash("stale worker");
    origin.workers[1]?.crash("again");
    await vi.waitFor(() => { expect(session.role).toBe("failed"); });
    expect(events.filter((event) => event.type === "error")).toHaveLength(3);
    session.close();
  });

  it("drops a worker that finished opening after the tab stopped leading", async () => {
    const origin = new Origin();
    const { session, window } = origin.tab();
    await vi.waitFor(() => { expect(origin.workers).toHaveLength(1); });
    window.dispatchEvent(pageEvent("pagehide", true));
    expect(session.role).toBe("suspended");
    await vi.waitFor(() => { expect(origin.workers[0]?.terminated).toBe(true); });
    session.close();
  });

  it("uses the browser's globals by default", async () => {
    const origin = new Origin();
    const window = new EventTarget();
    vi.stubGlobal("window", window);
    vi.stubGlobal("navigator", { locks: origin.locks, storage: { persist: () => Promise.resolve(false) } });
    const session = new DemoDbSession({ pin: { ...pin, dataset: "defaults" }, createWorker: origin.worker, serve: handlers });
    await session.ready();
    expect(session.tabId).toMatch(/^[0-9a-f-]{36}$/u);
    await rename(session, 1, "x");
    expect(await session.persistence()).toBe("denied");
    window.dispatchEvent(pageEvent("pagehide", true));
    expect(session.role).toBe("suspended");
    session.close();
    const unmanaged = new DemoDbSession({ pin: { ...pin, dataset: "unmanaged" }, createWorker: origin.worker, serve: handlers, locks: null, lifecycle: null, requestPersistence: null });
    await unmanaged.ready();
    await rename(unmanaged, 1, "x");
    expect(await unmanaged.persistence()).toBe("unavailable");
    unmanaged.close();
  });

  it("stays quiet about failures after it was closed", async () => {
    const origin = new Origin();
    let answer: ((response: Response) => void) | undefined;
    origin.fetchFn = Object.assign((): Promise<Response> => new Promise((resolve) => { answer = resolve; }), { calls: [] });
    const { session, events } = origin.tab();
    await vi.waitFor(() => { expect(answer).toBeDefined(); });
    session.close();
    answer?.(new Response(null, { status: 404 }));
    await settle(20);
    expect(events.map((event) => event.type === "role" ? event.role : event.type)).toEqual(["closed"]);
  });

  it("replaces a crashed worker three times by default", async () => {
    const origin = new Origin();
    const { session } = origin.tab();
    await session.ready();
    for (let crash = 0; crash < 3; crash += 1) {
      origin.workers.at(-1)?.crash();
      await vi.waitFor(() => { expect(origin.workers).toHaveLength(crash + 2); });
      await vi.waitFor(() => { expect(session.role).toBe("leader"); });
    }
    origin.workers.at(-1)?.crash();
    await vi.waitFor(() => { expect(session.role).toBe("failed"); });
    session.close();
  });

  it("keeps its role when the same leader announces itself again", async () => {
    const origin = new Origin();
    const leader = origin.tab();
    await leader.session.ready();
    const follower = origin.tab();
    await follower.session.ready();
    const third = origin.tab();
    await third.session.ready();
    await settle();
    follower.window.dispatchEvent(pageEvent("pageshow", true));
    expect(follower.events.map((event) => event.type === "role" ? event.role : event.type)).toEqual(["follower"]);
    for (const tab of [third, follower, leader]) tab.session.close();
  });

  it("validates the pin", () => {
    expect(() => new DemoDbSession({ pin: { ...pin, sha256: "x" }, createWorker: () => { throw new Error("unused"); } })).toThrow("pin.sha256");
  });
});
