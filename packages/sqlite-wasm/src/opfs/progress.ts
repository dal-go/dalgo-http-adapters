/**
 * What the dataset worker is doing while it opens or resets a dataset, in
 * this order (phases that are not needed are skipped):
 *
 * - `fetch`: downloading the canonical file (`loaded`/`total` bytes, see {@link DemoDbProgressEvent})
 * - `verify`: checking sizes and SHA-256 (and decoding gzip)
 * - `importPristine`: writing the pristine copy to OPFS (`total` bytes)
 * - `importWorking`: writing the working copy to OPFS (`total` bytes)
 * - `open`: opening the working copy and running `PRAGMA quick_check`
 */
export type DemoDbProgressPhase = "fetch" | "verify" | "importPristine" | "importWorking" | "open";

/**
 * One progress report. Structured-clone safe: it crosses the worker boundary.
 *
 * During `fetch`, `loaded` counts the bytes read from the response bodies,
 * after the browser has undone any HTTP `Content-Encoding`. `total` is the
 * number of bytes to read when it is known: the sum of the parts' `bytes`
 * for a pin with `parts`; the pin's `bytes` (the decoded size) for a single
 * uncompressed file; for a single `compression: "gzip"` file, the response's
 * `Content-Length` when the response has no `Content-Encoding` (a
 * `Content-Length` that turns out smaller than the body is dropped).
 * Otherwise `total` is absent. During `importPristine` and `importWorking`,
 * `total` is the size of the file being written.
 */
export interface DemoDbProgressEvent {
  readonly phase: DemoDbProgressPhase;
  readonly loaded?: number;
  readonly total?: number;
}

export type DemoDbProgressListener = (event: DemoDbProgressEvent) => void;

/** Reports progress; `force` bypasses the throttle (for the last event of a download). */
export type ProgressReporter = (event: DemoDbProgressEvent, force?: boolean) => void;

export interface ThrottleOptions {
  /** Minimum time between two events of the same phase. Default 100 ms. */
  readonly intervalMs?: number;
  readonly now?: () => number;
}

/**
 * Calls `listener` at most every `intervalMs` within a phase, and always on a
 * phase change or a forced event. A listener that throws is ignored: progress
 * never fails the operation it reports on.
 */
export function throttleProgress(listener: DemoDbProgressListener, options: ThrottleOptions = {}): ProgressReporter {
  const intervalMs = options.intervalMs ?? 100;
  const now = options.now ?? Date.now;
  let phase: DemoDbProgressPhase | undefined;
  let last = Number.NEGATIVE_INFINITY;
  return (event, force = false) => {
    const time = now();
    if (!force && event.phase === phase && time - last < intervalMs) return;
    phase = event.phase;
    last = time;
    try {
      listener(event);
    } catch {
      // A progress listener must not break the open or reset it observes.
    }
  };
}
