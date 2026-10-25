import type { StructuredQuery } from "@dalgo/core";

export interface D1Column {
  /** Physical SQLite column name. The DALgo field name is the object key. */
  readonly column: string;
}

export interface D1Table {
  /** Physical SQLite table name. */
  readonly table: string;
  /** Explicit DALgo field to physical column mapping. */
  readonly columns: Readonly<Record<string, D1Column>>;
  /** DALgo field names that form the primary key, in database key order. */
  readonly primaryKey: readonly string[];
}

export type D1Schema = Readonly<Record<string, D1Table>>;

export interface D1DatabaseOptions {
  readonly tables: D1Schema;
  readonly maxQueryLimit?: number;
  readonly maxGetManyKeys?: number;
  readonly maxScanRows?: number;
  readonly scanPageSize?: number;
  readonly expectedSchemaVersion?: string;
  readonly expectedSeedVersion?: string;
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  all(): Promise<{ readonly results?: readonly Readonly<Record<string, unknown>>[]; readonly success?: boolean }>;
}

export interface D1Binding {
  prepare(sql: string): D1PreparedStatement;
}

export type D1Value = string | number | null | ArrayBuffer | ArrayBufferView;

export interface D1LeafQuery<T = Record<string, unknown>> extends StructuredQuery<T> {
  readonly source: { readonly kind: "collection"; readonly name: string; readonly parent?: never };
}
