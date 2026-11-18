import type { OrdinalQueryResult, OrdinalValue } from "@dalgo/adapter-runtime";
import { arrowValue, arrowNativeType, type ArrowValueType, type ArrowFieldMetadata } from "./arrow-values.js";
import type { ResolvedLimits } from "./executor.js";
import { DuckDBError } from "./errors.js";

interface StreamField {
  readonly name: string;
  readonly type: ArrowValueType & { toString(): string };
  readonly metadata?: ArrowFieldMetadata;
}
interface StreamBatch {
  readonly numRows: number;
  getChildAt(column: number): { get(index: number): unknown } | null;
}
/** Structural subset of the pinned Arrow async reader, without loading Arrow. */
export interface BrowserArrowStream extends AsyncIterable<StreamBatch> {
  readonly schema: { readonly fields: readonly StreamField[] } | undefined;
  open(): unknown | Promise<unknown>;
  cancel(): void | Promise<void>;
}

/** Open only the header, then consume bounded batches without materializing a table. */
export async function readBrowserStream(reader: BrowserArrowStream, bounds: ResolvedLimits): Promise<OrdinalQueryResult> {
  try {
    // Arrow17's async RecordBatchReader.from() does not initialize schema.
    // open() consumes the schema message, while record batches remain streamed.
    await reader.open();
    const fields = reader.schema?.fields;
    if (fields === undefined) throw new DuckDBError("query");
    if (fields.length > bounds.maxColumns) throw new DuckDBError("bounds");
    const columns = fields.map(field => ({ name: field.name, nativeType: arrowNativeType(field.type, field.metadata) }));
    const rows: OrdinalValue[][] = [];
    let size = new TextEncoder().encode(JSON.stringify(columns)).byteLength;
    if (size > bounds.maxResultBytes) throw new DuckDBError("bounds");
    for await (const batch of reader) {
      for (let index = 0; index < batch.numRows; index++) {
        if (rows.length >= bounds.maxRows) throw new DuckDBError("bounds");
        const values = fields.map((field, column) => {
          const vector = batch.getChildAt(column);
          if (vector === null) throw new DuckDBError("query");
          return arrowValue(vector.get(index), field.type, field.metadata);
        });
        size += new TextEncoder().encode(JSON.stringify(values)).byteLength + 1;
        if (size > bounds.maxResultBytes) throw new DuckDBError("bounds");
        rows.push(values);
      }
    }
    return { columns, rows };
  } finally {
    // Also release readers rejected at the header before iteration begins.
    // The owning session always terminates its worker after execute settles.
    try { await reader.cancel(); } catch { /* preserve the original result/failure */ }
  }
}
