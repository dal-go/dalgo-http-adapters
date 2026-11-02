import type { Key } from "@dalgo/core";
import type { CouchDbOperation } from "./operation.js";

/** Caller already copied/admitted the keys; one scope charges every worker. */
export async function readBatch<T>(keys: readonly Key[], parallel: number, op: CouchDbOperation, read: (key: Key) => Promise<T>): Promise<readonly T[]> {
  const results: T[] = new Array(keys.length);
  let next = 0;
  let failure: { readonly error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure !== undefined || op.stopped) return;
      const key = keys[next]; const index = next++;
      if (key === undefined) return;
      try { const value = await read(key); op.check(); results[index] = value; }
      catch (error: unknown) { if (failure === undefined) { failure = { error }; op.fail(); } return; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, keys.length) }, () => worker()));
  op.checkCancellation();
  if (failure !== undefined) throw failure.error;
  op.check(); return results;
}
