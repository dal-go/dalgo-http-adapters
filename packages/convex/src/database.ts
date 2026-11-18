import { Key, identityCodec, type Codec, type Database, type QueryPage, type ReadwriteTransaction, type RecordSnapshot, type StructuredQuery } from "@dalgo/core";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import type { Value } from "convex/values";
import { ConvexReadError, type ConvexCollection, type ConvexConfiguredMetadata, type ConvexDocument, type ConvexField, type ConvexNativePage, type ConvexOptions, type ConvexPageOptions, type ConvexQueryFunction } from "./types.js";
import { array, argumentName, copyValue, encoded, fail, fields, functionPath, name, plain, positive, unicode } from "./validation.js";
import { authorization, call, endpoint, journal, limits, Operation, type Journal, type Limits } from "./transport.js";

interface Collection {
  path: string; idArgument: string; idField: string; args: Record<string, Value>; fields: readonly ConvexField[];
}
interface QueryFunction {
  path: string; collection: string; arguments: Set<string>; args: Record<string, Value>;
}
interface Cursor {
  descriptor: string; fingerprint: string; native: string; budget: Journal; busy: boolean;
}
interface Result<T> { value: T; commit?: () => void; release?: () => void; }
interface AdmittedKey { collection: string; id: string; key: Key; }

function args(value: unknown, maximum: number, check: () => void): Record<string, Value> {
  const result = copyValue(value, maximum, check);
  if (!plain(result)) fail("invalid-input");
  for (const key of Object.keys(result)) argumentName(key);
  return result as Record<string, Value>;
}
function strings(value: unknown, maximum: number): string[] {
  return array(value, maximum).map(entry => { argumentName(entry); return entry; });
}
function document(value: unknown, idField: string): ConvexDocument {
  if (!plain(value) || typeof value[idField] !== "string") fail("protocol");
  return value as Record<string, Value>;
}
function nativeCursor(value: unknown, done: boolean): string {
  if (typeof value !== "string" || (!done && value.length < 1) || value.length > 8192) fail("protocol");
  unicode(value);
  return value;
}

/** Native public-query functions, not direct arbitrary table access or a DALgo envelope. */
export class ConvexDatabase implements Database {
  readonly #options: ConvexOptions;
  readonly #limits: Limits;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #collections = new Map<string, Collection>();
  readonly #queries = new Map<string, QueryFunction>();
  readonly #cursors = new Map<string, Cursor>();
  readonly #active = new Set<Operation>();
  #closed = false;

  public constructor(options: ConvexOptions) {
    try {
    const own = fields(options, ["endpoint", "token", "allowAnonymous", "collections", "queries", "fetch", "allowInsecureLoopbackHttp", "timeoutMs", "maxRows", "maxGetManyKeys", "maxPages", "maxResponseBytes", "maxRequestBytes", "maxTotalRequestBytes", "maxWorkRows", "maximumRowsRead", "maximumBytesRead", "maxConcurrent", "maxCursors", "cursorTtlMs"]);
    const copied = { ...own } as unknown as ConvexOptions;
    if (typeof copied.endpoint !== "string" || copied.endpoint.length > 4096 || (copied.token !== undefined && typeof copied.token !== "string" && typeof copied.token !== "function")
      || (copied.token === undefined && copied.allowAnonymous !== true) || (copied.fetch !== undefined && typeof copied.fetch !== "function")
      || (copied.allowAnonymous !== undefined && typeof copied.allowAnonymous !== "boolean") || (copied.allowInsecureLoopbackHttp !== undefined && typeof copied.allowInsecureLoopbackHttp !== "boolean")) fail("invalid-input");
    this.#limits = limits(copied);
    this.#endpoint = endpoint(copied);
    this.#options = { ...copied };
    this.#fetch = copied.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const collections = fields(copied.collections);
    if (Object.keys(collections).length < 1 || Object.keys(collections).length > 128) fail("invalid-input");
    for (const [alias, value] of Object.entries(collections)) {
      name(alias);
      const binding = fields(value, ["getFunction", "idArgument", "idField", "staticArgs", "fields"]) as unknown as ConvexCollection;
      functionPath(binding.getFunction);
      const idArgument = binding.idArgument ?? "id", idField = binding.idField ?? "_id";
      argumentName(idArgument);
      if (typeof idField !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(idField) || ["__proto__", "constructor", "prototype"].includes(idField)) fail("invalid-input");
      const fixed = args(binding.staticArgs ?? {}, this.#limits.maxRequestBytes, () => undefined);
      if (Object.hasOwn(fixed, idArgument)) fail("invalid-input");
      const metadata = array(binding.fields ?? [], 128).map(raw => {
        const field = fields(raw, ["name", "type", "nullable"]);
        if (typeof field.name !== "string" || field.name.length < 1 || field.name.length > 128 || typeof field.type !== "string" || field.type.length < 1 || field.type.length > 128 || (field.nullable !== undefined && typeof field.nullable !== "boolean")) fail("invalid-input");
        unicode(field.name); unicode(field.type);
        return Object.freeze({ name: field.name, type: field.type, ...(field.nullable === undefined ? {} : { nullable: field.nullable }) });
      });
      this.#collections.set(alias, { path: binding.getFunction, idArgument, idField, args: fixed, fields: Object.freeze(metadata) });
    }
    for (const [alias, value] of Object.entries(fields(copied.queries ?? {}))) {
      name(alias);
      const binding = fields(value, ["path", "collection", "arguments", "staticArgs"]) as unknown as ConvexQueryFunction;
      functionPath(binding.path);
      if (!this.#collections.has(binding.collection)) fail("invalid-input");
      const allowed = strings(binding.arguments ?? [], 128);
      if (new Set(allowed).size !== allowed.length) fail("invalid-input");
      const fixed = args(binding.staticArgs ?? {}, this.#limits.maxRequestBytes, () => undefined);
      if (allowed.some(key => Object.hasOwn(fixed, key))) fail("invalid-input");
      this.#queries.set(alias, { path: binding.path, collection: binding.collection, arguments: new Set(allowed), args: fixed });
    }
    } catch (error) {
      if (error instanceof ConvexReadError) throw error;
      throw new ConvexReadError("invalid-input");
    }
  }

  public metadata(): ConvexConfiguredMetadata {
    return Object.freeze({
      provenance: "trusted-configuration", dynamicDiscovery: false, authorizationVerified: false,
      collections: Object.freeze(Array.from(this.#collections, ([collection, binding]) => Object.freeze({ collection, idField: binding.idField, fields: binding.fields }))),
      queries: Object.freeze(Array.from(this.#queries, ([alias, binding]) => Object.freeze({ alias, collection: binding.collection }))),
    });
  }
  /** Stop only operation-owned signals/streams; never destroy a borrowed fetch. */
  public close(): void {
    this.#closed = true;
    for (const operation of this.#active) operation.stop();
    this.#cursors.clear();
  }
  public get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> { return this.readOne(key, codec); }
  public getWithSignal<T>(key: Key, signal: AbortSignal, codec?: Codec<T>): Promise<RecordSnapshot<T>> { return this.readOne(key, codec, signal); }
  public getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> { return this.read(keys, codec); }
  public getManyWithSignal<T>(keys: readonly Key[], signal: AbortSignal, codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> { return this.read(keys, codec, signal); }
  public exists(key: Key, signal?: AbortSignal): Promise<boolean> {
    return this.run(signal, async op => {
      const admitted = this.key(key), binding = this.binding(admitted.collection);
      const auth = await authorization(this.#options, op);
      const value = await this.rawGet(admitted, binding, auth.token, op, journal(this.#limits.cursorTtlMs));
      return { value: value !== null };
    });
  }
  public testConnection(key: Key, signal?: AbortSignal): Promise<void> {
    return this.run(signal, async op => {
      const admitted = this.key(key), binding = this.binding(admitted.collection);
      const auth = await authorization(this.#options, op);
      await this.rawGet(admitted, binding, auth.token, op, journal(this.#limits.cursorTtlMs));
      return { value: undefined };
    });
  }
  public query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>>;
  public query<T>(): Promise<QueryPage<T>> { return this.run<QueryPage<T>>(undefined, () => { return Promise.reject(new ConvexReadError("not-implemented")); }); }
  public queryWithSignal<T>(_query: StructuredQuery<T>, signal: AbortSignal): Promise<QueryPage<T>> { return this.run<QueryPage<T>>(signal, () => { return Promise.reject(new ConvexReadError("not-implemented")); }); }
  public runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result>;
  public runReadwriteTransaction<Result>(): Promise<Result> { return Promise.reject(new ConvexReadError("not-implemented")); }

  public queryFunction(alias: string, input: unknown = {}, options: ConvexPageOptions = {}): Promise<ConvexNativePage> {
    const started = performance.now();
    // Read closed option descriptors before inspecting an optional caller signal.
    let own: Record<string, unknown>;
    try { own = fields(options, ["pageSize", "cursor", "signal"]); } catch { return Promise.reject(new ConvexReadError("invalid-input")); }
    const signal = own.signal as AbortSignal | undefined;
    return this.run<ConvexNativePage>(signal, async op => {
      const binding = this.#queries.get(alias);
      if (binding === undefined) fail("not-implemented");
      const dynamic = args(input, this.#limits.maxRequestBytes, op.check);
      for (const key of Object.keys(dynamic)) if (!binding.arguments.has(key) || Object.hasOwn(binding.args, key)) fail("invalid-input");
      const fixed = args(binding.args, this.#limits.maxRequestBytes, op.check);
      const parameters = args({ ...fixed, ...dynamic }, this.#limits.maxRequestBytes, op.check);
      const pageSize = positive(own.pageSize, Math.min(100, this.#limits.maxRows), this.#limits.maxRows);
      const descriptor = JSON.stringify([alias, binding.path, binding.collection, encoded(parameters), pageSize]);
      const cursorId = own.cursor;
      if (cursorId !== undefined && (typeof cursorId !== "string" || cursorId.length > 128)) fail("cursor");
      this.expire();
      const previous = typeof cursorId === "string" ? this.#cursors.get(cursorId) : undefined;
      if (cursorId !== undefined && previous === undefined) fail("cursor");
      if (previous !== undefined && (previous.busy || previous.descriptor !== descriptor)) fail(previous.busy ? "busy" : "cursor");
      if (previous === undefined && this.#cursors.size >= this.#limits.maxCursors) fail("limit");
      const budget = previous?.budget ?? journal(this.#limits.cursorTtlMs);
      if (previous !== undefined) previous.busy = true;
      let prepared = false;
      try {
        const auth = await authorization(this.#options, op);
        if (previous !== undefined && previous.fingerprint !== auth.fingerprint) fail("cursor");
        if (performance.now() >= budget.expires) fail("cursor");
        op.check();
        if (pageSize > this.#limits.maxRows - budget.rows || budget.workRows >= this.#limits.maxWorkRows || budget.responseBytes >= this.#limits.maxResponseBytes) fail("limit");
        const workRows = Math.min(this.#limits.maximumRowsRead, this.#limits.maxWorkRows - budget.workRows);
        const paginationOpts: Record<string, Value> = {
          numItems: pageSize, cursor: previous?.native ?? null, maximumRowsRead: workRows,
          maximumBytesRead: Math.min(this.#limits.maximumBytesRead, this.#limits.maxResponseBytes - budget.responseBytes),
        };
        const result = await call(this.#endpoint, this.#fetch, binding.path, { ...parameters, paginationOpts }, auth.token, op, budget, this.#limits, workRows);
        const page = fields(result, ["page", "isDone", "continueCursor", "pageStatus", "splitCursor"]);
        if (page.pageStatus !== undefined && page.pageStatus !== null) fail("pagination-split-required");
        if (page.splitCursor !== undefined && page.splitCursor !== null) fail("pagination-split-required");
        if (typeof page.isDone !== "boolean") fail("protocol");
        const next = nativeCursor(page.continueCursor, page.isDone);
        const rows = array(page.page, Math.min(pageSize, this.#limits.maxRows - budget.rows));
        // Parsed rows count even when malformed or cancelled before delivery.
        budget.rows += rows.length;
        const ids: string[] = [];
        const collection = this.binding(binding.collection);
        const documents = rows.map(row => {
          const doc = document(row, collection.idField), id = doc[collection.idField];
          if (typeof id !== "string" || ids.includes(id) || budget.ids.has(id)) fail("protocol");
          ids.push(id); return doc;
        });
        if (!page.isDone && (budget.cursors.has(next) || next === previous?.native)) fail("cursor");
        let issued: string | undefined;
        if (!page.isDone) {
          op.check();
          issued = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0")).join("");
          if (this.#cursors.has(issued)) fail("limit");
        }
        const value: ConvexNativePage = { documents, isDone: page.isDone, ...(issued === undefined ? {} : { nextCursor: issued }) };
        const token = issued;
        prepared = true;
        return {
          value,
          release: (): void => { if (previous !== undefined) previous.busy = false; },
          commit: (): void => {
            const expired = performance.now() >= budget.expires;
            op.check();
            if (expired || (typeof cursorId === "string" && this.#cursors.get(cursorId) !== previous)) fail("cursor");
            if (token !== undefined && cursorId === undefined && this.#cursors.size >= this.#limits.maxCursors) fail("limit");
            // No callbacks or awaits after this delivery acknowledgement. An
            // aborted attempt never consumes the prior server position/IDs.
            for (const id of ids) budget.ids.add(id);
            budget.cursors.add(next);
            if (typeof cursorId === "string") this.#cursors.delete(cursorId);
            if (token !== undefined) this.#cursors.set(token, { descriptor, fingerprint: auth.fingerprint, native: next, budget, busy: false });
          },
        };
      } finally { if (!prepared && previous !== undefined) previous.busy = false; }
    }, started);
  }

  private binding(collection: string): Collection {
    const binding = this.#collections.get(collection);
    if (binding === undefined) fail("not-implemented");
    return binding;
  }
  private key(key: Key): AdmittedKey {
    const id = key.id, collection = key.collection, parent = key.parent;
    if (typeof id !== "string" || id.length > 8192 || parent !== undefined) fail("invalid-input");
    unicode(id); this.binding(collection);
    return { collection, id, key: new Key(collection, id) };
  }
  private async rawGet(key: AdmittedKey, binding: Collection, token: string | undefined, op: Operation, budget: Journal): Promise<ConvexDocument | null> {
    if (budget.rows >= this.#limits.maxRows) fail("limit");
    const value = await call(this.#endpoint, this.#fetch, binding.path, { ...args(binding.args, this.#limits.maxRequestBytes, op.check), [binding.idArgument]: key.id }, token, op, budget, this.#limits, 1);
    if (value === null) return null;
    budget.rows++;
    const doc = document(value, binding.idField);
    if (doc[binding.idField] !== key.id) fail("protocol");
    return doc;
  }
  private readOne<T>(key: Key, codec?: Codec<T>, signal?: AbortSignal): Promise<RecordSnapshot<T>> {
    return this.run<RecordSnapshot<T>>(signal, async op => {
      const admitted = this.key(key);
      const auth = await authorization(this.#options, op);
      const row = await this.rawGet(admitted, this.binding(admitted.collection), auth.token, op, journal(this.#limits.cursorTtlMs));
      const data = row === null ? undefined : ((codec ?? identityCodec) as Codec<T>).decode(row);
      op.check();
      const value: RecordSnapshot<T> = row === null ? { key: admitted.key, exists: false } : { key: admitted.key, exists: true, data: data as T };
      return { value };
    });
  }
  private read<T>(keys: readonly Key[], codec?: Codec<T>, signal?: AbortSignal): Promise<readonly RecordSnapshot<T>[]> {
    return this.run<readonly RecordSnapshot<T>[]>(signal, async op => {
      const admitted = array(keys, this.#limits.maxGetManyKeys).map(key => this.key(key as Key));
      op.check();
      const budget = journal(this.#limits.cursorTtlMs);
      const auth = admitted.length === 0 ? undefined : await authorization(this.#options, op);
      const records: RecordSnapshot<T>[] = [];
      for (const key of admitted) {
        op.check();
        const row = await this.rawGet(key, this.binding(key.collection), auth?.token, op, budget);
        if (row === null) records.push({ key: key.key, exists: false });
        else records.push({ key: key.key, exists: true, data: ((codec ?? identityCodec) as Codec<T>).decode(row) });
        op.check();
      }
      return { value: records };
    });
  }
  private expire(): void {
    const now = performance.now();
    for (const [id, cursor] of this.#cursors) if (!cursor.busy && now >= cursor.budget.expires) this.#cursors.delete(id);
  }
  private async run<T>(signal: AbortSignal | undefined, execute: (operation: Operation) => Promise<Result<T>>, started?: number): Promise<T> {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new ConvexReadError("invalid-input");
    let op: Operation;
    try { op = new Operation(signal, this.#limits.timeoutMs, started); } catch { throw new ConvexReadError("invalid-input"); }
    let result: Result<T> | undefined, failure: unknown;
    try {
      op.check();
      if (this.#closed) fail("closed");
      if (this.#active.size >= this.#limits.maxConcurrent) fail("busy");
      this.#active.add(op);
      result = await execute(op);
    } catch (error) { failure = error; }
    try {
      // Removal/cleanup can synchronously call external signal hooks. Observe
      // those and the monotonic deadline before committing cursor delivery.
      try { op.dispose(); } catch { failure = new ConvexReadError("transport"); }
      op.check();
      if (failure !== undefined) {
        if (failure instanceof ConvexReadError || failure instanceof QueryCancelledError) throw failure;
        throw new ConvexReadError("transport");
      }
      if (result === undefined) fail("protocol");
      result.commit?.();
      return result.value;
    } finally { result?.release?.(); op.finish(() => { this.#active.delete(op); }); }
  }
}
