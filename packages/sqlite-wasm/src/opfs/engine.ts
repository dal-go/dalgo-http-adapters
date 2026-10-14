import type { SqliteBindValue, SqliteExecResult } from "../driver.js";
import {
  fetchCanonical,
  openCanonical,
  prepareConnection,
  validatePin,
  type CanonicalPin,
  type ClosableOo1Db,
  type OpenedDatabase,
} from "./canonical.js";
import {
  PoolUnavailableError,
  datasetPool,
  installPool,
  poolOptionsFor,
  type InstallPoolOptions,
  type InstallSahPool,
  type PoolUnavailableReason,
  type ProbeDirectoryHandle,
  type SahPoolUtilLike,
} from "./pool.js";
import { resetInMemory, resetWorkingCopy, type ResetResult } from "./reset.js";

/** The members of an initialized `@sqlite.org/sqlite-wasm` module the engine uses. */
export interface Sqlite3Like {
  readonly installOpfsSAHPoolVfs?: InstallSahPool;
  readonly oo1: { readonly DB: new (filename: string) => ClosableOo1Db };
  readonly capi: {
    readonly SQLITE_DESERIALIZE_FREEONCLOSE: number;
    readonly SQLITE_DESERIALIZE_RESIZEABLE: number;
    sqlite3_deserialize(db: ClosableOo1Db, schema: string, pointer: number, size: number, capacity: number, flags: number): number;
    sqlite3_js_db_export(db: ClosableOo1Db): Uint8Array;
  };
  readonly wasm: { allocFromTypedArray(bytes: Uint8Array): number };
}

/** The dataset is served from memory because OPFS could not be used; edits are lost on reload. */
export interface FallbackSignal {
  readonly kind: "memory";
  /**
   * Why: OPFS is unsupported or refused here (a {@link PoolUnavailableReason}
   * other than `"locked"`), the pool stayed locked and the caller opted in to
   * memory (`"locked"`), memory was asked for (`"requested"`), or the browser
   * has no Web Locks, so tabs cannot share the OPFS files safely
   * (`"web-locks-unavailable"`).
   */
  readonly reason: FallbackReason;
  readonly message: string;
}

export type FallbackReason = PoolUnavailableReason | "requested" | "web-locks-unavailable";

/** How to open a dataset. */
export interface OpenOptions {
  /** `"memory"` skips OPFS. Default `"opfs"`. */
  readonly storage?: "opfs" | "memory";
  /** The fallback reason reported for `storage: "memory"`. Default `"requested"`. */
  readonly memoryReason?: "requested" | "web-locks-unavailable";
  /**
   * When the pool's files stay locked by another context after every retry,
   * open in memory instead of failing. Default `false`: a locked pool fails
   * with a retriable {@link PoolUnavailableError}, because edits made in
   * memory would be lost on reload.
   */
  readonly memoryWhenLocked?: boolean;
}

/** The outcome of opening a dataset. */
export interface OpenReport {
  readonly dataset: string;
  readonly canonical: { readonly sha256: string };
  /** True when edits are stored in OPFS and survive a reload. */
  readonly persistent: boolean;
  /** True when this open deleted the files (and edits) of a previous pinned version. Show a one-time notice. */
  readonly replacedPreviousVersion: boolean;
  /** True when the canonical file was downloaded during this open. */
  readonly imported: boolean;
  /** Present when the dataset fell back to memory. */
  readonly fallback?: FallbackSignal;
}

export interface EngineOptions {
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** `navigator.storage.getDirectory` by default. */
  readonly getDirectory?: (() => Promise<ProbeDirectoryHandle>) | null;
  readonly pool?: Pick<InstallPoolOptions, "attempts" | "baseDelayMs" | "maxDelayMs" | "sleep" | "onRetry">;
}

type Mode =
  | { readonly kind: "pool"; readonly util: SahPoolUtilLike }
  | { readonly kind: "memory"; readonly pristine: Uint8Array };

interface OpenState {
  readonly pin: CanonicalPin;
  readonly mode: Mode;
  current: OpenedDatabase | undefined;
}

function defaultGetDirectory(): (() => Promise<ProbeDirectoryHandle>) | undefined {
  const storage = (globalThis as { readonly navigator?: { readonly storage?: { getDirectory?: () => Promise<unknown> } } }).navigator?.storage;
  if (typeof storage?.getDirectory !== "function") return undefined;
  return () => (storage.getDirectory as () => Promise<ProbeDirectoryHandle>).call(storage);
}

/**
 * Owns one dataset's SQLite connection inside a dedicated worker: the OPFS
 * pool, the working and pristine copies, reset, and the in-memory fallback.
 */
export class DemoDbEngine {
  readonly #sqlite3: Sqlite3Like;
  readonly #options: EngineOptions;
  #state: OpenState | undefined;

  public constructor(sqlite3: Sqlite3Like, options: EngineOptions = {}) {
    this.#sqlite3 = sqlite3;
    this.#options = options;
  }

  #download(pin: CanonicalPin): () => Promise<Uint8Array> {
    return () => fetchCanonical(pin, this.#options.fetch);
  }

  #openMemory = (bytes: Uint8Array): ClosableOo1Db => {
    const { capi, oo1, wasm } = this.#sqlite3;
    const db = new oo1.DB(":memory:");
    const pointer = wasm.allocFromTypedArray(bytes);
    const rc = capi.sqlite3_deserialize(db, "main", pointer, bytes.byteLength, bytes.byteLength,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
    if (rc !== 0) {
      db.close();
      throw new Error(`sqlite3_deserialize failed with result code ${String(rc)}`);
    }
    return db;
  };

  #memory = { open: this.#openMemory, export: (db: ClosableOo1Db) => this.#sqlite3.capi.sqlite3_js_db_export(db) };

  async #openInMemory(pin: CanonicalPin, reason: FallbackReason, message: string): Promise<OpenReport> {
    const pristine = await this.#download(pin)();
    const current = await prepareConnection(this.#openMemory(pristine));
    this.#state = { pin, mode: { kind: "memory", pristine }, current };
    return {
      dataset: pin.dataset, canonical: { sha256: pin.sha256 }, persistent: false, replacedPreviousVersion: false, imported: true,
      fallback: { kind: "memory", reason, message },
    };
  }

  /**
   * Opens the pinned dataset in OPFS. Falls back to memory when OPFS is
   * unsupported or refused; a pool that stays locked fails with a retriable
   * {@link PoolUnavailableError} unless `memoryWhenLocked` is set.
   */
  public async open(pin: CanonicalPin, options: OpenOptions = {}): Promise<OpenReport> {
    validatePin(pin);
    if (this.#state !== undefined) throw new Error("the dataset is already open");
    if (options.storage === "memory") {
      const reason = options.memoryReason ?? "requested";
      return this.#openInMemory(pin, reason, reason === "requested"
        ? "memory storage was requested"
        : "this browser has no Web Locks, so tabs cannot share the OPFS files safely");
    }
    const download = this.#download(pin);
    let util: SahPoolUtilLike;
    try {
      const getDirectory = this.#options.getDirectory === null ? undefined : this.#options.getDirectory ?? defaultGetDirectory();
      util = await installPool(poolOptionsFor(pin.dataset), {
        ...this.#options.pool,
        install: this.#sqlite3.installOpfsSAHPoolVfs?.bind(this.#sqlite3),
        getDirectory,
      });
    } catch (error) {
      const unavailable = error as PoolUnavailableError;
      if (unavailable.reason === "locked" && options.memoryWhenLocked !== true) throw unavailable;
      return this.#openInMemory(pin, unavailable.reason, unavailable.message);
    }
    try {
      const opened = await openCanonical(datasetPool(util), pin, download);
      this.#state = { pin, mode: { kind: "pool", util }, current: { db: opened.db, driver: opened.driver } };
      return {
        dataset: pin.dataset, canonical: { sha256: pin.sha256 }, persistent: true,
        replacedPreviousVersion: opened.replacedPreviousVersion, imported: opened.imported,
      };
    } catch (error) {
      util.pauseVfs();
      throw error;
    }
  }

  #open(): { readonly state: OpenState; readonly current: OpenedDatabase } {
    const state = this.#state;
    const current = state?.current;
    if (state === undefined || current === undefined) throw new Error("the dataset is not open");
    return { state, current };
  }

  /** Runs one statement on the open connection. */
  public async exec(sql: string, binds?: readonly SqliteBindValue[]): Promise<SqliteExecResult> {
    return this.#open().current.driver.exec(sql, binds);
  }

  /** Restores the pristine dataset. The connection stays closed if it fails. */
  public async reset(): Promise<ResetResult> {
    const { state, current } = this.#open();
    const { pin, mode } = state;
    state.current = undefined;
    state.current = mode.kind === "pool"
      ? await resetWorkingCopy(datasetPool(mode.util), pin, current.db, this.#download(pin))
      : await resetInMemory(current.db, mode.pristine, pin.sha256, this.#memory);
    return { canonical: { sha256: pin.sha256 } };
  }

  /** Closes the connection and releases the pool's file handles, so another tab can open the dataset. */
  public close(): void {
    const state = this.#state;
    this.#state = undefined;
    if (state === undefined) return;
    state.current?.db.close();
    if (state.mode.kind === "pool") state.mode.util.pauseVfs();
  }
}
