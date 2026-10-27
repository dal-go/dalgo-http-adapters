import { decodedValue, isObject, type HranaStatementResult } from "./transport.js";
import type { LibSQLScalar } from "./sql.js";

/**
 * Validates one statement's exact projection and decodes only Hrana scalars.
 * No text, blob or boolean value is coerced into another storage class.
 */
export function decodeRows(
  result: HranaStatementResult,
  expected: readonly string[],
  maximumRows: number,
  label: string,
): readonly Record<string, LibSQLScalar>[] {
  if (!Array.isArray(result.cols) || !Array.isArray(result.rows)) throw new TypeError(`malformed libSQL ${label} result`);
  if (result.cols.length !== expected.length || result.cols.some((column, index) => !isObject(column) || column.name !== expected[index])) {
    throw new TypeError(`malformed libSQL ${label} projection`);
  }
  if (result.rows.length > maximumRows) throw new RangeError(`libSQL ${label} response returned more rows than its limit`);
  return result.rows.map((entry, rowIndex) => {
    if (!Array.isArray(entry) || entry.length !== expected.length) throw new TypeError(`malformed libSQL ${label} row ${String(rowIndex)}`);
    const output = Object.create(null) as Record<string, LibSQLScalar>;
    for (let index = 0; index < expected.length; index += 1) {
      const name = expected[index];
      if (name === undefined) throw new Error(`libSQL ${label} projection name missing`);
      output[name] = decodedValue(entry[index]);
    }
    return output;
  });
}

/** Reads the adapter-owned key alias without stringifying a native number. */
export function rowKey(row: Readonly<Record<string, LibSQLScalar>>): string | number {
  const value = row.__dalgo_key;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new RangeError("libSQL key integer is outside JavaScript safe-integer range");
    }
    return value;
  }
  throw new TypeError("libSQL key column must return a string or a finite number");
}

export function affectedRows(result: HranaStatementResult): number {
  const count = result.affected_row_count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("malformed libSQL affected-row count");
  }
  return count;
}
