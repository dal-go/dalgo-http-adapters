import { afterEach, describe, expect, it, vi } from "vitest";
import { LeaderElection, defaultLocks, type ElectionHandlers, type LockManagerLike } from "../../src/opfs/leader.js";
import { FakeLocks, settle } from "./helpers.js";

afterEach(() => { vi.unstubAllGlobals(); });

function handlers(log: string[], tag: string, acquire?: () => Promise<void>): ElectionHandlers {
  return {
    onAcquired: () => {
      log.push(`${tag} acquired`);
      return acquire?.();
    },
    onReleased: () => { log.push(`${tag} released`); },
    onError: (error) => { log.push(`${tag} error ${String(error)}`); },
  };
}

describe("LeaderElection", () => {
  it("grants the lock to one tab and hands it over when that tab releases it", async () => {
    const locks = new FakeLocks();
    const log: string[] = [];
    const first = new LeaderElection(locks, "demodb:x", handlers(log, "first"));
    const second = new LeaderElection(locks, "demodb:x", handlers(log, "second"));
    first.start();
    second.start();
    first.start();
    await settle();
    expect([first.state, second.state]).toEqual(["leader", "waiting"]);
    first.release();
    await settle();
    expect([first.state, second.state]).toEqual(["idle", "leader"]);
    expect(log).toEqual(["first acquired", "first released", "second acquired"]);
    second.release();
    second.release();
    await settle();
    expect(locks.held("demodb:x")).toBe(false);
  });

  it("stops waiting when released before the grant", async () => {
    const locks = new FakeLocks();
    const log: string[] = [];
    const first = new LeaderElection(locks, "demodb:x", handlers(log, "first"));
    const second = new LeaderElection(locks, "demodb:x", handlers(log, "second"));
    first.start();
    second.start();
    second.release();
    await settle();
    expect(second.state).toBe("idle");
    first.release();
    await settle();
    expect(log).toEqual(["first acquired", "first released"]);
    second.start();
    await settle();
    expect(second.state).toBe("leader");
  });

  it("ignores a grant that arrives after the round was released", async () => {
    let grant: (() => Promise<void>) | undefined;
    const locks: LockManagerLike = {
      request: (_name, _options, callback) => {
        grant = () => callback({});
        return new Promise(() => undefined);
      },
    };
    const log: string[] = [];
    const election = new LeaderElection(locks, "demodb:x", handlers(log, "tab"));
    election.start();
    election.release();
    await grant?.();
    expect(log).toEqual([]);
    expect(election.state).toBe("idle");
  });

  it("releases the lock and reports when taking the lead fails", async () => {
    const locks = new FakeLocks();
    const log: string[] = [];
    const failing = new LeaderElection(locks, "demodb:x", handlers(log, "failing", () => Promise.reject(new Error("no data"))));
    const next = new LeaderElection(locks, "demodb:x", handlers(log, "next"));
    failing.start();
    next.start();
    await settle();
    expect(failing.state).toBe("idle");
    expect(next.state).toBe("leader");
    expect(log).toEqual(["failing acquired", "failing released", "failing error Error: no data", "next acquired"]);
  });

  it("keeps a release that happened while taking the lead", async () => {
    const locks = new FakeLocks();
    const log: string[] = [];
    let election: LeaderElection | undefined;
    election = new LeaderElection(locks, "demodb:x", handlers(log, "tab", () => {
      election?.release();
      return Promise.reject(new Error("late"));
    }));
    election.start();
    await settle();
    expect(log).toEqual(["tab acquired", "tab released", "tab error Error: late"]);
    expect(locks.held("demodb:x")).toBe(false);
    election = undefined;
  });

  it("reports a lock request the browser refuses", async () => {
    const log: string[] = [];
    const locks: LockManagerLike = { request: () => Promise.reject(new Error("SecurityError")) };
    const election = new LeaderElection(locks, "demodb:x", { onAcquired: () => undefined, onError: (error) => { log.push(String(error)); } });
    election.start();
    await settle();
    expect(log).toEqual(["Error: SecurityError"]);
    expect(election.state).toBe("idle");
    const quiet = new LeaderElection(locks, "demodb:x", { onAcquired: () => undefined });
    quiet.start();
    await settle();
    expect(quiet.state).toBe("idle");
  });

  it("leads at once without Web Locks", async () => {
    const log: string[] = [];
    const election = new LeaderElection(undefined, "demodb:x", { onAcquired: () => { log.push("acquired"); } });
    election.start();
    await settle();
    expect(election.state).toBe("leader");
    election.release();
    expect(election.state).toBe("idle");
    expect(log).toEqual(["acquired"]);
  });

  it("finds navigator.locks", () => {
    const locks = new FakeLocks();
    vi.stubGlobal("navigator", { locks });
    expect(defaultLocks()).toBe(locks);
    vi.stubGlobal("navigator", undefined);
    expect(defaultLocks()).toBeUndefined();
  });
});
