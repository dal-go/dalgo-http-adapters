import { BatchGetItemCommand, GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { DynamoDbReadError, DynamoDbReadOperation } from "./read-operation.js";
import { checkProjection, compileQuery, configuredTables, itemKey, keyAttributes, matchesSort, readPlan, resolveTables, type QueryPlan, type ResolvedTable } from "./native-query.js";
import { cloneItem, cloneKey, compare, identity, invalid, keyIdentity, objectMap, ordinaryArray, requestError, text } from "./native-values.js";
import { NativeDynamoDbError, type NativeDynamoDbClientLike, type NativeDynamoDbCursor, type NativeDynamoDbItem, type NativeDynamoDbKey, type NativeDynamoDbKeyValue, type NativeDynamoDbOptions, type NativeDynamoDbPage, type NativeDynamoDbQuery, type NativeDynamoDbReadOptions, type NativeDynamoDbTable } from "./native-types.js";

interface Limits { readonly timeoutMs: number; readonly maxReadBytes: number; readonly maxRecords: number; readonly maxPages: number; readonly maxEvaluated: number; readonly pageSize: number; readonly maxConcurrent: number; }
interface CursorState { readonly scope: string; readonly key: NativeDynamoDbKey; }
function positive(value: unknown, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 1 || result > maximum) throw new NativeDynamoDbError("configuration");
  return result;
}
function limits(raw: Record<string, unknown>): Limits {
  if (Object.keys(raw).some((name) => !["tables", "timeoutMs", "maxReadBytes", "maxRecords", "maxPages", "maxEvaluated", "pageSize", "maxConcurrent"].includes(name))) throw new NativeDynamoDbError("configuration");
  return { timeoutMs: positive(raw.timeoutMs, 30_000, 120_000), maxReadBytes: positive(raw.maxReadBytes, 4_000_000, 16_000_000), maxRecords: positive(raw.maxRecords, 1000, 10_000),
    maxPages: positive(raw.maxPages, 100, 1000), maxEvaluated: positive(raw.maxEvaluated, 10_000, 100_000), pageSize: positive(raw.pageSize, 100, 1000), maxConcurrent: positive(raw.maxConcurrent, 4, 32) };
}

/** Additive read-only existing-table API. It does not change managed DALgo keys. */
export class NativeDynamoDbDatabase {
  readonly #client: NativeDynamoDbClientLike;
  readonly #tables: ReadonlyMap<string, ResolvedTable>;
  readonly #limits: Limits;
  readonly #cursors = new WeakMap<object, CursorState>();
  readonly #controllers = new Set<AbortController>();
  readonly #waiters = new Set<() => void>();
  #active = 0;
  #closed = false;

  public constructor(client: NativeDynamoDbClientLike, options: NativeDynamoDbOptions) {
    const candidate: unknown = client;
    if (candidate === null || typeof candidate !== "object" || !("send" in candidate) || typeof candidate.send !== "function") throw new NativeDynamoDbError("configuration");
    const validation = new DynamoDbReadOperation(undefined, 1000, 1_048_576, 10_000);
    try {
      validation.account(options);
      const raw = objectMap(options, 8);
      this.#limits = limits(raw); this.#tables = resolveTables(raw.tables); validation.check();
    } catch { throw new NativeDynamoDbError("configuration"); }
    finally { validation.dispose(); }
    this.#client = client;
  }

  /** Configured metadata only; no table/index discovery or permission probe. */
  public configuredTables(): Readonly<Record<string, NativeDynamoDbTable>> { return configuredTables(this.#tables); }
  /** Stops owned scopes only; never destroys the borrowed SDK or its transport. */
  public close(): void {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
  }

  public get(collection: string, key: NativeDynamoDbKey, options?: NativeDynamoDbReadOptions): Promise<NativeDynamoDbItem | null> { return this.getWithSignal(collection, key, undefined, options); }
  public getWithSignal(collection: string, key: NativeDynamoDbKey, signal: AbortSignal | undefined, options?: NativeDynamoDbReadOptions): Promise<NativeDynamoDbItem | null> {
    return this.run(signal, async (op) => {
      const table = this.table(collection); const plan = readPlan(table, options);
      const admitted = cloneKey(op, key, keyAttributes(table));
      const output = objectMap(await this.invoke(op, new GetItemCommand({ TableName: table.tableName, Key: admitted, ConsistentRead: plan.consistent,
        ...(plan.expression === undefined ? {} : { ProjectionExpression: plan.expression, ExpressionAttributeNames: plan.names }) })));
      op.account(output); if (output.Item === undefined) return null;
      op.consumeRecords(1); const item = cloneItem(op, output.Item); checkProjection(item, plan);
      if (keyIdentity(itemKey(op, item, plan)) !== keyIdentity(admitted)) return invalid();
      return item;
    });
  }
  public exists(collection: string, key: NativeDynamoDbKey): Promise<boolean> { return this.existsWithSignal(collection, key, undefined); }
  public async existsWithSignal(collection: string, key: NativeDynamoDbKey, signal: AbortSignal | undefined): Promise<boolean> {
    // Keep one public scope through final existence delivery, not a nested get.
    return this.run(signal, async (op) => {
      const table = this.table(collection); const plan = readPlan(table, { projection: keyAttributes(table).map((v) => v.name) });
      const admitted = cloneKey(op, key, keyAttributes(table));
      const output = objectMap(await this.invoke(op, new GetItemCommand({ TableName: table.tableName, Key: admitted, ConsistentRead: plan.consistent, ProjectionExpression: plan.expression, ExpressionAttributeNames: plan.names })));
      op.account(output); if (output.Item === undefined) return false;
      const item = cloneItem(op, output.Item); checkProjection(item, plan); op.consumeRecords(1);
      if (keyIdentity(itemKey(op, item, plan)) !== keyIdentity(admitted)) return invalid();
      return true;
    });
  }

  public getMany(collection: string, keys: readonly NativeDynamoDbKey[], options?: NativeDynamoDbReadOptions): Promise<readonly (NativeDynamoDbItem | null)[]> { return this.getManyWithSignal(collection, keys, undefined, options); }
  public getManyWithSignal(collection: string, keys: readonly NativeDynamoDbKey[], signal: AbortSignal | undefined, options?: NativeDynamoDbReadOptions): Promise<readonly (NativeDynamoDbItem | null)[]> {
    return this.run(signal, async (op) => {
      const table = this.table(collection); const plan = readPlan(table, options);
      const supplied = ordinaryArray(keys, this.#limits.maxRecords); op.admitRecords(supplied.length);
      const admitted = supplied.map((key) => cloneKey(op, key, keyAttributes(table)));
      const unique = new Map(admitted.map((key) => [keyIdentity(key), key]));
      if (unique.size > 100) return requestError();
      if (admitted.length === 0) return [];
      const output = objectMap(await this.invoke(op, new BatchGetItemCommand({ RequestItems: { [table.tableName]: { Keys: [...unique.values()], ConsistentRead: plan.consistent,
        ...(plan.expression === undefined ? {} : { ProjectionExpression: plan.expression, ExpressionAttributeNames: plan.names }) } } })));
      op.account(output);
      const unprocessed = objectMap(output.UnprocessedKeys ?? {}, 128);
      for (const [name, pending] of Object.entries(unprocessed)) {
        if (name !== table.tableName) return invalid();
        const raw = objectMap(pending); const remaining = ordinaryArray(raw.Keys ?? [], 100);
        if (remaining.length > 0) throw new NativeDynamoDbError("unprocessed");
      }
      const responses = objectMap(output.Responses ?? {}, 128);
      if (Object.keys(responses).some((name) => name !== table.tableName)) return invalid();
      const items = ordinaryArray(responses[table.tableName] ?? [], 100); op.consumeRecords(items.length);
      const byKey = new Map<string, NativeDynamoDbItem>();
      for (const raw of items) {
        const item = cloneItem(op, raw); checkProjection(item, plan);
        const id = keyIdentity(itemKey(op, item, plan));
        if (!unique.has(id) || byKey.has(id)) return invalid();
        byKey.set(id, item);
      }
      return admitted.map((key) => {
        op.check(); const item = byKey.get(keyIdentity(key));
        // Each logical duplicate has independent output ownership and cost.
        return item === undefined ? null : cloneItem(op, item);
      });
    });
  }

  public queryPartition(request: NativeDynamoDbQuery): Promise<NativeDynamoDbPage> { return this.queryPartitionWithSignal(request, undefined); }
  public queryPartitionWithSignal(request: NativeDynamoDbQuery, signal: AbortSignal | undefined): Promise<NativeDynamoDbPage> {
    return this.run(signal, async (op) => {
      const plan = compileQuery(op, this.#tables, request, this.#limits.maxRecords);
      let cursor: NativeDynamoDbKey | undefined;
      if (request.cursor !== undefined) {
        const stored = this.#cursors.get(request.cursor);
        if (stored?.scope !== plan.scope) return requestError();
        cursor = cloneKey(op, stored.key, plan.keyAttributes, plan.partitionNames);
      }
      const items: NativeDynamoDbItem[] = []; const seenItems = new Set<string>(); const seenCursors = new Set<string>();
      if (cursor !== undefined) {
        seenCursors.add(keyIdentity(cursor));
        const base = cloneKey(op, Object.fromEntries(keyAttributes(plan.table).map((attr) => [attr.name, cursor?.[attr.name]])), keyAttributes(plan.table));
        seenItems.add(keyIdentity(base));
      }
      let previous: NativeDynamoDbKeyValue | undefined = cursor === undefined || plan.target.sortKey === undefined ? undefined : cursor[plan.target.sortKey.name];
      let pages = 0; let evaluated = 0;
      for (;;) {
        op.check();
        if (pages >= this.#limits.maxPages || evaluated >= this.#limits.maxEvaluated) throw new NativeDynamoDbError("limit");
        const limit = Math.min(plan.limit - items.length, this.#limits.pageSize, this.#limits.maxEvaluated - evaluated);
        const output = objectMap(await this.invoke(op, new QueryCommand({ ...plan.input, Limit: limit, ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }) })));
        op.account(output);
        const rows = ordinaryArray(output.Items ?? [], limit);
        if (output.Count !== rows.length || typeof output.ScannedCount !== "number" || !Number.isSafeInteger(output.ScannedCount) || output.ScannedCount < rows.length || output.ScannedCount > limit) return invalid();
        pages += 1; evaluated += Math.max(1, output.ScannedCount); op.consumeRecords(rows.length);
        for (const raw of rows) {
          const item = cloneItem(op, raw); checkProjection(item, plan);
          const key = itemKey(op, item, plan); this.queryKey(op, key, plan);
          const base = cloneKey(op, Object.fromEntries(keyAttributes(plan.table).map((attr) => [attr.name, key[attr.name]])), keyAttributes(plan.table));
          const id = keyIdentity(base); if (seenItems.has(id)) return invalid(); seenItems.add(id);
          const sort = plan.target.sortKey === undefined ? undefined : key[plan.target.sortKey.name];
          if (sort !== undefined && previous !== undefined) {
            const order = compare(sort, previous);
            // Index keys are not unique: equal sort values may straddle pages.
            if (plan.descending ? order > 0 : order < 0) return invalid();
            if (!("kind" in plan.target) && order === 0) return invalid();
          }
          if (sort !== undefined) previous = sort;
          items.push(item);
        }
        if (output.LastEvaluatedKey === undefined || objectEntriesEmpty(output.LastEvaluatedKey)) return { items, pages, evaluated };
        const next = cloneKey(op, output.LastEvaluatedKey, plan.keyAttributes, plan.partitionNames); this.queryKey(op, next, plan);
        const id = keyIdentity(next); if (seenCursors.has(id)) throw new NativeDynamoDbError("invalid-response"); seenCursors.add(id);
        if (plan.target.sortKey !== undefined) {
          const sort = next[plan.target.sortKey.name] ?? invalid();
          if (previous !== undefined && (plan.descending ? compare(sort, previous) > 0 : compare(sort, previous) < 0)) return invalid();
          previous = sort;
        }
        if (items.length === plan.limit) {
          const handle: NativeDynamoDbCursor = Object.freeze({ adapter: "native-dynamodb", version: 1 });
          const owned = cloneKey(op, next, plan.keyAttributes, plan.partitionNames);
          op.check(); this.#cursors.set(handle, { scope: plan.scope, key: owned });
          return { items, pages, evaluated, nextCursor: handle };
        }
        cursor = next;
      }
    });
  }

  private queryKey(op: DynamoDbReadOperation, key: NativeDynamoDbKey, plan: QueryPlan): void {
    if (identity(key[plan.target.partitionKey.name] ?? invalid()) !== identity(plan.partition)) return invalid();
    if (plan.target.sortKey !== undefined && plan.sort !== undefined && !matchesSort(key[plan.target.sortKey.name] ?? invalid(), plan.sort)) return invalid();
    // Recheck every schema's byte role when an attribute participates twice.
    cloneKey(op, Object.fromEntries(keyAttributes(plan.table).map((v) => [v.name, key[v.name]])), keyAttributes(plan.table));
  }
  private table(collection: string): ResolvedTable { return this.#tables.get(text(collection, 255, true)) ?? requestError(); }
  private async acquire(op: DynamoDbReadOperation): Promise<void> {
    while (this.#active >= this.#limits.maxConcurrent) {
      if (this.#waiters.size >= 128) throw new NativeDynamoDbError("limit");
      let wake!: () => void;
      const pending = new Promise<void>((resolve) => { wake = resolve; this.#waiters.add(wake); });
      try { await op.send(() => pending); } finally { this.#waiters.delete(wake); }
    }
    op.check(); this.#active += 1;
  }
  private async invoke(op: DynamoDbReadOperation, command: GetItemCommand | BatchGetItemCommand | QueryCommand): Promise<unknown> {
    op.account(command.input); await this.acquire(op);
    const pending = Promise.resolve().then(() => { op.check(); return this.#client.send(command, { abortSignal: op.signal }); });
    const tracked = pending.finally(() => {
      this.#active -= 1;
      for (const wake of this.#waiters) wake();
    });
    // Cancellation can win after admission but before send() subscribes.
    // Always observe that owned promise even when its pre-abort check throws.
    void tracked.catch(() => undefined);
    return op.send(() => tracked);
  }
  private async run<T>(caller: AbortSignal | undefined, worker: (op: DynamoDbReadOperation) => Promise<T>): Promise<T> {
    if (this.#closed) throw new NativeDynamoDbError("closed");
    const controller = new AbortController(); const abort = (): void => { controller.abort(); };
    if (caller?.aborted === true) controller.abort(); else caller?.addEventListener("abort", abort, { once: true });
    this.#controllers.add(controller);
    const op = new DynamoDbReadOperation(controller.signal, this.#limits.timeoutMs, this.#limits.maxReadBytes, this.#limits.maxRecords);
    let result: T;
    try { op.check(); result = await worker(op); op.check(); }
    catch (error: unknown) {
      op.check();
      if (error instanceof NativeDynamoDbError || error instanceof QueryCancelledError) throw error;
      if (error instanceof DynamoDbReadError) throw new NativeDynamoDbError(error.code === "limit" ? "limit" : error.code);
      throw new NativeDynamoDbError("invalid-response");
    } finally { op.dispose(); caller?.removeEventListener("abort", abort); this.#controllers.delete(controller); }
    // Original caller and elapsed time remain authoritative after cleanup.
    if (caller?.aborted === true) throw new QueryCancelledError("caller");
    op.check(); return result;
  }
}
function objectEntriesEmpty(value: unknown): boolean { return Object.keys(objectMap(value, 4)).length === 0; }
