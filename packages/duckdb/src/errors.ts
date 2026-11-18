export type DuckDBErrorCode = "unsupported" | "bounds" | "query" | "open" | "busy";
/** Provider details, SQL, file paths and AbortSignal.reason never enter errors. */
export class DuckDBError extends Error {
  public constructor(public readonly code: DuckDBErrorCode) {
    super(`DuckDB ${code} failure`);
    this.name = "DuckDBError";
  }
}
