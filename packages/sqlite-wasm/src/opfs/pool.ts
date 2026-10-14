import type { ClosableOo1Db, DatasetPool } from "./canonical.js";

/** Why the OPFS pool could not be used. Every reason makes the dataset fall back to memory. */
export type PoolUnavailableReason =
  /** OPFS or `createSyncAccessHandle` is missing (old browser, webview, main thread). */
  | "missing-api"
  /** The browser refused OPFS access (for example a Firefox private window). */
  | "security"
  /** Sync access handles exist but are too old (asynchronous `close()`). */
  | "sync-handles-unavailable"
  /** The pool's files stayed locked by another context after every retry. */
  | "locked"
  /** The storage quota is exhausted. */
  | "quota"
  /** Any other failure while installing the pool. */
  | "other";

/** The OPFS SAH pool could not be installed. */
export class PoolUnavailableError extends Error {
  public readonly code = "opfs_unavailable" as const;
  public readonly reason: PoolUnavailableReason;
  /** Whether waiting might help (a lock held by a terminating context). */
  public readonly retriable: boolean;

  public constructor(reason: PoolUnavailableReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PoolUnavailableError";
    this.reason = reason;
    this.retriable = reason === "locked";
  }
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classifies a failure of `installOpfsSAHPoolVfs` or of creating a sync access
 * handle. A handle still held by a context that is going away (a fast reload,
 * a crashed tab) surfaces as `NoModificationAllowedError` (Chromium, Firefox)
 * or a bare `InvalidStateError` ("The object is in an invalid state.",
 * WebKit) and is retriable.
 */
export function mapPoolError(error: unknown): PoolUnavailableError {
  if (error instanceof PoolUnavailableError) return error;
  const name = errorName(error);
  const message = errorMessage(error);
  const options = { cause: error };
  if (name === "NoModificationAllowedError" || name === "InvalidStateError") {
    return new PoolUnavailableError("locked", `OPFS files are locked by another context: ${message}`, options);
  }
  if (name === "SecurityError" || name === "NotAllowedError") return new PoolUnavailableError("security", `OPFS access was refused: ${message}`, options);
  if (name === "QuotaExceededError") return new PoolUnavailableError("quota", `OPFS storage quota exceeded: ${message}`, options);
  if (message.includes("Missing required OPFS APIs")) return new PoolUnavailableError("missing-api", message, options);
  if (message.includes("too old for opfs-sahpool")) return new PoolUnavailableError("sync-handles-unavailable", message, options);
  return new PoolUnavailableError("other", `OPFS pool installation failed: ${message}`, options);
}

/** The `installOpfsSAHPoolVfs` options of a dataset's pool. */
export interface PoolOptions {
  /** SQLite VFS name. */
  readonly name: string;
  /** OPFS directory holding the pool's files. */
  readonly directory: string;
  /** Pool slots created for a new pool. */
  readonly initialCapacity: number;
}

/**
 * Each dataset has its own pool, so a tab leading one dataset never touches
 * the files of another. Eight slots hold the working and pristine copies of
 * two versions (during a pin change) plus their journals.
 */
export function poolOptionsFor(dataset: string): PoolOptions {
  return { name: `demodb-${dataset}`, directory: `.demodb/${dataset}`, initialCapacity: 8 };
}

/** The `SAHPoolUtil` members the dataset store uses. */
export interface SahPoolUtilLike {
  readonly OpfsSAHPoolDb: new (filename: string) => ClosableOo1Db;
  getFileNames(): string[];
  importDb(name: string, bytes: Uint8Array): Promise<number>;
  exportFile(name: string): Uint8Array;
  unlink(name: string): boolean;
  reserveMinimumCapacity(minCapacity: number): Promise<number>;
  isPaused(): boolean;
  pauseVfs(): unknown;
  unpauseVfs(): Promise<unknown>;
}

/** The sqlite3 member that installs the pool. */
export type InstallSahPool = (options: PoolOptions & { readonly forceReinitIfPreviouslyFailed: boolean }) => Promise<SahPoolUtilLike>;

/** The parts of the File System API the lock probe uses. */
export interface ProbeFileHandle {
  readonly kind: "file" | "directory";
  readonly name: string;
  createSyncAccessHandle?(): Promise<{ close(): void }>;
}

export interface ProbeDirectoryHandle {
  getDirectoryHandle(name: string, options: { readonly create: boolean }): Promise<ProbeDirectoryHandle>;
  values(): AsyncIterable<ProbeFileHandle>;
}

export interface InstallPoolOptions {
  /** `sqlite3.installOpfsSAHPoolVfs`, or undefined when the build lacks it. */
  readonly install: InstallSahPool | undefined;
  /** `navigator.storage.getDirectory`, or undefined when OPFS is missing. */
  readonly getDirectory: (() => Promise<ProbeDirectoryHandle>) | undefined;
  /** Attempts while the pool's files are locked. Default 20 (about 16 s with the default delays). */
  readonly attempts?: number;
  /** First retry delay in ms, doubled per attempt up to `maxDelayMs`. Default 50. */
  readonly baseDelayMs?: number;
  /** Default 1000. */
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called before each wait for a locked pool, with the failure and the attempt that failed. */
  readonly onRetry?: (error: PoolUnavailableError, attempt: number) => void;
}

const noSyncHandles = "FileSystemFileHandle.createSyncAccessHandle is missing (it exists only in dedicated workers)";

const defaultSleep =(ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens and closes a sync access handle on every file of the pool's directory.
 * It fails while another context (a reloading tab's worker) still holds one.
 * Probing first matters: when `installOpfsSAHPoolVfs` fails to acquire its
 * handles it calls `removeVfs()`, which recursively deletes the directory.
 */
async function probeHandles(getDirectory: () => Promise<ProbeDirectoryHandle>, directory: string): Promise<void> {
  let handle = await getDirectory();
  for (const segment of directory.split("/")) if (segment !== "") handle = await handle.getDirectoryHandle(segment, { create: true });
  const opaque = await handle.getDirectoryHandle(".opaque", { create: true });
  for await (const entry of opaque.values()) {
    if (entry.kind !== "file") continue;
    if (entry.createSyncAccessHandle === undefined) throw new PoolUnavailableError("missing-api", noSyncHandles);
    const access = await entry.createSyncAccessHandle();
    access.close();
  }
}

/**
 * Installs the `opfs-sahpool` VFS of one dataset, retrying with exponential
 * backoff while its files are locked by a context that is going away. Throws
 * {@link PoolUnavailableError} when the pool cannot be used.
 */
export async function installPool(options: PoolOptions, setup: InstallPoolOptions): Promise<SahPoolUtilLike> {
  const { install, getDirectory } = setup;
  if (install === undefined) throw new PoolUnavailableError("missing-api", "this sqlite3 build has no installOpfsSAHPoolVfs");
  if (getDirectory === undefined) throw new PoolUnavailableError("missing-api", "navigator.storage.getDirectory is missing");
  const fileHandle = (globalThis as { readonly FileSystemFileHandle?: { readonly prototype: object } }).FileSystemFileHandle;
  if (fileHandle !== undefined && !("createSyncAccessHandle" in fileHandle.prototype)) throw new PoolUnavailableError("missing-api", noSyncHandles);
  const attempts = setup.attempts ?? 20;
  const maxDelay = setup.maxDelayMs ?? 1000;
  const sleep = setup.sleep ?? defaultSleep;
  let delay = setup.baseDelayMs ?? 50;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await probeHandles(getDirectory, options.directory);
      const util = await install({ ...options, forceReinitIfPreviouslyFailed: true });
      if (util.isPaused()) await util.unpauseVfs();
      await util.reserveMinimumCapacity(options.initialCapacity);
      return util;
    } catch (error) {
      const mapped = mapPoolError(error);
      if (!mapped.retriable || attempt >= attempts) throw mapped;
      setup.onRetry?.(mapped, attempt);
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}

/** Adapts a `SAHPoolUtil` to the dataset store's {@link DatasetPool}. */
export function datasetPool(util: SahPoolUtilLike): DatasetPool {
  return {
    getFileNames: () => util.getFileNames(),
    importDb: (name, bytes) => util.importDb(name, bytes),
    exportFile: (name) => util.exportFile(name),
    unlink: (name) => util.unlink(name),
    open: (name) => new util.OpfsSAHPoolDb(name),
  };
}
