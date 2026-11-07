import { createAbortScope, QueryCancelledError, raceAbort, type OrdinalQuery, type OrdinalQueryExecutor, type OrdinalQueryResult } from "@dalgo/adapter-runtime";
import { DuckDBError } from "./errors.js";

export interface DuckDBLimits {
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly maxColumns?: number;
  readonly maxResultBytes?: number;
  readonly maxSqlBytes?: number;
}
export interface ResolvedLimits {
  readonly timeoutMs: number;
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxResultBytes: number;
  readonly maxSqlBytes: number;
}
export interface DuckDBSession {
  execute(sql: string, limits: ResolvedLimits): Promise<OrdinalQueryResult>;
  cancel(): void;
  close(): Promise<void> | void;
}
export type DuckDBSessionFactory = (signal: AbortSignal) => Promise<DuckDBSession>;
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < 1 || actual > maximum) throw new DuckDBError("bounds");
  return actual;
}
export function limits(options: DuckDBLimits): ResolvedLimits {
  return {
    timeoutMs: bounded(options.timeoutMs, 30_000, 60_000),
    maxRows: bounded(options.maxRows, 1000, 100_000),
    maxColumns: bounded(options.maxColumns, 256, 1024),
    maxResultBytes: bounded(options.maxResultBytes, 8_388_608, 67_108_864),
    maxSqlBytes: bounded(options.maxSqlBytes, 65_536, 1_048_576),
  };
}
export function readSql(query: OrdinalQuery, bounds: ResolvedLimits): string {
  if (query.kind !== "native" || (query.parameters?.length ?? 0) > 0) throw new DuckDBError("unsupported");
  const sql = query.sql.trim();
  // This restricted grammar is a defense in depth, NOT the authorization boundary.
  // No comments/statement separator may swallow or escape our outer SELECT/LIMIT.
  // Literal strings containing these sequences are deliberately rejected too.
  if (sql.length === 0 || /;|--|\/\*|\*\//u.test(sql)) throw new DuckDBError("unsupported");
  if (new TextEncoder().encode(sql).byteLength > bounds.maxSqlBytes) throw new DuckDBError("bounds");
  return `SELECT * FROM (${sql}) AS dalgo_bounded_result LIMIT ${String(bounds.maxRows + 1)}`;
}
export function checkResult(result: OrdinalQueryResult, bounds: ResolvedLimits): OrdinalQueryResult {
  if (result.rows.length > bounds.maxRows || result.columns.length > bounds.maxColumns || result.rows.some(row => row.length !== result.columns.length)) throw new DuckDBError("bounds");
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > bounds.maxResultBytes) throw new DuckDBError("bounds");
  return result;
}
/** Each call owns a separate connection; interruption cannot cancel a neighbour. */
export class DuckDBExecutor implements OrdinalQueryExecutor {
  public readonly readOnly = true as const;
  readonly #limits: ResolvedLimits;
  public constructor(private readonly open: DuckDBSessionFactory, options: DuckDBLimits = {}) { this.#limits = limits(options); }
  public async queryOrdinal(query: OrdinalQuery, signal?: AbortSignal): Promise<OrdinalQueryResult> {
    const sql = readSql(query, this.#limits);
    const scope = createAbortScope(signal, this.#limits.timeoutMs);
    const cancelled = (): QueryCancelledError => new QueryCancelledError(scope.deadlineExceeded ? "deadline" : "caller");
    const operation = Promise.resolve().then(async () => {
      if (scope.signal.aborted) throw cancelled();
      const session = await this.open(scope.signal);
      const cancel = (): void => { try { session.cancel(); } catch { /* best effort */ } };
      try {
        if (scope.signal.aborted) { cancel(); throw cancelled(); }
        scope.signal.addEventListener("abort", cancel, { once: true });
        const result = await session.execute(sql, this.#limits);
        if (scope.signal.aborted) throw cancelled();
        return checkResult(result, this.#limits);
      } finally {
        scope.signal.removeEventListener("abort", cancel);
        // Native handles remain alive until their outstanding operation settles.
        try { await session.close(); } catch { /* never replace original failure */ }
      }
    });
    try {
      const result = await raceAbort(operation, scope.signal, cancelled);
      // Abort may arrive after the race listener is removed, while the outer
      // continuation is queued behind final resource-cleanup microtasks.
      if (scope.signal.aborted) throw cancelled();
      return result;
    }
    catch (error) {
      if (scope.signal.aborted) throw cancelled();
      if (error instanceof DuckDBError) throw error;
      throw new DuckDBError("query");
    } finally { scope.dispose(); }
  }
}
