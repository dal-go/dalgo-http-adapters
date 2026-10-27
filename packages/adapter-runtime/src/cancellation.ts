/** One combined caller-abort and adapter-deadline scope for a single request. */
export interface AbortScope {
  /** Aborted when the caller aborts or the deadline elapses. */
  readonly signal: AbortSignal;
  /** True when the caller signal fired before the deadline. */
  readonly callerAborted: boolean;
  /** True when the adapter deadline elapsed. */
  readonly deadlineExceeded: boolean;
  /** Removes the caller listener and clears the timer. Never aborts the scope. */
  dispose(): void;
}

/**
 * Combines an optional caller signal with one end-to-end deadline.
 *
 * The timer starts immediately, so it covers header acquisition, fetch and
 * response-body reads. Cancellation reasons are never read or forwarded.
 */
export function createAbortScope(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortScope {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  const controller = new AbortController();
  let deadlineExceeded = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onCallerAbort = (): void => {
    if (disposed) return;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    controller.abort();
  };
  if (callerSignal?.aborted === true) {
    controller.abort();
  } else {
    timer = setTimeout(() => {
      if (disposed) return;
      deadlineExceeded = true;
      controller.abort();
    }, timeoutMs);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  return {
    signal: controller.signal,
    get callerAborted(): boolean {
      return callerSignal?.aborted === true && controller.signal.aborted && !deadlineExceeded;
    },
    get deadlineExceeded(): boolean {
      return deadlineExceeded;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/**
 * Resolves or rejects with `promise`, unless `signal` aborts first. The late
 * promise always has a handler attached, so a hostile implementation cannot
 * cause an unhandled rejection after the caller has already moved on.
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  createError: () => Error,
): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(createError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(createError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The narrow structural part of a stream or reader that cleanup needs. */
export interface CancellableResource {
  cancel(reason?: unknown): Promise<void> | void;
}

/**
 * Best-effort cancellation that never waits. A stream implementation is allowed
 * to return a promise that never settles, so awaiting `cancel()` could keep the
 * original caller blocked forever.
 */
export function cancelQuietly(
  resource: CancellableResource | null | undefined,
): void {
  if (resource === null || resource === undefined) return;
  try {
    void Promise.resolve(resource.cancel()).catch(() => undefined);
  } catch {
    // A throwing cancel implementation must not replace the original failure.
  }
}
