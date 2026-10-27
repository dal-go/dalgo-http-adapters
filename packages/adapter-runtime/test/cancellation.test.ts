import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QueryCancelledError,
  cancelQuietly,
  createAbortScope,
  isCancellableQueryExecutor,
  isQueryCancelledError,
  raceAbort,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createAbortScope", () => {
  it("reports a caller abort separately from the deadline and clears its timer", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const scope = createAbortScope(caller.signal, 1_000);
    expect(scope.signal.aborted).toBe(false);
    caller.abort(new Error("Bearer must not propagate"));
    expect(scope.signal.aborted).toBe(true);
    expect(scope.callerAborted).toBe(true);
    expect(scope.deadlineExceeded).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(scope.deadlineExceeded).toBe(false);
    scope.dispose();
  });

  it("reports the deadline when the adapter stops the request", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const scope = createAbortScope(caller.signal, 10);
    vi.advanceTimersByTime(10);
    expect(scope.signal.aborted).toBe(true);
    expect(scope.deadlineExceeded).toBe(true);
    expect(scope.callerAborted).toBe(false);
    scope.dispose();
  });

  it("removes its listener and timer on dispose without aborting the scope", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const scope = createAbortScope(caller.signal, 10);
    scope.dispose();
    caller.abort();
    vi.advanceTimersByTime(100);
    expect(scope.signal.aborted).toBe(false);
    expect(scope.deadlineExceeded).toBe(false);
    expect(scope.callerAborted).toBe(false);
  });

  it("immediately reflects an already-aborted caller signal", () => {
    const caller = new AbortController();
    caller.abort(new Error("secret reason"));
    const scope = createAbortScope(caller.signal, 10);
    expect(scope.signal.aborted).toBe(true);
    expect(scope.callerAborted).toBe(true);
    expect(scope.deadlineExceeded).toBe(false);
    scope.dispose();
  });

  it("rejects an invalid deadline", () => {
    expect(() => createAbortScope(undefined, 0)).toThrow(RangeError);
    expect(() => createAbortScope(undefined, 1.5)).toThrow(RangeError);
  });
});

describe("raceAbort", () => {
  it("rejects immediately for a pre-aborted signal and handles a late promise", async () => {
    const caller = new AbortController();
    caller.abort();
    let settle: ((value: string) => void) | undefined;
    const pending = new Promise<string>((resolve) => {
      settle = resolve;
    });
    await expect(
      raceAbort(pending, caller.signal, () => new QueryCancelledError("caller")),
    ).rejects.toBeInstanceOf(QueryCancelledError);
    settle?.("late");
    await Promise.resolve();
  });

  it("rejects on abort and never lets a late resolution escape", async () => {
    const caller = new AbortController();
    let settle: ((value: string) => void) | undefined;
    const pending = new Promise<string>((resolve) => {
      settle = resolve;
    });
    const result = raceAbort(
      pending,
      caller.signal,
      () => new QueryCancelledError("caller"),
    );
    caller.abort();
    await expect(result).rejects.toMatchObject({ reason: "caller" });
    settle?.("late");
    await Promise.resolve();
  });

  it("passes through a rejection that arrives before the abort", async () => {
    const caller = new AbortController();
    const failure = new Error("transport detail");
    await expect(
      raceAbort(
        Promise.reject(failure),
        caller.signal,
        () => new QueryCancelledError("deadline"),
      ),
    ).rejects.toBe(failure);
  });
});

describe("cancelQuietly", () => {
  it("never awaits a hostile cancellation", () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    expect(() => {
      cancelQuietly({ cancel });
    }).not.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("swallows a synchronously throwing cancellation", () => {
    expect(() => {
      cancelQuietly({
        cancel: () => {
          throw new Error("secret cancellation failure");
        },
      });
    }).not.toThrow();
  });

  it("ignores an absent resource", () => {
    expect(() => {
      cancelQuietly(undefined);
      cancelQuietly(null);
    }).not.toThrow();
  });
});

describe("cancellable contract", () => {
  it("builds a redacted cancellation error without a cause or caller reason", () => {
    const error = new QueryCancelledError("caller");
    expect(error.name).toBe("QueryCancelledError");
    expect(error.message).toBe("query cancelled by caller");
    expect(error.reason).toBe("caller");
    expect(error.cause).toBeUndefined();
    expect(isQueryCancelledError(error)).toBe(true);
    expect(new QueryCancelledError("deadline").message).toBe("query deadline exceeded");
  });

  it("narrows only values that expose queryWithSignal", () => {
    const executor = {
      queryWithSignal: () => Promise.resolve({ records: [] }),
    };
    expect(isCancellableQueryExecutor(executor)).toBe(true);
    expect(isCancellableQueryExecutor({ query: () => Promise.resolve() })).toBe(false);
    expect(isCancellableQueryExecutor(null)).toBe(false);
    expect(isCancellableQueryExecutor("queryWithSignal")).toBe(false);
  });
});
