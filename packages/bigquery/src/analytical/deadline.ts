import { fail } from "./wire.js";

/** Millisecond timestamps from the trusted run ledger. This never starts a run.
 * Only explicit status/cancel use control=true; cumulative bytes stay charged.
 */
export interface DeadlineInput {
  readonly now: number;
  readonly executionDeadline: number;
  readonly callerDeadline?: number;
  readonly httpLimitMs: number;
  readonly control: boolean;
  readonly bytesRemaining: bigint;
}

export function operationDeadline(input: DeadlineInput): number {
  const { now, executionDeadline, callerDeadline, httpLimitMs, control, bytesRemaining } = input;
  if (typeof bytesRemaining !== "bigint") fail("invalid_input");
  if (bytesRemaining <= 0n) fail("response_limit");
  if (![now, executionDeadline, httpLimitMs, ...(callerDeadline === undefined ? [] : [callerDeadline])].every(Number.isSafeInteger)
    || httpLimitMs <= 0 || httpLimitMs > 15000 || typeof control !== "boolean"
    || !Number.isSafeInteger(now + httpLimitMs)) fail("invalid_input");
  let deadline = now + httpLimitMs;
  if (!control) {
    if (now >= executionDeadline) fail("local_stopped");
    deadline = Math.min(deadline, executionDeadline);
  }
  if (callerDeadline !== undefined) deadline = Math.min(deadline, callerDeadline);
  if (now >= deadline) fail("local_stopped");
  return deadline;
}
