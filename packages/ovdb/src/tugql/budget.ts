/** Local monotonic accounting; never serialize or reset this view between stages. */
export interface OpenVaultDbExecutionBudget {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}
export interface OpenVaultDbExecutionOwner {
  readonly budget: OpenVaultDbExecutionBudget;
  cancel(): void;
  dispose(): void;
}
// Weak keys retain no execution-ID history once the owner view is unreachable.
const executionIds = new WeakMap<OpenVaultDbExecutionBudget, string>();
const owned = new WeakSet<OpenVaultDbExecutionBudget>();
const timeout = (): DOMException => new DOMException("OpenVaultDB execution deadline exceeded", "TimeoutError");
const cancelled = (): DOMException => new DOMException("OpenVaultDB execution cancelled", "AbortError");

/** Create before admission and dispose only after the final guarded output handoff. */
export function createOpenVaultDbExecutionBudget(): OpenVaultDbExecutionOwner {
  const controller = new AbortController();
  const budget = Object.freeze({ signal: controller.signal, deadlineAt: performance.now() + 10_000 });
  owned.add(budget);
  const timer = setTimeout(() => { controller.abort(timeout()); }, 10_000);
  const cancel = (): void => { controller.abort(cancelled()); };
  return Object.freeze({ budget, cancel, dispose(): void { cancel(); clearTimeout(timer); } });
}
export function assertOpenVaultDbExecutionBudget(budget: OpenVaultDbExecutionBudget): void {
  if (!owned.has(budget)) throw new TypeError("unbound OpenVaultDB execution budget");
  if (performance.now() >= budget.deadlineAt) throw timeout();
  if (budget.signal.aborted) throw cancelled();
}
/** Race an owned await using remaining time, preserving the owner's signal and deadline. */
export async function raceOpenVaultDbExecutionBudget<T>(
  budget: OpenVaultDbExecutionBudget, operation: PromiseLike<T>,
): Promise<T> {
  assertOpenVaultDbExecutionBudget(budget);
  let rejectWait: ((reason: unknown) => void) | undefined;
  const wait = new Promise<never>((_resolve, reject) => { rejectWait = reject; });
  const abort = (): void => { rejectWait?.(performance.now() >= budget.deadlineAt ? timeout() : cancelled()); };
  budget.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { rejectWait?.(timeout()); }, Math.ceil(Math.max(0, budget.deadlineAt - performance.now())));
  try {
    assertOpenVaultDbExecutionBudget(budget);
    const value = await Promise.race([operation, wait]);
    assertOpenVaultDbExecutionBudget(budget);
    return value;
  } finally {
    clearTimeout(timer);
    budget.signal.removeEventListener("abort", abort);
  }
}
export function createOpenVaultDbExecutionId(budget: OpenVaultDbExecutionBudget): string {
  assertOpenVaultDbExecutionBudget(budget);
  if (executionIds.has(budget)) throw new TypeError("OpenVaultDB execution ID already issued");
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  executionIds.set(budget, id);
  return id;
}
export function assertOpenVaultDbExecutionId(budget: OpenVaultDbExecutionBudget, id: string): void {
  assertOpenVaultDbExecutionBudget(budget);
  if (executionIds.get(budget) !== id) throw new TypeError("unbound OpenVaultDB execution ID");
}
