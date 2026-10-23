/** Bounds the allocation and the binary snapshot sent between browser contexts. */
export const MAX_SQLITE_EXPORT_BYTES = 256 * 1024 * 1024;

export interface SqliteExportOptions {
  /** A positive safe integer, at most 256 MiB. Default 256 MiB. */
  readonly maxBytes?: number;
}

/** Actionable failures callers can show without parsing engine error messages. */
export class SqliteExportError extends Error {
  public constructor(public readonly code: "sqlite_export_too_large" | "sqlite_export_busy", message: string) {
    super(message);
    this.name = "SqliteExportError";
  }
}

export function sqliteExportLimit(options: SqliteExportOptions = {}): number {
  const limit = options.maxBytes ?? MAX_SQLITE_EXPORT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SQLITE_EXPORT_BYTES)
    throw new RangeError("SQLite export maxBytes must be a positive safe integer no greater than 256 MiB.");
  return limit;
}
