/** The part of the Web Locks API (`navigator.locks`) leader election uses. */
export interface LockManagerLike {
  request(name: string, options: { readonly mode: "exclusive"; readonly signal: AbortSignal }, callback: (lock: unknown) => Promise<void>): Promise<unknown>;
}

/** `idle`: not taking part; `waiting`: queued for the lock (a follower); `leader`: holds it. */
export type ElectionState = "idle" | "waiting" | "leader";

export interface ElectionHandlers {
  /** The lock was granted. A rejection releases the lock and is reported to `onError`. */
  onAcquired(): void | Promise<void>;
  /** Leadership ended (released by this tab, or `onAcquired` failed). */
  onReleased?(): void;
  onError?(error: unknown): void;
}

/** `navigator.locks`, when this context has the Web Locks API. */
export function defaultLocks(): LockManagerLike | undefined {
  return (globalThis as { readonly navigator?: { readonly locks?: LockManagerLike } }).navigator?.locks;
}

/**
 * Picks one leader per lock name with an exclusive Web Lock. A tab that calls
 * `start()` queues for the lock; the browser grants it to one tab at a time and
 * releases it automatically when that tab closes, crashes or navigates away,
 * so the next queued tab takes over. Without Web Locks every tab leads.
 */
export class LeaderElection {
  readonly #locks: LockManagerLike | undefined;
  readonly #name: string;
  readonly #handlers: ElectionHandlers;
  #state: ElectionState = "idle";
  #round: { readonly abort: AbortController; release: () => void } | undefined;

  public constructor(locks: LockManagerLike | undefined, name: string, handlers: ElectionHandlers) {
    this.#locks = locks;
    this.#name = name;
    this.#handlers = handlers;
  }

  public get state(): ElectionState { return this.#state; }

  /** Queues for leadership. No effect unless idle. */
  public start(): void {
    if (this.#state !== "idle") return;
    this.#state = "waiting";
    const abort = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const round = { abort, release };
    this.#round = round;
    const lead = async (): Promise<void> => {
      if (this.#round !== round) return; // released before the lock was granted
      this.#state = "leader";
      try {
        await this.#handlers.onAcquired();
      } catch (error) {
        this.#end(round);
        this.#handlers.onError?.(error);
        return;
      }
      await held;
    };
    if (this.#locks === undefined) {
      void lead();
      return;
    }
    this.#locks.request(this.#name, { mode: "exclusive", signal: abort.signal }, lead).catch((error: unknown) => {
      if (this.#round !== round) return; // aborted by release()
      this.#end(round);
      this.#handlers.onError?.(error);
    });
  }

  #end(round: { readonly abort: AbortController; release: () => void }): void {
    if (this.#round !== round) return;
    const wasLeader = this.#state === "leader";
    this.#round = undefined;
    this.#state = "idle";
    round.abort.abort();
    round.release();
    if (wasLeader) this.#handlers.onReleased?.();
  }

  /** Gives up the lock, or stops waiting for it. Call `start()` to queue again. */
  public release(): void {
    if (this.#round !== undefined) this.#end(this.#round);
  }
}
