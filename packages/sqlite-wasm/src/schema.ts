import type { SqliteDriver } from "./driver.js";

export interface SqliteColumnSchema {
  readonly name: string;
  /**
   * The column type exactly as declared in `CREATE TABLE` (for example
   * `NUMERIC(10,2)`, `NVARCHAR(120)`, or `""` when undeclared). Values are
   * returned as SQLite stores them, so use this to decide how to render or
   * edit a value, such as showing a NUMERIC column as fixed-point text.
   */
  readonly declaredType: string;
  readonly notNull: boolean;
  /** The default value's SQL expression text, or `null`. */
  readonly defaultValue: string | null;
  /** 1-based position in the primary key, or 0 for a non-key column. */
  readonly primaryKeyPosition: number;
}

export interface SqliteForeignKeySchema {
  /** Child columns in this table, in constraint order. */
  readonly columns: readonly string[];
  readonly referencedTable: string;
  /** Parent columns, in constraint order; `null` means the parent's primary key column. */
  readonly referencedColumns: readonly (string | null)[];
  readonly onUpdate: string;
  readonly onDelete: string;
}

export interface SqliteTableSchema {
  readonly name: string;
  readonly columns: readonly SqliteColumnSchema[];
  /** Primary key column names in key order; empty for tables without a declared primary key. */
  readonly primaryKey: readonly string[];
  readonly foreignKeys: readonly SqliteForeignKeySchema[];
}

export interface SqliteSchema {
  /** Ordinary tables by name, excluding SQLite's internal `sqlite_*` tables. Views are not included. */
  readonly tables: Readonly<Record<string, SqliteTableSchema>>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Reads tables, columns, declared types, primary keys and foreign keys with SQLite's schema pragmas. */
export async function readSqliteSchema(driver: SqliteDriver): Promise<SqliteSchema> {
  const tables: Record<string, SqliteTableSchema> = {};
  const { rows: names } = await driver.exec(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
  );
  for (const { name } of names) {
    const table = text(name);
    const { rows: columnRows } = await driver.exec("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid", [table]);
    const columns: SqliteColumnSchema[] = columnRows.map((row) => ({
      name: text(row.name),
      declaredType: text(row.type),
      notNull: row.notnull === 1,
      defaultValue: typeof row.dflt_value === "string" ? row.dflt_value : null,
      primaryKeyPosition: Number(row.pk),
    }));
    const primaryKey = columns.filter((column) => column.primaryKeyPosition > 0)
      .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
      .map((column) => column.name);
    const { rows: keyRows } = await driver.exec(
      "SELECT id, \"table\", \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq",
      [table],
    );
    const foreignKeys: SqliteForeignKeySchema[] = [];
    let current: { readonly id: unknown; readonly columns: string[]; readonly referencedColumns: (string | null)[] } | undefined;
    for (const row of keyRows) {
      if (current === undefined || row.id !== current.id) {
        current = { id: row.id, columns: [], referencedColumns: [] };
        foreignKeys.push({
          columns: current.columns,
          referencedTable: text(row.table),
          referencedColumns: current.referencedColumns,
          onUpdate: text(row.on_update),
          onDelete: text(row.on_delete),
        });
      }
      current.columns.push(text(row.from));
      current.referencedColumns.push(typeof row.to === "string" ? row.to : null);
    }
    tables[table] = { name: table, columns, primaryKey, foreignKeys };
  }
  return { tables };
}
