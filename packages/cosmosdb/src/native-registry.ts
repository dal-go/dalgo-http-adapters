import type { NativeBudget, NativeLimits, NativeOperation } from "./native-operation.js";
import { nativeBytes } from "./native-transport.js";
import { nativeOpaqueHandle, NativeCosmosError, type NativeCosmosCursor, type NativeCosmosSession } from "./native-types.js";

export interface NativeJourney {
  readonly scope: string;
  readonly partition: string;
  readonly expires: number;
  readonly budget: NativeBudget;
  readonly seenIds: ReadonlySet<string>;
  readonly seenTokens: ReadonlySet<string>;
  readonly continuation: string;
  readonly fingerprint: string;
  readonly sessionToken?: string;
}
interface CursorEntry { readonly kind: "cursor"; readonly state: NativeJourney; busy: boolean }
export interface NativeSessionState {
  readonly kind: "session"; readonly partition: string; readonly token: string; readonly fingerprint: string; readonly expires: number;
}
type Entry = CursorEntry | NativeSessionState;
type Handle = NativeCosmosCursor | NativeCosmosSession;
export interface NativeRegistration { readonly handle: Handle; readonly entry: Entry }

function cost(entry: Entry): { bytes: number; nodes: number } {
  if (entry.kind === "session") return { bytes: 256 + nativeBytes(entry.partition) + nativeBytes(entry.token) + 64, nodes: 8 };
  const state = entry.state; let bytes = 512 + 128 + nativeBytes(state.partition) + nativeBytes(state.continuation) + nativeBytes(state.sessionToken ?? "");
  let nodes = 16;
  for (const id of state.seenIds) { bytes += 32 + nativeBytes(id); nodes++; }
  for (const token of state.seenTokens) { bytes += 32 + nativeBytes(token); nodes++; }
  return { bytes, nodes };
}
/** Logical retention quota, not an exact JavaScript heap measurement. */
export class NativeRegistry {
  readonly #entries = new Map<Handle, Entry>();
  readonly #limits: NativeLimits;
  #bytes = 0;
  #nodes = 0;
  public constructor(limits: NativeLimits) { this.#limits = limits; }
  private drop(handle: Handle, entry: Entry): void {
    if (this.#entries.get(handle) !== entry) return;
    const size = cost(entry); this.#bytes -= size.bytes; this.#nodes -= size.nodes; this.#entries.delete(handle);
  }
  private prune(): void {
    const now = performance.now();
    for (const [handle, entry] of this.#entries) {
      const expires = entry.kind === "session" ? entry.expires : entry.state.expires;
      if (now >= expires && !(entry.kind === "cursor" && entry.busy)) this.drop(handle, entry);
    }
  }
  public close(): void { this.#entries.clear(); this.#bytes = 0; this.#nodes = 0; }
  public session(handle: NativeCosmosSession | undefined, partition: string): NativeSessionState | undefined {
    if (handle === undefined) return undefined;
    this.prune(); const entry = this.#entries.get(handle);
    if (entry?.kind !== "session" || entry.partition !== partition) throw new NativeCosmosError("session");
    return entry;
  }
  public cursor(handle: NativeCosmosCursor | undefined, scope: string, op: NativeOperation): NativeJourney | undefined {
    if (handle === undefined) return undefined;
    this.prune(); const entry = this.#entries.get(handle);
    if (entry?.kind !== "cursor" || entry.state.scope !== scope) throw new NativeCosmosError("cursor");
    if (entry.busy) throw new NativeCosmosError("busy");
    op.restrictDeadline(entry.state.expires);
    entry.busy = true;
    // A locally rejected operation cannot reopen this cursor until ignored work
    // has actually settled. No public provider callback runs from this hook.
    op.afterSettled(() => { entry.busy = false; });
    return entry.state;
  }
  public observeSession(token: string, partition: string, fingerprint: string): NativeRegistration {
    const handle: NativeCosmosSession = { [nativeOpaqueHandle]: "session" }; Object.freeze(handle);
    return { handle, entry: { kind: "session", partition, token, fingerprint, expires: performance.now() + this.#limits.cursorTtlMs } };
  }
  public successor(state: NativeJourney): NativeRegistration {
    const handle: NativeCosmosCursor = { [nativeOpaqueHandle]: "cursor" }; Object.freeze(handle);
    return { handle, entry: { kind: "cursor", state, busy: false } };
  }
  /** Atomic replacement: no mutation/consumption on a refused admission. */
  public commit(op: NativeOperation, oldHandle: NativeCosmosCursor | undefined, additions: readonly NativeRegistration[]): void {
    this.prune(); const old = oldHandle === undefined ? undefined : this.#entries.get(oldHandle);
    if (oldHandle !== undefined && (old?.kind !== "cursor" || !old.busy)) throw new NativeCosmosError("cursor");
    const removed = old === undefined ? { bytes: 0, nodes: 0 } : cost(old);
    let bytes = this.#bytes - removed.bytes; let nodes = this.#nodes - removed.nodes;
    const count = this.#entries.size - (old === undefined ? 0 : 1) + additions.length;
    for (const addition of additions) { const size = cost(addition.entry); bytes += size.bytes; nodes += size.nodes; }
    if (count > this.#limits.maxHandles || bytes > this.#limits.maxCursorBytes || nodes > this.#limits.maxCursorNodes) throw new NativeCosmosError("bounds");
    // Cleanup and all foreign work precede this final guard/ACK. The remaining
    // mutations use only adapter-owned Maps and immutable primitive snapshots.
    op.prepareDelivery(); op.check();
    if (old !== undefined && oldHandle !== undefined) this.drop(oldHandle, old);
    for (const addition of additions) this.#entries.set(addition.handle, addition.entry);
    this.#bytes = bytes; this.#nodes = nodes;
  }
}
