import { LibSQLHttpError, LibSQLPipelineError, LibSQLRequestError } from "./errors.js";
import { decodedValue, requireStatement, type HranaStatement, type HranaStatementOutcome, type RequestContext } from "./transport.js";
import type { LibSQLTransport } from "./transport.js";
import type {
  LibSQLColumnAffinity,
  LibSQLConfiguredKeyDiscovery,
  LibSQLDiscovery,
  LibSQLDiscoveryBounds,
  LibSQLDiscoveryReason,
  LibSQLFieldDiscovery,
  LibSQLKeyType,
  LibSQLPrimaryKeyDiscovery,
  LibSQLTableDiscovery,
  LibSQLUniquenessDiscovery,
} from "./types.js";

export interface DiscoveryAllowlistEntry {
  readonly collection: string;
  readonly keyColumn: string;
  readonly keyType?: LibSQLKeyType;
  readonly uniqueKey: boolean;
}

export interface DiscoveryBounds {
  readonly maxTables: number;
  readonly maxFieldsPerTable: number;
  readonly maxStatements: number;
  readonly maxMetadataBytes: number;
}

const LIST_SQL = "SELECT name, type, wr FROM pragma_table_list "
  + "WHERE schema = 'main' AND type IN ('table', 'view') "
  + "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name LIMIT ?";
const COLUMN_SQL = "SELECT cid, name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid";
const INDEX_SQL = "SELECT il.name AS index_name, il.\"unique\" AS is_unique, il.origin, il.partial, "
  + "ii.seqno, ii.name AS column_name FROM pragma_index_list(?) AS il "
  + "JOIN pragma_index_info(il.name) AS ii ORDER BY il.name, ii.seqno";

interface ParsedColumn {
  readonly name: string;
  readonly declaredType: string;
  readonly nullable: boolean;
  readonly primaryKeyPosition: number;
  readonly hidden: number;
  readonly defaultValue: string | null;
}

interface ParsedIndex {
  readonly name: string;
  readonly unique: boolean;
  /** SQLite's index origin: `c` (CREATE INDEX), `u` (UNIQUE constraint) or `pk` (PRIMARY KEY). */
  readonly origin: string;
  readonly partial: boolean;
  /** `null` marks an expression or rowid term that cannot be a plain column key. */
  readonly columns: readonly (string | null)[];
}

function discoveryBounds(value: DiscoveryBounds): LibSQLDiscoveryBounds {
  return {
    maxTables: value.maxTables,
    maxFieldsPerTable: value.maxFieldsPerTable,
    maxStatements: value.maxStatements,
    maxMetadataBytes: value.maxMetadataBytes,
  };
}

/** SQLite's documented affinity rules, used only to label and validate metadata. */
export function affinityOf(declaredType: string): LibSQLColumnAffinity {
  const type = declaredType.toUpperCase();
  if (type === "") return "any";
  if (type.includes("INT")) return "integer";
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) return "text";
  if (type.includes("BLOB")) return "blob";
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) return "real";
  return "numeric";
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("malformed libSQL metadata text");
  return value;
}

function optionalText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError("malformed libSQL metadata text");
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new TypeError("malformed libSQL metadata integer");
  return value;
}

function row(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError("malformed libSQL metadata row");
  return value.map((cell) => decodedValue(cell));
}

function rows(result: { readonly rows?: unknown }): readonly (readonly unknown[])[] {
  if (!Array.isArray(result.rows)) throw new TypeError("malformed libSQL metadata rows");
  return result.rows.map(row);
}

function parseTableList(value: { readonly rows?: unknown }): { name: string; kind: "table" | "view"; withoutRowid: boolean }[] {
  return rows(value).map((entry) => {
    const name = text(entry[0]);
    const kind = text(entry[1]);
    if (kind !== "table" && kind !== "view") throw new TypeError("malformed libSQL table kind");
    return { name, kind, withoutRowid: integer(entry[2]) === 1 };
  });
}

function parseColumns(columnRows: readonly (readonly unknown[])[]): ParsedColumn[] {
  return columnRows.map((entry) => ({
    name: text(entry[1]),
    declaredType: optionalText(entry[2]) ?? "",
    nullable: integer(entry[3]) === 0,
    defaultValue: optionalText(entry[4]),
    primaryKeyPosition: integer(entry[5]),
    hidden: integer(entry[6]),
  }));
}

function parseIndexes(indexRows: readonly (readonly unknown[])[]): readonly ParsedIndex[] {
  const groups = new Map<string, { unique: boolean; origin: string; partial: boolean; columns: (string | null)[] }>();
  for (const entry of indexRows) {
    // The real statement projects exactly six columns:
    // index_name, is_unique, origin, partial, seqno, column_name.
    const name = text(entry[0]);
    const unique = integer(entry[1]) === 1;
    const origin = text(entry[2]);
    const partial = integer(entry[3]) === 1;
    const column = entry[5];
    if (column !== null && typeof column !== "string") throw new TypeError("malformed libSQL index column");
    const current = groups.get(name);
    if (current === undefined) groups.set(name, { unique, origin, partial, columns: [column] });
    else current.columns.push(column);
  }
  return [...groups].map(([name, group]) => ({
    name,
    unique: group.unique,
    origin: group.origin,
    partial: group.partial,
    columns: group.columns,
  })).sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * SQLite reports an index with `origin = 'pk'` for every PRIMARY KEY that is
 * not a rowid alias: non-INTEGER primary keys, `INTEGER PRIMARY KEY DESC` and
 * WITHOUT ROWID keys. An actual `INTEGER PRIMARY KEY` rowid alias creates no
 * index at all, so its absence is the fact that proves the rowid contract.
 */
function hasPrimaryKeyIndex(indexes: readonly ParsedIndex[]): boolean {
  return indexes.some((index) => index.origin === "pk");
}

function uniqueIndexForKey(indexes: readonly ParsedIndex[], allColumns: readonly ParsedColumn[]): ParsedIndex | undefined {
  return indexes.find((candidate) => {
    if (!candidate.unique || candidate.partial || candidate.columns.length !== 1) return false;
    const key = candidate.columns[0];
    if (key === null || key === undefined) return false;
    const column = allColumns.find((entry) => entry.name === key);
    return column !== undefined && !column.nullable;
  });
}

function fieldOf(column: ParsedColumn): LibSQLFieldDiscovery {
  return {
    name: column.name,
    declaredType: column.declaredType,
    affinity: affinityOf(column.declaredType),
    nullable: column.nullable,
    primaryKeyPosition: column.primaryKeyPosition,
    hidden: column.hidden,
    defaultValue: column.defaultValue,
  };
}

function primaryKeyOf(columns: readonly ParsedColumn[]): LibSQLPrimaryKeyDiscovery {
  const keyed = columns.filter((column) => column.primaryKeyPosition > 0)
    .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition);
  return keyed.length === 0
    ? { status: "not-declared", columns: [] }
    : { status: "declared", columns: Object.freeze(keyed.map((column) => column.name)) };
}

function typeCompatible(type: LibSQLKeyType, affinity: LibSQLColumnAffinity): boolean {
  if (affinity === "any") return true;
  if (type === "text") return affinity === "text";
  if (type === "integer") return affinity === "integer";
  return affinity === "real" || affinity === "numeric" || affinity === "integer";
}

function tableDiscovery(
  table: { name: string; kind: "table" | "view"; withoutRowid: boolean },
  columnRows: readonly (readonly unknown[])[],
  indexRows: readonly (readonly unknown[])[],
  allowed: DiscoveryAllowlistEntry | undefined,
  bounds: DiscoveryBounds,
): LibSQLTableDiscovery {
  const allColumns = parseColumns(columnRows);
  const primaryKey = primaryKeyOf(allColumns);
  const indexes = parseIndexes(indexRows);
  const truncated = allColumns.length > bounds.maxFieldsPerTable;
  const fields = Object.freeze(allColumns.slice(0, bounds.maxFieldsPerTable).map(fieldOf));
  const omittedFields = Math.max(0, allColumns.length - fields.length);

  let uniqueness: LibSQLUniquenessDiscovery;
  if (truncated) {
    uniqueness = {
      status: "unavailable",
      columns: [],
      detail: `metadata fields were truncated at ${String(bounds.maxFieldsPerTable)}; a complete unique key cannot be proven`,
    };
  } else if (primaryKey.status === "declared" && primaryKey.columns.length === 1) {
    const keyColumn = allColumns.find((column) => column.name === primaryKey.columns[0]);
    const declaredInteger = keyColumn !== undefined && keyColumn.declaredType.trim().toUpperCase() === "INTEGER";
    // Only an index-free INTEGER PRIMARY KEY is the rowid alias. `INTEGER
    // PRIMARY KEY DESC` and WITHOUT ROWID keys create a `pk` index and may hold
    // NULL, so they must never inherit the rowid non-null claim.
    const rowidAlias = table.kind === "table" && !table.withoutRowid
      && declaredInteger && !hasPrimaryKeyIndex(indexes);
    if (keyColumn !== undefined && (!keyColumn.nullable || rowidAlias)) {
      uniqueness = {
        status: "declared-primary-key",
        columns: primaryKey.columns,
        detail: rowidAlias
          ? "single INTEGER PRIMARY KEY on a rowid table with no pk index; SQLite assigns a non-null unique rowid"
          : "single non-null PRIMARY KEY column",
      };
    } else {
      uniqueness = {
        status: "not-unique",
        columns: primaryKey.columns,
        detail: declaredInteger
          ? "the declared primary key is nullable and is not a rowid alias (for example INTEGER PRIMARY KEY DESC or WITHOUT ROWID), so it is not a proof of one non-null native ID"
          : "the declared primary key column is nullable, so it is not a proof of one non-null native ID",
      };
    }
  } else if (primaryKey.status === "declared") {
    uniqueness = {
      status: "not-unique",
      columns: primaryKey.columns,
      detail: "the declared primary key is composite and cannot be used as one native ID",
    };
  } else {
    const index = uniqueIndexForKey(indexes, allColumns);
    if (index !== undefined && index.columns[0] !== null && index.columns[0] !== undefined) {
      uniqueness = {
        status: "unique-index",
        columns: [index.columns[0]],
        indexName: index.name,
        detail: "a complete non-partial single-column UNIQUE index on a non-null column",
      };
    } else {
      uniqueness = {
        status: "not-unique",
        columns: [],
        detail: "no single-column non-null PRIMARY KEY or UNIQUE constraint is declared",
      };
    }
  }

  const fieldsByName = new Map(allColumns.map((column) => [column.name, column]));
  let configuredKey: LibSQLConfiguredKeyDiscovery | undefined;
  let adapterQueryable = false;
  let reason: string | undefined;
  if (allowed === undefined) {
    reason = "table or view is not in the adapter allowlist";
  } else {
    configuredKey = {
      collection: allowed.collection,
      column: allowed.keyColumn,
      ...(allowed.keyType === undefined ? {} : { type: allowed.keyType }),
    };
    const key = fieldsByName.get(allowed.keyColumn);
    if (truncated && key === undefined) {
      adapterQueryable = allowed.uniqueKey;
      reason = allowed.uniqueKey
        ? "metadata fields were truncated; the adapter relies on the configured uniqueKey contract"
        : "metadata fields were truncated and the configured key column was not observed";
    } else if (key === undefined) {
      reason = "configured key column is not present in the discovered table or view";
    } else if (allowed.keyType !== undefined && !typeCompatible(allowed.keyType, affinityOf(key.declaredType))) {
      reason = "configured key type does not match the declared SQLite column affinity";
    } else if ((uniqueness.status === "declared-primary-key" || uniqueness.status === "unique-index")
      && uniqueness.columns.length === 1 && uniqueness.columns[0] === allowed.keyColumn) {
      adapterQueryable = true;
    } else if (allowed.uniqueKey) {
      uniqueness = {
        status: "configured-contract",
        columns: [allowed.keyColumn],
        detail: "metadata declares no usable single-column non-null unique key; the caller's explicit uniqueKey contract is the only proof",
      };
      adapterQueryable = true;
    } else {
      reason = "metadata declares no single-column non-null unique key for the configured key and uniqueKey is not true";
    }
  }

  if (!adapterQueryable && reason === undefined) reason = "adapter cannot prove one addressable row per key";
  return {
    name: table.name,
    kind: table.kind,
    allowlisted: allowed !== undefined,
    fields,
    fieldsStatus: truncated ? "truncated" : "declared",
    omittedFields,
    primaryKey,
    unique: uniqueness,
    ...(configuredKey === undefined ? {} : { configuredKey }),
    adapterQueryable,
    ...(reason === undefined ? {} : { adapterQueryableReason: reason }),
  };
}

export function discoveryUnavailable(
  endpoint: string,
  reason: LibSQLDiscoveryReason,
  detail: string,
  bounds: DiscoveryBounds,
  httpStatus?: number,
): LibSQLDiscovery {
  return {
    adapter: "@dalgo/dalgo2libsql",
    protocol: "sqlite-hrana-pipeline",
    endpoint,
    status: "unavailable",
    reason,
    detail,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    tables: [],
    tableCount: 0,
    truncated: false,
    omittedTables: 0,
    bounds: discoveryBounds(bounds),
  };
}

/** Maps a redacted transport or metadata failure to a discovery reason. */
export function discoveryFailure(error: unknown): { readonly reason: LibSQLDiscoveryReason; readonly detail: string; readonly httpStatus?: number } {
  if (error instanceof LibSQLHttpError) {
    const reason = error.status === 401 ? "unauthorized" : error.status === 403 ? "forbidden" : error.status === 404 ? "not-found" : "request-failed";
    const detail = reason === "unauthorized"
      ? "libSQL metadata requires a valid user identity"
      : reason === "forbidden"
        ? "libSQL metadata is not permitted for this identity"
        : reason === "not-found"
          ? "the libSQL pipeline endpoint was not found"
          : "the libSQL metadata request failed";
    return { reason, detail, httpStatus: error.status };
  }
  if (error instanceof RangeError) {
    return error.message.includes("maxResponseBytes")
      ? { reason: "metadata-too-large", detail: "libSQL metadata exceeded the configured byte budget" }
      : { reason: "malformed-metadata", detail: "libSQL metadata contained an unsupported or unsafe value" };
  }
  if (error instanceof LibSQLPipelineError) {
    return { reason: "metadata-unsupported", detail: "the server refused a bounded schema metadata statement" };
  }
  if (error instanceof TypeError) return { reason: "malformed-metadata", detail: "libSQL schema metadata was malformed or unsupported" };
  if (error instanceof LibSQLRequestError) return { reason: "request-failed", detail: "the libSQL metadata request could not be completed" };
  return { reason: "request-failed", detail: "the libSQL metadata request could not be completed" };
}


/**
 * Discovers the tables and views of the primary SQLite schema with two bounded
 * pipeline requests. The list request is capped at `maxTables + 1` so a
 * truncated inventory is explicit; the per-table request is capped by
 * `maxStatements` and `maxMetadataBytes`. Nothing here creates a table, view,
 * index or envelope, and the result never expands the query allowlist.
 */
export async function discoverLibSQL(
  transport: LibSQLTransport,
  allowlist: ReadonlyMap<string, DiscoveryAllowlistEntry>,
  bounds: DiscoveryBounds,
  context: RequestContext,
): Promise<LibSQLDiscovery> {
  const listStatement: HranaStatement = {
    sql: LIST_SQL,
    args: [bounds.maxTables + 1],
    wantRows: true,
  };
  const listed = await transport.pipeline([listStatement], context, undefined, bounds.maxMetadataBytes);
  if (listed.outcomes[0] === undefined) throw new TypeError("libSQL metadata list result missing");
  const allTables = parseTableList(requireStatement(listed.outcomes[0]));
  const truncatedList = allTables.length > bounds.maxTables;
  const tables = truncatedList ? allTables.slice(0, bounds.maxTables) : allTables;
  const omittedTables = allTables.length - tables.length;
  const emptyDetail = "libSQL schema metadata is available; the primary schema currently has no user tables or views";

  const batchCount = Math.min(tables.length, Math.floor(bounds.maxStatements / 2));
  const queried = tables.slice(0, batchCount);
  const omittedByStatements = tables.length - queried.length;
  const statementsList: HranaStatement[] = [];
  for (const table of queried) {
    statementsList.push({ sql: COLUMN_SQL, args: [table.name], wantRows: true });
    statementsList.push({ sql: INDEX_SQL, args: [table.name], wantRows: true });
  }
  let outcomes: readonly HranaStatementOutcome[] = [];
  if (statementsList.length > 0) {
    outcomes = (await transport.pipeline(statementsList, context, undefined, bounds.maxMetadataBytes)).outcomes;
  }
  const discovered: LibSQLTableDiscovery[] = [];
  for (let index = 0; index < queried.length; index += 1) {
    const table = queried[index];
    if (table === undefined) continue;
    const columnOutcome = outcomes[index * 2];
    const indexOutcome = outcomes[index * 2 + 1];
    const allowed = allowlist.get(table.name);
    if (columnOutcome === undefined || indexOutcome === undefined) throw new TypeError("libSQL metadata outcomes missing");
    if (!columnOutcome.ok || !indexOutcome.ok) {
      discovered.push({
        name: table.name,
        kind: table.kind,
        allowlisted: allowed !== undefined,
        fields: [],
        fieldsStatus: "unavailable",
        omittedFields: 0,
        primaryKey: { status: "unavailable", columns: [] },
        unique: { status: "unavailable", columns: [], detail: "the server refused a bounded metadata statement" },
        ...(allowed === undefined ? {} : { configuredKey: { collection: allowed.collection, column: allowed.keyColumn, ...(allowed.keyType === undefined ? {} : { type: allowed.keyType }) } }),
        adapterQueryable: false,
        adapterQueryableReason: "metadata for this table or view is unavailable",
      });
      continue;
    }
    discovered.push(tableDiscovery(
      table,
      rows(columnOutcome.result),
      rows(indexOutcome.result),
      allowed,
      bounds,
    ));
  }
  // Tables omitted by the statement budget stay visible as unavailable
  // inventory entries, never silently dropped from a "not empty" database.
  for (const table of tables.slice(batchCount)) {
    discovered.push({
      name: table.name,
      kind: table.kind,
      allowlisted: allowlist.has(table.name),
      fields: [],
      fieldsStatus: "unavailable",
      omittedFields: 0,
      primaryKey: { status: "unavailable", columns: [] },
      unique: { status: "unavailable", columns: [], detail: "the configured metadata statement budget does not allow a per-table request" },
      adapterQueryable: false,
      adapterQueryableReason: "metadata statement budget does not allow a per-table request",
    });
  }
  const truncated = truncatedList || omittedByStatements > 0 || discovered.some((table) => table.fieldsStatus !== "declared");
  return {
    adapter: "@dalgo/dalgo2libsql",
    protocol: "sqlite-hrana-pipeline",
    endpoint: transport.origin,
    status: "available",
    detail: truncated
      ? "libSQL schema metadata is available but bounded; omitted or truncated entries are explicit"
      : tables.length === 0 ? emptyDetail : "libSQL schema metadata is available for the request role",
    tables: Object.freeze(discovered),
    tableCount: tables.length,
    truncated,
    omittedTables,
    bounds: discoveryBounds(bounds),
  };
}
