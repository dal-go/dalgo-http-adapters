import { DuckDBExecutor, type DuckDBLimits, type DuckDBSession, type ResolvedLimits } from "./executor.js";
import { DuckDBError } from "./errors.js";
import { nodeValue } from "./values.js";
import type { OrdinalQueryResult, OrdinalValue } from "@dalgo/adapter-runtime";

export interface NodeDuckDBOptions extends DuckDBLimits {
  /** Existing database only; omitted means a disposable in-memory database. */
  readonly databasePath?: string;
  /** Explicit existing local Parquet files. No directories, URLs or glob grants. */
  readonly parquetPaths?: readonly string[];
  /** Engine budget is separate from the enclosing process/container limit. */
  readonly memoryLimitMiB?: number;
}
export function nodeConfiguration(options: NodeDuckDBOptions): Readonly<Record<string, string>> {
  const paths = options.parquetPaths ?? [];
  if (paths.length > 32 || paths.some(path => !path.startsWith("/") || path.includes("\0") || path.includes("..") || /[*?\[\]{}]/u.test(path) || !path.endsWith(".parquet"))) throw new DuckDBError("unsupported");
  const memory = options.memoryLimitMiB ?? 128;
  if (!Number.isSafeInteger(memory) || memory < 32 || memory > 512) throw new DuckDBError("bounds");
  if (options.databasePath !== undefined && (!options.databasePath.startsWith("/") || options.databasePath.includes("\0") || options.databasePath.includes(".."))) throw new DuckDBError("unsupported");
  return Object.freeze({
    ...(options.databasePath === undefined ? {} : { access_mode: "READ_ONLY" }),
    threads: "1", memory_limit: `${String(memory)}MiB`, max_temp_directory_size: "0B",
    enable_external_access: "false", allow_unsigned_extensions: "false",
    autoinstall_known_extensions: "false", autoload_known_extensions: "false",
    allowed_paths: `[${paths.map(path => `'${path.replaceAll("'", "''")}'`).join(",")}]`,
  });
}
/** Node-only entry: the native addon is imported only when a query starts. */
export class NodeDuckDBDatabase extends DuckDBExecutor {
  public constructor(options: NodeDuckDBOptions = {}) {
    const config = nodeConfiguration(options);
    const databasePath = options.databasePath;
    const hasParquet = (options.parquetPaths?.length ?? 0) > 0;
    // allowed_paths can only be installed after DuckDB has started, while
    // external access is still enabled (DuckDB 1.4.5 setting contract).
    // No caller SQL/session is exposed until the final restrictions are locked.
    const startupConfig = { ...config };
    delete startupConfig.allowed_paths;
    delete startupConfig.enable_external_access;
    super(async (): Promise<DuckDBSession> => {
      const { DuckDBInstance } = await import("@duckdb/node-api");
      const instance = await DuckDBInstance.create(databasePath ?? ":memory:", startupConfig).catch(() => { throw new DuckDBError("open"); });
      let connection;
      try { connection = await instance.connect(); }
      catch { instance.closeSync(); throw new DuckDBError("open"); }
      const conn = connection;
      try {
        // Parquet is the bundled trusted extension; never install from network.
        await conn.run(`SET allowed_paths = ${config.allowed_paths ?? "[]"}`);
        if (hasParquet) await conn.run("LOAD parquet");
        await conn.run("SET enable_external_access = false");
        await conn.run("SET lock_configuration = true");
        await conn.run("BEGIN TRANSACTION READ ONLY");
      } catch { conn.closeSync(); instance.closeSync(); throw new DuckDBError("open"); }
      return {
        async execute(sql: string, bounds: ResolvedLimits): Promise<OrdinalQueryResult> {
          // stream() prepares SQL; it must not materialize an unlimited result.
          const result = await conn.stream(sql);
          if (result.columnCount > bounds.maxColumns) throw new DuckDBError("bounds");
          const names = result.columnNames();
          const types = result.columnTypes().map(type => type.toString());
          const columns = names.map((name, index) => ({ name, nativeType: types[index] ?? "UNKNOWN" }));
          const rows: OrdinalValue[][] = [];
          let bytes = new TextEncoder().encode(JSON.stringify(columns)).byteLength;
          for await (const chunk of result) {
            for (const row of chunk.getRows()) {
              if (rows.length >= bounds.maxRows) throw new DuckDBError("bounds");
              const values = row.map((value, index) => nodeValue(value, types[index] ?? "UNKNOWN"));
              bytes += new TextEncoder().encode(JSON.stringify(values)).byteLength + 1;
              if (bytes > bounds.maxResultBytes) throw new DuckDBError("bounds");
              rows.push(values);
            }
          }
          return { columns, rows };
        },
        cancel(): void { conn.interrupt(); },
        close(): void { conn.closeSync(); instance.closeSync(); },
      };
    }, options);
  }
}
export { DuckDBError } from "./errors.js";
export type { DuckDBLimits } from "./executor.js";
