import type { Resettable } from "@dalgo/core";
import { createSqliteDatabase, type SqliteDatabase } from "../database.js";
import type { SqliteDriver, SqliteExecResult } from "../driver.js";
import type { CanonicalPin } from "./canonical.js";
import type { OpenReport } from "./engine.js";
import { reviveError, type WorkerRequest, type WorkerResponse } from "./protocol.js";
import type { ResetResult } from "./reset.js";

/** The parts of a `Worker` the leader uses. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: Event) => void): void;
  terminate(): void;
}

/** The dataset worker stopped (terminated, crashed, or the leader stepped down). Retry the request. */
export class WorkerUnavailableError extends Error {
  public readonly code = "worker_unavailable" as const;
  public readonly retriable = true as const;

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerUnavailableError";
  }
}

type Operation = WorkerRequest extends infer R ? R extends { readonly op: infer O } ? O : never : never;
type Payload<O extends Operation> = Omit<Extract<WorkerRequest, { readonly op: O }>, "id" | "op">;

/** Request/response calls to a dataset worker. A worker failure rejects every pending call. */
export class WorkerClient {
  readonly #worker: WorkerLike;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #nextId = 0;
  #failure: Error | undefined;
  /** Called once when the worker fails or is terminated. */
  public onFailure: ((error: Error) => void) | undefined;

  public constructor(worker: WorkerLike) {
    this.#worker = worker;
    worker.addEventListener("message", (event) => {
      const response = (event as MessageEvent).data as WorkerResponse;
      const waiter = this.#pending.get(response.id);
      if (waiter === undefined) return;
      this.#pending.delete(response.id);
      if (response.ok) waiter.resolve(response.value);
      else waiter.reject(reviveError(response.error));
    });
    const fail = (event: Event): void => {
      const message = (event as ErrorEvent).message;
      this.#fail(new WorkerUnavailableError(`dataset worker failed${typeof message === "string" && message !== "" ? `: ${message}` : ""}`));
    };
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
  }

  #fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#worker.terminate();
    for (const waiter of this.#pending.values()) waiter.reject(error);
    this.#pending.clear();
    this.onFailure?.(error);
  }

  public call<O extends Operation>(op: O, payload: Payload<O>): Promise<unknown> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    this.#nextId += 1;
    const id = this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...payload, id, op });
    });
  }

  /** Stops the worker; pending and later calls fail with {@link WorkerUnavailableError}. */
  public terminate(reason = "the dataset worker was stopped"): void {
    this.#fail(new WorkerUnavailableError(reason));
  }
}

/** The result of `navigator.storage.persist()` on the first write. */
export type PersistenceResult = "granted" | "denied" | "unavailable";

/** The dataset, opened by the leader tab. */
export interface LeaderDatabase {
  readonly database: SqliteDatabase & Resettable;
  readonly report: OpenReport;
  /** Resets the dataset and reports the restored canonical version. */
  reset(): Promise<ResetResult>;
  /** Settles after the first write transaction asked for persistent storage; undefined before it. */
  persistence(): Promise<PersistenceResult> | undefined;
}

export type RequestPersistence = () => Promise<boolean>;

/** `navigator.storage.persist`, when this context has it (windows only). */
export function defaultRequestPersistence(): RequestPersistence | undefined {
  const storage = (globalThis as { readonly navigator?: { readonly storage?: { persist?: () => Promise<boolean> } } }).navigator?.storage;
  return typeof storage?.persist === "function" ? () => (storage.persist as () => Promise<boolean>).call(storage) : undefined;
}

export interface OpenLeaderDatabaseOptions {
  /** Asks for persistent storage on the first write. Default: `navigator.storage.persist`; `null` never asks. */
  readonly requestPersistence?: RequestPersistence | null | undefined;
}

/**
 * Opens the pinned dataset in the worker and wraps it as a DALgo database whose
 * statements run in the worker. Its `reset()` restores the pristine copy. The
 * first write transaction of a persistent dataset asks for persistent storage.
 */
export async function openLeaderDatabase(client: WorkerClient, pin: CanonicalPin, options: OpenLeaderDatabaseOptions = {}): Promise<LeaderDatabase> {
  const requestPersistence = options.requestPersistence === null ? undefined : options.requestPersistence ?? defaultRequestPersistence();
  const report = await client.call("open", { pin }) as OpenReport;
  let persistence: Promise<PersistenceResult> | undefined;
  const driver: SqliteDriver = {
    exec(sql, binds) {
      if (persistence === undefined && report.persistent && sql === "BEGIN IMMEDIATE") {
        persistence = requestPersistence === undefined
          ? Promise.resolve("unavailable")
          : requestPersistence().then((granted) => (granted ? "granted" : "denied"), () => "unavailable");
      }
      return client.call("exec", binds === undefined ? { sql } : { sql, binds }) as Promise<SqliteExecResult>;
    },
  };
  let lastReset: ResetResult = { canonical: report.canonical };
  const database = createSqliteDatabase(driver, {
    persistent: report.persistent,
    onReset: async () => {
      lastReset = await client.call("reset", {}) as ResetResult;
      return undefined;
    },
  });
  return {
    database,
    report,
    reset: async () => {
      await database.reset();
      return lastReset;
    },
    persistence: () => persistence,
  };
}
