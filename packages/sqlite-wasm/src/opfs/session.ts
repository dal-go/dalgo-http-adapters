import type { Resettable } from "@dalgo/core";
import type { SqliteDatabase } from "../database.js";
import { validatePin, type CanonicalPin, type StoragePolicy } from "./canonical.js";
import { WorkerClient, openLeaderDatabase, type LeaderDatabase, type PersistenceResult, type RequestPersistence, type WorkerLike } from "./client.js";
import { DemoDbConfigError } from "./config-error.js";
import type { OpenOptions, OpenReport } from "./engine.js";
import { LeaderElection, defaultLocks, type LockManagerLike } from "./leader.js";
import type { DemoDbProgressListener } from "./progress.js";
import type { ResetResult } from "./reset.js";
import { TabBridge, type BridgePort, type BroadcastChannelLike, type PortProtocol } from "./tab-bridge.js";

/** What the leader tab's handlers work with. */
export interface LeaderContext {
  readonly database: SqliteDatabase & Resettable;
  readonly report: OpenReport;
}

/** How the leader tab answers every tab (itself included). */
export interface DemoDbHandlers {
  /** Answers {@link DemoDbSession.request}. */
  request?(payload: unknown, context: LeaderContext): Promise<unknown>;
  /** Serves one {@link DemoDbSession.connect} port; may return a function that stops serving. */
  port?(port: BridgePort, context: LeaderContext): (() => void) | undefined;
}

/** The window events the session follows (`pagehide`, `pageshow`, `visibilitychange`). */
export interface LifecycleTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface OpenDemoDbOptions {
  readonly pin: CanonicalPin;
  /** Starts a dedicated module worker that calls `serveDemoDbWorker()`. Only the leader tab starts one. */
  readonly createWorker: () => WorkerLike;
  readonly serve?: DemoDbHandlers;
  /** Default `demodb:<dataset>`; tabs with the same name share one leader. */
  readonly lockName?: string;
  /** `navigator.locks` by default; `null` disables election (every tab leads). */
  readonly locks?: LockManagerLike | null;
  /** A `BroadcastChannel` named like the lock by default. */
  readonly channel?: BroadcastChannelLike;
  /** `window` by default; `null` ignores page lifecycle events. */
  readonly lifecycle?: LifecycleTarget | null;
  /** `document.visibilityState` by default. */
  readonly visibilityState?: () => string;
  /** `navigator.storage.persist` by default; `null` never asks. */
  readonly requestPersistence?: RequestPersistence | null;
  readonly tabId?: string;
  /** How many times in a row a crashed worker is replaced. Default 3. */
  readonly maxWorkerRestarts?: number;
  /** A worker that ran this long (ms) before crashing resets the restart count. Default 60000. */
  readonly restartWindowMs?: number;
  /**
   * `"memory"` keeps the dataset in memory only (edits are lost on reload).
   * Default `"opfs"`. Without Web Locks in the browser the session uses
   * memory, reported as fallback reason `"web-locks-unavailable"`.
   */
  readonly storage?: "opfs" | "memory";
  /**
   * Open in memory when the OPFS files stay locked by another context
   * (reported as fallback reason `"locked"`). Default `false`: the session
   * fails with a retriable `PoolUnavailableError` and the stored edits stay
   * safe for a later attempt.
   */
  readonly memoryFallbackWhenLocked?: boolean;
  /**
   * `"forbid"`: never serve the dataset from memory. Where OPFS cannot be
   * used (unsupported, refused, quota, no Web Locks) the session fails with
   * a `PoolUnavailableError` before the canonical file is downloaded, so
   * large datasets are not fetched only to be lost on reload. Default
   * `"allow"`. Contradicts `storage: "memory"` and
   * `memoryFallbackWhenLocked: true` (both throw `DemoDbConfigError`).
   */
  readonly memoryFallback?: "allow" | "forbid";
  /**
   * `"single-copy"` keeps only the working copy in OPFS (half the space);
   * reset downloads and verifies the pinned file again. Default
   * `"working-and-pristine"`. The leader tab's policy applies.
   */
  readonly storagePolicy?: StoragePolicy;
  /**
   * Called in the tab that leads while its worker opens or resets the
   * dataset: `{ phase, loaded?, total? }`, at most every 100 ms within a
   * phase plus every phase change. Followers get no progress (they do not
   * open the dataset).
   */
  readonly onProgress?: DemoDbProgressListener;
}

export { DemoDbConfigError };

function checkChoice(option: string, value: unknown, choices: readonly string[]): void {
  if (value !== undefined && !choices.includes(value as string)) {
    throw new DemoDbConfigError(`${option} must be ${choices.map((choice) => JSON.stringify(choice)).join(" or ")}, got ${JSON.stringify(value)}`);
  }
}

/**
 * - `connecting`: no leader known yet (or this tab is opening the dataset)
 * - `leader`: this tab owns the worker and the database
 * - `follower`: another tab leads; requests go to it
 * - `suspended`: the page is hidden in the back/forward cache
 * - `failed`: this tab could not open the dataset
 * - `closed`: `close()` was called
 */
export type DemoDbRole = "connecting" | "leader" | "follower" | "suspended" | "failed" | "closed";

export type DemoDbEvent =
  | { readonly type: "role"; readonly role: DemoDbRole }
  | { readonly type: "opened"; readonly report: OpenReport }
  | { readonly type: "error"; readonly error: unknown };

/**
 * One tab's handle on a demo dataset shared by every tab of the origin. One
 * tab leads: it runs the dataset worker and answers the others over a
 * `BroadcastChannel`. When it goes away, a waiting tab takes over and opens
 * the same OPFS files, so committed writes are kept.
 */
export class DemoDbSession {
  readonly #options: OpenDemoDbOptions;
  readonly #bridge: TabBridge;
  readonly #election: LeaderElection;
  readonly #lifecycle: LifecycleTarget | undefined;
  readonly #listeners = new Set<(event: DemoDbEvent) => void>();
  #role: DemoDbRole = "connecting";
  #leading: { readonly client: WorkerClient; readonly opened: LeaderDatabase } | undefined;
  #restarts = 0;
  #ledSince = 0;
  readonly #open: OpenOptions;
  readonly #ready: Promise<OpenReport>;
  #settleReady: { resolve(report: OpenReport): void; reject(error: unknown): void } | undefined;
  readonly #onPageHide = (): void => { this.#suspend(); };
  readonly #onPageShow = (event: Event): void => { if ((event as PageTransitionEvent).persisted) this.#resume(); };
  readonly #onVisibility = (): void => {
    const state = this.#options.visibilityState?.() ?? (globalThis as { readonly document?: { readonly visibilityState: string } }).document?.visibilityState;
    if (state === "visible" && this.#role === "connecting") this.#bridge.hello();
  };

  public constructor(options: OpenDemoDbOptions) {
    validatePin(options.pin);
    if (options.locks === null && options.storage !== "memory") {
      // Every tab would install the pool at once; a failed install makes
      // sqlite-wasm delete the pool directory (removeVfs).
      throw new DemoDbConfigError("locks: null requires storage: \"memory\": without leader election, tabs would race for the OPFS pool");
    }
    checkChoice("memoryFallback", options.memoryFallback, ["allow", "forbid"]);
    checkChoice("storagePolicy", options.storagePolicy, ["working-and-pristine", "single-copy"]);
    if (options.memoryFallback === "forbid" && options.storage === "memory") {
      throw new DemoDbConfigError("memoryFallback: \"forbid\" contradicts storage: \"memory\"");
    }
    if (options.memoryFallback === "forbid" && options.memoryFallbackWhenLocked === true) {
      throw new DemoDbConfigError("memoryFallback: \"forbid\" contradicts memoryFallbackWhenLocked: true");
    }
    this.#options = options;
    const locks = options.locks === null ? undefined : options.locks ?? defaultLocks();
    const policy = {
      ...(options.memoryFallback === undefined ? {} : { memoryFallback: options.memoryFallback }),
      ...(options.storagePolicy === undefined ? {} : { storagePolicy: options.storagePolicy }),
    };
    this.#open = options.storage === "memory"
      ? { storage: "memory" }
      : locks === undefined
        ? { storage: "memory", memoryReason: "web-locks-unavailable", ...policy }
        : { memoryWhenLocked: options.memoryFallbackWhenLocked ?? false, ...policy };
    const name = options.lockName ?? `demodb:${options.pin.dataset}`;
    this.#bridge = new TabBridge(options.channel ?? new BroadcastChannel(name), options.tabId ?? crypto.randomUUID());
    this.#bridge.onLeaderChange = (leader) => {
      if (leader !== undefined) this.#settleReady?.resolve(leader.info as OpenReport);
      if (this.#role === "suspended" || this.#role === "failed" || this.#role === "closed") return;
      this.#setRole(leader === undefined ? "connecting" : leader.local ? "leader" : "follower");
    };
    this.#ready = new Promise((resolve, reject) => { this.#settleReady = { resolve, reject }; });
    this.#ready.then(() => { this.#settleReady = undefined; }, () => { this.#settleReady = undefined; });
    this.#election = new LeaderElection(locks, name, {
      onAcquired: () => this.#lead(),
      onReleased: () => { this.#stopLeading(); },
      onError: (error) => { this.#fail(error); },
    });
    this.#lifecycle = options.lifecycle === null ? undefined : options.lifecycle ?? (globalThis as { readonly window?: LifecycleTarget }).window;
    this.#lifecycle?.addEventListener("pagehide", this.#onPageHide);
    this.#lifecycle?.addEventListener("pageshow", this.#onPageShow);
    this.#lifecycle?.addEventListener("visibilitychange", this.#onVisibility);
    this.#election.start();
    this.#bridge.hello();
  }

  public get role(): DemoDbRole { return this.#role; }

  /** This tab's id in the bridge. */
  public get tabId(): string { return this.#bridge.tabId; }

  /** The open report of the current leader (this tab or another). */
  public get report(): OpenReport | undefined { return this.#bridge.leader?.info as OpenReport | undefined; }

  /** The database, while this tab leads. */
  public get database(): (SqliteDatabase & Resettable) | undefined { return this.#leading?.opened.database; }

  /** The `navigator.storage.persist()` outcome of this tab's first write as leader. */
  public persistence(): Promise<PersistenceResult> | undefined { return this.#leading?.opened.persistence(); }

  /** Resolves with the leader's open report once any tab has opened the dataset. */
  public ready(): Promise<OpenReport> { return this.#ready; }

  /** Sends a request to the leader's `serve.request` handler. Fails with `LeaderChangedError` (retriable) if the leader changes meanwhile. */
  public request(payload: unknown): Promise<unknown> { return this.#bridge.request(payload); }

  /** Resets the dataset to its pristine copy (in the leader tab). */
  public async reset(): Promise<ResetResult> { return await this.#bridge.reset() as ResetResult; }

  /** A `MessagePort`-shaped endpoint served by the leader's `serve.port` handler. */
  public connect(protocol?: PortProtocol): BridgePort { return this.#bridge.connect(protocol); }

  /** Listens to role changes, opens and errors. Returns an unsubscribe function. */
  public subscribe(listener: (event: DemoDbEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** Leaves: releases the lock (a waiting tab takes over), stops the worker and rejects waiting requests. */
  public close(): void {
    if (this.#role === "closed") return;
    this.#lifecycle?.removeEventListener("pagehide", this.#onPageHide);
    this.#lifecycle?.removeEventListener("pageshow", this.#onPageShow);
    this.#lifecycle?.removeEventListener("visibilitychange", this.#onVisibility);
    this.#setRole("closed");
    this.#election.release();
    this.#bridge.close();
    this.#settleReady?.reject(new Error("the dataset session was closed"));
  }

  #emit(event: DemoDbEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #setRole(role: DemoDbRole): void {
    if (this.#role === role) return;
    this.#role = role;
    this.#emit({ type: "role", role });
  }

  async #lead(): Promise<void> {
    const client = new WorkerClient(this.#options.createWorker());
    let opened: LeaderDatabase;
    try {
      opened = await openLeaderDatabase(client, this.#options.pin, {
        requestPersistence: this.#options.requestPersistence, open: this.#open, onProgress: this.#options.onProgress,
      });
    } catch (error) {
      client.terminate();
      throw error;
    }
    if (this.#election.state !== "leader") {
      client.terminate();
      return;
    }
    this.#leading = { client, opened };
    this.#ledSince = Date.now();
    client.onFailure = (error) => { this.#workerFailed(client, error); };
    const context: LeaderContext = { database: opened.database, report: opened.report };
    const handlers = this.#options.serve ?? {};
    this.#emit({ type: "opened", report: opened.report });
    this.#bridge.becomeLeader({
      request: (payload) => handlers.request === undefined
        ? Promise.reject(new Error("this dataset session serves no requests"))
        : handlers.request(payload, context),
      reset: () => opened.reset(),
      port: (port) => handlers.port?.(port, context),
    }, opened.report);
  }

  #stopLeading(): void {
    const leading = this.#leading;
    this.#leading = undefined;
    this.#bridge.stepDown();
    leading?.client.terminate("this tab stopped leading the dataset");
  }

  #workerFailed(client: WorkerClient, error: Error): void {
    if (this.#leading?.client !== client) return;
    this.#emit({ type: "error", error });
    this.#election.release();
    if (Date.now() - this.#ledSince >= (this.#options.restartWindowMs ?? 60_000)) this.#restarts = 0;
    if (this.#restarts >= (this.#options.maxWorkerRestarts ?? 3)) {
      this.#fail(error);
      return;
    }
    this.#restarts += 1;
    this.#election.start();
  }

  #fail(error: unknown): void {
    if (this.#role === "closed") return;
    this.#emit({ type: "error", error });
    this.#setRole("failed");
    this.#settleReady?.reject(error);
    this.#bridge.close();
  }

  #suspend(): void {
    if (this.#role === "failed") return; // a closed session no longer listens
    this.#setRole("suspended");
    this.#election.release();
    this.#bridge.leave();
  }

  #resume(): void {
    if (this.#role !== "suspended") return;
    this.#setRole("connecting");
    this.#election.start();
    this.#bridge.hello();
  }
}

/** Joins the dataset's tabs: this tab leads (opening the dataset in a worker) or follows the tab that does. */
export function openDemoDb(options: OpenDemoDbOptions): DemoDbSession {
  return new DemoDbSession(options);
}
