import { DemoDbEngine, type EngineOptions, type Sqlite3Like } from "./engine.js";
import type { DemoDbProgressEvent } from "./progress.js";
import { serializeError, type WorkerProgress, type WorkerRequest, type WorkerResponse } from "./protocol.js";

export type { StoragePolicy } from "./canonical.js";
export type { EngineOptions, FallbackReason, FallbackSignal, OpenOptions, OpenReport, Sqlite3Like } from "./engine.js";
export { throttleProgress } from "./progress.js";
export type { DemoDbProgressEvent, DemoDbProgressListener, DemoDbProgressPhase, ProgressReporter, ThrottleOptions } from "./progress.js";

/** The worker global the server listens on (`self` in a dedicated worker). */
export interface WorkerScopeLike {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown): void;
}

export interface ServeDemoDbWorkerOptions extends EngineOptions {
  /** Default: `globalThis` (the dedicated worker scope). */
  readonly scope?: WorkerScopeLike;
  /** Loads and initializes sqlite-wasm. Default: `@sqlite.org/sqlite-wasm`'s default export. */
  readonly sqlite3?: () => Promise<Sqlite3Like>;
}

async function loadSqlite3(): Promise<Sqlite3Like> {
  const { default: init } = await import("@sqlite.org/sqlite-wasm");
  return await init() as unknown as Sqlite3Like;
}

function isRequest(data: unknown): data is WorkerRequest {
  return typeof data === "object" && data !== null && typeof (data as { id?: unknown }).id === "number" && typeof (data as { op?: unknown }).op === "string";
}

/**
 * Serves one dataset from a dedicated worker. Call it once from the worker
 * module the leader tab starts:
 *
 * ```ts
 * // demodb.worker.ts
 * import { serveDemoDbWorker } from "@dalgo/sqlite-wasm/opfs/worker";
 * serveDemoDbWorker();
 * ```
 *
 * Requests run one at a time, in arrival order. An `open` or `reset`
 * request with `progress: true` is answered with `{ id, progress }`
 * messages (throttled) before its result.
 */
export function serveDemoDbWorker(options: ServeDemoDbWorkerOptions = {}): void {
  const scope: WorkerScopeLike = options.scope ?? globalThis;
  let engine: Promise<DemoDbEngine> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const getEngine = (): Promise<DemoDbEngine> => {
    engine ??= (options.sqlite3 ?? loadSqlite3)().then((sqlite3) => new DemoDbEngine(sqlite3, options));
    return engine;
  };
  const progressOf = (request: WorkerRequest & { readonly progress?: boolean }): ((event: DemoDbProgressEvent) => void) | undefined =>
    request.progress === true
      ? (event) => { scope.postMessage({ id: request.id, progress: event } satisfies WorkerProgress); }
      : undefined;
  const run = async (request: WorkerRequest): Promise<unknown> => {
    const current = await getEngine();
    switch (request.op) {
      case "open": return current.open(request.pin, request.options, progressOf(request));
      case "exec": return current.exec(request.sql, request.binds);
      case "reset": return current.reset(progressOf(request));
      case "close": current.close(); return undefined;
    }
  };
  scope.addEventListener("message", (event) => {
    const request: unknown = event.data;
    if (!isRequest(request)) return;
    queue = queue.then(async () => {
      let response: WorkerResponse;
      try {
        response = { id: request.id, ok: true, value: await run(request) };
      } catch (error) {
        response = { id: request.id, ok: false, error: serializeError(error) };
      }
      scope.postMessage(response);
    });
  });
}
