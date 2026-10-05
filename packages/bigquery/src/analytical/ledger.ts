import { AnalyticalError, fail } from "./wire.js";
import type { Bounds, Execution, Observation, ReadPlan, Receipt, SchemaField } from "./protocol.js";
export interface Preview {
  readonly nonce: string;
  readonly plan: ReadPlan;
  readonly observation: Observation;
  readonly policyDigest: string;
  readonly execution: Execution;
  readonly bounds: Bounds;
  readonly estimatedBytes: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly approvalDigest: string;
}
export interface CursorState {
  version: 1;
  runId: string;
  job: NonNullable<Receipt["job"]>;
  planDigest: string;
  schemaDigest: string;
  principal: Execution["principal"];
  pageToken: string | null;
  pageSize: number;
  offset: number;
  pageDigest: string;
  ordinal: number;
  counters: Receipt["counters"];
  ledgerRef: string;
}
export interface RunRecord {
  receipt: Receipt;
  preview: Preview;
  activePrincipal: Execution["principal"];
  reservation: string;
  pageToken: string | null;
  nextToken: string | null;
  pageDigest: string;
  offset: number;
  pageOrdinal: number;
  pageDone: boolean;
  schema: readonly SchemaField[];
  seenTokens: string[];
  cursor: CursorState | null;
}
export interface LedgerState {
  version: 1;
  previews: Record<string, {
    preview: Preview;
    used: boolean;
  }>;
  runs: Record<string, RunRecord>;
}
/** Atomic synchronous mutators commit only on success; leases exclude concurrent
 * network/delivery operations on one run across every participating tab/client.
 * Implementations must persist the same session across deliberate Resume.
 */
export interface Ledger {
  update<T>(mutator: (state: LedgerState) => T): Promise<T>;
  withLease<T>(runId: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>;
}
const empty = (): LedgerState => ({
  version: 1, previews: Object.create(null) as LedgerState["previews"], runs: Object.create(null) as LedgerState["runs"]
});
/** Deterministic test-only ledger. Production callers must inject shared durable
 * storage; the client never creates a fallback or silently renews a session.
 */
export class MemoryLedger implements Ledger {
  #state = empty();
  readonly #leases = new Set<string>();
  public async update<T>(mutator: (state: LedgerState) => T): Promise<T> {
    const next = structuredClone(this.#state);
    const result = mutator(next);
    const returned = structuredClone(result);
    this.#state = next;
    return returned;
  }
  public async withLease<T>(runId: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (signal?.aborted || this.#leases.has(runId))
      fail("local_stopped");
    this.#leases.add(runId);
    try {
      return await operation();
    }
    finally {
      this.#leases.delete(runId);
    }
  }
}
/** Browser durable session storage: one explicitly chosen database/session name
 * shared by all tabs. IndexedDB serializes state updates; Web Locks own run
 * operations and release them automatically when their tab exits.
 */
export class IndexedDBLedger implements Ledger {
  readonly #database: Promise<IDBDatabase>;
  readonly #lockPrefix: string;
  public constructor(sessionName: string) {
    if (typeof sessionName !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionName) || !globalThis.indexedDB || !globalThis.navigator?.locks)
      fail("invalid_input");
    this.#lockPrefix = `dalgo-bigquery:${sessionName}:`;
    this.#database = new Promise((resolve, reject) => {
      const request = indexedDB.open(`dalgo-bigquery-${sessionName}`, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("session"); };
      request.onsuccess = () => { const database = request.result; database.onversionchange = () => database.close(); resolve(database); };
      request.onerror = () => reject(new AnalyticalError("invalid_input"));
      request.onblocked = () => reject(new AnalyticalError("invalid_input"));
    });
  }
  public async update<T>(mutator: (state: LedgerState) => T): Promise<T> {
    const database = await this.#database;
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction("session", "readwrite", {
        durability: "strict"
      });
      const store = transaction.objectStore("session");
      const request = store.get("state");
      let result: T;
      let failure: unknown;
      request.onsuccess = () => { try {
        const state = (request.result ?? empty()) as LedgerState;
        if (state.version !== 1 || !state.runs || !state.previews)
          fail("invalid_input");
        result = structuredClone(mutator(state));
        store.put(state, "state");
      }
      catch (error) {
        failure = error;
        transaction.abort();
      } };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure ?? new AnalyticalError("invalid_input"));
      transaction.onerror = () => reject(failure ?? new AnalyticalError("invalid_input"));
    });
  }
  public async withLease<T>(runId: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (signal?.aborted || !/^[0-9a-f]{48}$/u.test(runId))
      fail("local_stopped");
    return navigator.locks.request(this.#lockPrefix + runId, {
      ifAvailable: true
    }, async (lock) => { if (lock === null || signal?.aborted)
      fail("local_stopped"); return operation(); });
  }
}
export function opaqueID(): string { const bytes = crypto.getRandomValues(new Uint8Array(24)); return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(""); }
