import { raceAbort, type OrdinalQueryResult } from "@dalgo/adapter-runtime";
import { DuckDBExecutor, type DuckDBLimits, type DuckDBSession, type ResolvedLimits } from "./executor.js";
import { DuckDBError } from "./errors.js";
import { readBrowserStream } from "./browser-stream.js";

export interface BrowserDuckDBOptions extends DuckDBLimits {
  /** Self-hosted immutable bundle URLs selected by the application after selection. */
  readonly bundle: { readonly mainModule: string; readonly mainWorker: string };
  /** Host fetches/uploads bytes under its own auth, origin and response-size policy. */
  readonly parquetFiles?: Readonly<Record<string, Uint8Array>>;
  /** Trusted self-hosted signed extension mirror matching the selected engine. */
  readonly parquetExtensionRepository?: string;
  readonly maxFileBytes?: number;
  readonly memoryLimitMiB?: number;
}
function bundleUrl(value: string): string {
  const url = new URL(value, globalThis.location.href);
  if (url.origin !== globalThis.location.origin || url.username !== "" || url.password !== "" || url.hash !== "") throw new DuckDBError("unsupported");
  return url.href;
}
/** Browser-only entry, no Node addon reference and no eager WASM/worker download. */
export class BrowserDuckDBDatabase extends DuckDBExecutor {
  public constructor(options: BrowserDuckDBOptions) {
    const files = new Map<string, Uint8Array>();
    const maximum = options.maxFileBytes ?? 16_777_216;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 67_108_864) throw new DuckDBError("bounds");
    const memory = options.memoryLimitMiB ?? 128;
    if (!Number.isSafeInteger(memory) || memory < 32 || memory > 512) throw new DuckDBError("bounds");
    let bytes = 0;
    for (const [name, data] of Object.entries(options.parquetFiles ?? {})) {
      if (!/^[A-Za-z0-9_-]+\.parquet$/u.test(name) || !(data instanceof Uint8Array)) throw new DuckDBError("unsupported");
      bytes += data.byteLength;
      if (bytes > maximum || files.size >= 32) throw new DuckDBError("bounds");
      files.set(name, data.slice());
    }
    const mainModule = bundleUrl(options.bundle.mainModule);
    const mainWorker = bundleUrl(options.bundle.mainWorker);
    let repository: string | undefined;
    if (options.parquetExtensionRepository !== undefined) {
      const url = new URL(bundleUrl(options.parquetExtensionRepository));
      if (!/^https?:$/u.test(url.protocol) || url.search !== "") throw new DuckDBError("unsupported");
      repository = url.href.replace(/\/+$/u, "");
    }
    if (files.size > 0 && repository === undefined) throw new DuckDBError("unsupported");
    super(async (signal): Promise<DuckDBSession> => {
      const wasm = await import("@duckdb/duckdb-wasm");
      if (signal.aborted) throw new DuckDBError("open");
      const worker = new Worker(mainWorker);
      const terminate = (): void => { worker.terminate(); };
      signal.addEventListener("abort", terminate, { once: true });
      const db = new wasm.AsyncDuckDB(new wasm.VoidLogger(), worker);
      try {
        await raceAbort(db.instantiate(mainModule), signal, () => new DuckDBError("open"));
        // Standard Arrow BOOL avoids the pinned build's noncanonical bool8
        // export. Int64/Decimal128 still retain their exact Arrow layouts, with
        // all explicit JS lossy-cast flags disabled.
        await raceAbort(db.open({ maximumThreads: 1, arrowLosslessConversion: false, query: { castBigIntToDouble: false, castDecimalToDouble: false, castTimestampToDate: false }, filesystem: { allowFullHTTPReads: false }, opfs: { fileHandling: "manual" } }), signal, () => new DuckDBError("open"));
        for (const [name, data] of files) await raceAbort(db.registerFileBuffer(name, data.slice()), signal, () => new DuckDBError("open"));
        const conn = await raceAbort(db.connect(), signal, () => new DuckDBError("open"));
        // Fixed app-owned settings; the user cannot widen them inside the SELECT.
        const paths = [...files.keys()].map(name => `'${name}'`).join(",");
        await conn.query(`SET memory_limit = '${String(memory)}MiB'`);
        await conn.query("SET max_temp_directory_size = '0B'");
        await conn.query("SET autoinstall_known_extensions = false");
        await conn.query("SET autoload_known_extensions = false");
        await conn.query("SET allow_community_extensions = false");
        // Official WASM Parquet is a separate signed binary. Load only this
        // fixed extension from an app-owned same-origin immutable mirror before
        // locking access. No caller SQL is accepted during this bootstrap.
        if (files.size > 0) {
          await conn.query(`SET custom_extension_repository = '${(repository ?? "").replaceAll("'", "''")}'`);
          await conn.query("LOAD parquet");
        }
        await conn.query(`SET allowed_paths = [${paths}]`);
        await conn.query("SET enable_external_access = false");
        await conn.query("SET lock_configuration = true");
        await conn.query("BEGIN TRANSACTION READ ONLY");
        return {
          async execute(sql: string, bounds: ResolvedLimits): Promise<OrdinalQueryResult> {
            // send supports cancelSent; query materializes a whole Arrow table.
            const reader = await conn.send(sql, true);
            return readBrowserStream(reader, bounds);
          },
          cancel(): void { void conn.cancelSent().catch(() => undefined); terminate(); },
          close(): void { signal.removeEventListener("abort", terminate); terminate(); },
        };
      } catch { signal.removeEventListener("abort", terminate); terminate(); throw new DuckDBError("open"); }
    }, options);
  }
}
export { DuckDBError } from "./errors.js";
export type { DuckDBLimits } from "./executor.js";
