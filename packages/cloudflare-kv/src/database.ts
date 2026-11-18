import { CloudflareKvError, type KvEntry, type KvListPage, type KvListRequest, type KvOptions, type KvReader } from "./types.js";
import { Manager, type Budget, type Operation } from "./operation.js";
import { compareUtf8, copiedArray, encoder, keyInfo, nativeKey, only, permitted, prefixes, utf8 } from "./validation.js";
import { KvCoreDatabase } from "./core.js";

export interface Authority { readonly fingerprint: string; readonly token?: string }
export interface RawList { readonly keys: readonly unknown[]; readonly complete: boolean; readonly cursor: string }
export interface Backend {
  readonly kind: "binding" | "rest";
  close?(): void;
  admitKeys?(keys: readonly string[], operation: Operation): void;
  checkCursor?(prefix: string, limit: number, cursor: string, operation: Operation): void;
  authorize(operation: Operation): Promise<Authority>;
  get(key: string, operation: Operation, authority: Authority): Promise<KvEntry | null>;
  list(prefix: string, limit: number, cursor: string, operation: Operation, authority: Authority): Promise<RawList>;
}
interface CursorState {
  readonly binding: string; readonly authority: string; readonly token: string; readonly expires: number;
  readonly budget: Budget; readonly keys: ReadonlySet<string>; readonly tokens: ReadonlySet<string>;
  readonly bytes: number; readonly nodes: number; busy: boolean;
}
function handle(): string { const bytes = crypto.getRandomValues(new Uint8Array(24)); return Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join(""); }
async function fingerprint(value: string, operation: Operation): Promise<string> {
  const digest = await operation.foreign(() => crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}

/** Native original keys/bytes; no DALgo managed storage layout or SQL emulation. */
export class CloudflareKvDatabase implements KvReader {
  readonly #backend: Backend;
  readonly #manager: Manager;
  readonly #prefixes: readonly string[];
  readonly #cursors = new Map<string, CursorState>();
  #cursorBytes = 0;
  #cursorNodes = 0;
  protected constructor(backend: Backend, options: KvOptions) {
    this.#backend = backend; this.#manager = new Manager(options); this.#prefixes = prefixes(options);
  }
  public close(): void { this.#manager.close(); this.#backend.close?.(); this.#cursors.clear(); this.#cursorBytes = 0; this.#cursorNodes = 0; }
  public configuredMetadata(): { source: "configured"; prefixes: readonly string[]; transport: string; dynamicDiscovery: false } {
    return { source: "configured", prefixes: [...this.#prefixes], transport: this.#backend.kind, dynamicDiscovery: false };
  }
  public asDatabase(collection: string): KvCoreDatabase { return new KvCoreDatabase(this, collection); }
  public get(key: string, signal?: AbortSignal): Promise<KvEntry | null> {
    return this.mapRead(() => [key], (values) => values[0] ?? null, signal);
  }
  public getMany(keys: readonly string[], signal?: AbortSignal): Promise<readonly (KvEntry | null)[]> { return this.mapRead(() => keys, (values) => values, signal); }
  public testConnection(key: string, signal?: AbortSignal): Promise<void> { return this.mapRead(() => [key], () => undefined, signal); }
  public exists(key: string, signal?: AbortSignal): Promise<boolean> { return this.mapRead(() => [key], (values) => values[0] !== null && values[0] !== undefined, signal); }
  /** Shared scope includes core codecs/host response construction before delivery. */
  public async mapRead<T>(admit: (maximumKeys: number, check: () => void) => readonly string[], deliver: (values: readonly (KvEntry | null)[], check: () => void) => T | PromiseLike<T>, signal?: AbortSignal, parent?: Operation): Promise<T> {
    const operation = this.#manager.begin(signal, parent);
    try {
      const keys = copiedArray(admit(operation.limits.maxKeys, () => { operation.check(); }), operation.limits.maxKeys).map((value) => { const key = nativeKey(value); permitted(key, this.#prefixes); return key; });
      operation.check(); operation.rows(keys.length);
      this.#backend.admitKeys?.(keys, operation);
      const authority = keys.length === 0 ? undefined : await this.#backend.authorize(operation);
      const result: (KvEntry | null)[] = [];
      for (const key of keys) {
        operation.check();
        if (authority === undefined) throw new CloudflareKvError("protocol");
        result.push(await this.#backend.get(key, operation, authority));
      }
      operation.check(); const value = await operation.foreign(() => deliver(result, () => { operation.check(); })); operation.prepareDelivery(); return value;
    } catch (error) { throw operation.failure(error); }
    finally { operation.finish(); }
  }
  public list(request: KvListRequest, signal?: AbortSignal): Promise<KvListPage> { return this.mapList(request, (page) => page, signal); }
  private retire(token: string, state: CursorState): void {
    if (this.#cursors.get(token) !== state) return;
    this.#cursors.delete(token); this.#cursorBytes -= state.bytes; this.#cursorNodes -= state.nodes;
  }
  private prune(): void { for (const [token, state] of this.#cursors) if (!state.busy && performance.now() >= state.expires) this.retire(token, state); }
  /** Response factories execute before the single cursor acknowledgement. */
  public async mapList<T>(request: KvListRequest, deliver: (page: KvListPage, check: () => void) => T | PromiseLike<T>, signal?: AbortSignal, parent?: Operation): Promise<T> {
    const operation = this.#manager.begin(signal, parent);
    let prior: CursorState | undefined;
    try {
      const descriptor = only(request, ["prefix", "limit", "cursor"]);
      const prefix = utf8(descriptor.prefix, 512, true); permitted(prefix, this.#prefixes);
      const limit = descriptor.limit ?? 100;
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < (this.#backend.kind === "rest" ? 10 : 1) || limit > 1000 || limit > operation.limits.maxRows) throw new CloudflareKvError("bounds");
      const incoming = descriptor.cursor;
      if (incoming !== undefined && (typeof incoming !== "string" || !/^[0-9a-f]{48}$/u.test(incoming))) throw new CloudflareKvError("input");
      const binding = await fingerprint(JSON.stringify(["kv-list-v1", this.#backend.kind, prefix, limit]), operation);
      this.prune();
      if (typeof incoming === "string") {
        prior = this.#cursors.get(incoming);
        if (prior?.binding !== binding || performance.now() >= prior.expires) throw new CloudflareKvError("input");
        if (prior.busy) throw new CloudflareKvError("busy");
        prior.busy = true; operation.budget = prior.budget;
        const held = prior; operation.afterSettled(() => { held.busy = false; this.prune(); });
      }
      const expires = prior?.expires ?? performance.now() + operation.limits.cursorTtlMs;
      this.#backend.checkCursor?.(prefix, limit, prior?.token ?? "", operation);
      if (operation.budget.failed || operation.budget.bytes >= operation.limits.maxResponseBytes || operation.budget.requests >= operation.limits.maxRequests || operation.budget.pages >= operation.limits.maxPages || operation.budget.rows + limit > operation.limits.maxRows) throw new CloudflareKvError("bounds");
      const authority = await this.#backend.authorize(operation);
      if (prior !== undefined && prior.authority !== authority.fingerprint) throw new CloudflareKvError("input");
      if (performance.now() >= expires) throw new CloudflareKvError("bounds");
      if (++operation.budget.pages > operation.limits.maxPages || operation.budget.rows + limit > operation.limits.maxRows) throw new CloudflareKvError("bounds");
      const raw = await this.#backend.list(prefix, limit, prior?.token ?? "", operation, authority);
      operation.check(); if (performance.now() >= expires) throw new CloudflareKvError("bounds");
      const keys = copiedArray(raw.keys, limit).map((value) => keyInfo(value, () => { operation.check(); }));
      operation.rows(keys.length);
      const seen = new Set(prior?.keys);
      // Sets retain insertion order. Derive the last ACKed key from the already
      // quota-charged journal; empty pages do not reset this source boundary.
      let previous: string | undefined;
      for (const acknowledged of prior?.keys ?? []) previous = acknowledged;
      for (const key of keys) {
        permitted(key.name, [prefix]);
        if (seen.has(key.name) || (previous !== undefined && compareUtf8(previous, key.name) >= 0)) throw new CloudflareKvError("protocol");
        seen.add(key.name); previous = key.name;
      }
      const tokens = new Set(prior?.tokens);
      if (!raw.complete && (raw.cursor === "" || tokens.has(raw.cursor))) throw new CloudflareKvError("protocol");
      const nextHandle = raw.complete ? undefined : handle();
      let next: CursorState | undefined;
      if (nextHandle !== undefined) {
        const token = utf8(raw.cursor, 16_384); tokens.add(token);
        this.#backend.checkCursor?.(prefix, limit, token, operation);
        let bytes = 512 + nextHandle.length + binding.length + authority.fingerprint.length + encoder.encode(token).byteLength;
        for (const key of seen) bytes += 64 + encoder.encode(key).byteLength;
        for (const item of tokens) bytes += 64 + encoder.encode(item).byteLength;
        next = { binding, authority: authority.fingerprint, token, expires, budget: operation.budget, keys: seen, tokens, bytes, nodes: 6 + seen.size + tokens.size, busy: false };
      }
      const page: KvListPage = { keys, complete: raw.complete, ...(nextHandle === undefined ? {} : { nextCursor: nextHandle }) };
      operation.check(); const value = await operation.foreign(() => deliver(page, () => { operation.check(); })); operation.prepareDelivery();
      this.prune();
      if (performance.now() >= expires) throw new CloudflareKvError("bounds");
      if (prior !== undefined && (typeof incoming !== "string" || this.#cursors.get(incoming) !== prior)) throw new CloudflareKvError("input");
      if (next !== undefined && (this.#cursorBytes - (prior?.bytes ?? 0) + next.bytes > operation.limits.maxCursorBytes || this.#cursorNodes - (prior?.nodes ?? 0) + next.nodes > operation.limits.maxCursorNodes || (prior === undefined && this.#cursors.size >= operation.limits.maxCursors))) throw new CloudflareKvError("bounds");
      operation.check();
      if (prior !== undefined && typeof incoming === "string") this.retire(incoming, prior);
      if (next !== undefined && nextHandle !== undefined) { this.#cursors.set(nextHandle, next); this.#cursorBytes += next.bytes; this.#cursorNodes += next.nodes; }
      return value;
    } catch (error) { throw operation.failure(error); }
    finally { operation.finish(); }
  }
}
