import {
  QueryCancelledError, createAbortScope, raceAbort,
  type OrdinalQuery, type OrdinalQueryExecutor, type OrdinalQueryResult,
} from "@dalgo/adapter-runtime";
import { ClickHouseNativeError } from "./native-errors.js";
import { compileOrdinalQuery } from "./native-dalgo.js";
import { nativeIdentifier, nativeParameters } from "./native-query.js";
import { isAborted, isObjectMap, nativeHeaders, nativeOrigin, nativeRequest } from "./native-transport.js";
import { decodeClickHouseRowBinary } from "./row-binary.js";
import type { ClickHouseReadGrant, NativeClickHouseDatabaseOptions } from "./native-types.js";

function positive(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`${name} must be between 1 and ${String(maximum)}`);
  return result;
}

/**
 * Native, anonymous, read-only SQL result capability. Deliberately independent
 * of core Database: ClickHouse rows need not possess a unique record key.
 * Server readonly=1, SELECT grants, immutable bounds and safe table-function
 * permissions remain authoritative. No SQL sanitizer is used as authorization.
 */
export class NativeClickHouseDatabase implements OrdinalQueryExecutor {
  public readonly readOnly = true as const;
  public readonly serverCancellation = "best-effort-kill-query" as const;
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #headers: NativeClickHouseDatabaseOptions["headers"];
  readonly #tables = new Map<string, ClickHouseReadGrant>();
  readonly #allowNative: boolean;
  readonly #timeoutMs: number;
  readonly #maxRows: number;
  readonly #maxColumns: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxValues: number;
  readonly #maxDepth: number;

  public constructor(options: NativeClickHouseDatabaseOptions) {
    this.#origin = nativeOrigin(options.serverUrl, options.allowInsecureLoopbackHttp === true);
    if (options.headers !== undefined && typeof options.headers !== "function") throw new TypeError("headers must be a provider function");
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#allowNative = options.allowNativeSql === true;
    this.#timeoutMs = positive(options.timeoutMs, 30_000, 65_000, "timeoutMs");
    this.#maxRows = positive(options.maxRows, 1000, 100_000, "maxRows");
    this.#maxColumns = positive(options.maxColumns, 256, 1024, "maxColumns");
    this.#maxRequestBytes = positive(options.maxRequestBytes, 1_048_576, 16_777_216, "maxRequestBytes");
    this.#maxResponseBytes = positive(options.maxResponseBytes, 8_388_608, 67_108_864, "maxResponseBytes");
    this.#maxValues = positive(options.maxValues, 100_000, 1_000_000, "maxValues");
    this.#maxDepth = positive(options.maxDepth, 16, 32, "maxDepth");
    if (!isObjectMap(options.tables)) throw new TypeError("tables must be an explicit read grant map");
    for (const [logical, table] of Object.entries(options.tables)) {
      nativeIdentifier(logical); nativeIdentifier(table.database); nativeIdentifier(table.table);
      const columns: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [field, physical] of Object.entries(table.columns)) { nativeIdentifier(field); nativeIdentifier(physical); columns[field] = physical; }
      this.#tables.set(logical, Object.freeze({ database: table.database, table: table.table, columns: Object.freeze(columns) }));
    }
  }

  public async queryOrdinal(query: OrdinalQuery, signal?: AbortSignal): Promise<OrdinalQueryResult> {
    const scope = createAbortScope(signal, this.#timeoutMs);
    const cancelled = (): QueryCancelledError => new QueryCancelledError(scope.deadlineExceeded ? "deadline" : "caller");
    let sent = false;
    let headers: Readonly<Record<string, string>> | undefined;
    // Generated IDs contain no user input and cannot escape KILL's literal.
    const id = `dalgo-${globalThis.crypto.randomUUID()}`;
    try {
      if (isAborted(scope.signal)) throw cancelled();
      const compiled = compileOrdinalQuery(query, this.#tables, this.#allowNative, this.#maxRows);
      const parameters = nativeParameters(compiled.parameters, this.#maxRequestBytes);
      const url = new URL(this.#origin);
      url.searchParams.set("query_id", id);
      url.searchParams.set("readonly", "1");
      url.searchParams.set("max_execution_time", String(this.#timeoutMs / 1000));
      url.searchParams.set("max_result_rows", String(this.#maxRows));
      url.searchParams.set("max_result_bytes", String(this.#maxResponseBytes));
      url.searchParams.set("result_overflow_mode", "throw");
      url.searchParams.set("wait_end_of_query", "1");
      url.searchParams.set("buffer_size", String(this.#maxResponseBytes));
      for (const parameter of parameters) url.searchParams.set(`param_${parameter.name}`, parameter.value);
      if (new TextEncoder().encode(compiled.sql).byteLength + new TextEncoder().encode(url.toString()).byteLength > this.#maxRequestBytes) throw new ClickHouseNativeError("bounds");
      let provided: Readonly<Record<string, string>> | undefined;
      try { provided = await raceAbort(Promise.resolve().then(() => this.#headers?.()), scope.signal, cancelled); } catch {
        if (isAborted(scope.signal)) throw cancelled();
        throw new ClickHouseNativeError("transport");
      }
      headers = nativeHeaders(provided);
      sent = true;
      const bytes = await nativeRequest(this.#fetch, url.toString(), compiled.sql, headers, { signal: scope.signal, cancelled }, this.#maxResponseBytes);
      if (isAborted(scope.signal)) throw cancelled();
      const result = decodeClickHouseRowBinary(bytes, { maxRows: this.#maxRows, maxColumns: this.#maxColumns, maxValues: this.#maxValues, maxDepth: this.#maxDepth }, scope.signal);
      if (isAborted(scope.signal)) throw cancelled();
      return result;
    } catch (error) {
      if (isAborted(scope.signal)) {
        if (sent && headers !== undefined) this.cancelServerQuery(id, headers);
        throw cancelled();
      }
      if (error instanceof ClickHouseNativeError) throw error;
      throw new ClickHouseNativeError("transport");
    } finally { scope.dispose(); }
  }

  private cancelServerQuery(id: string, headers: Readonly<Record<string, string>>): void {
    const scope = createAbortScope(undefined, 2000);
    const url = new URL(this.#origin);
    url.searchParams.set("readonly", "1");
    // Killing one's own exact generated ID does not need system.processes SELECT
    // or permission to cancel other users' work. This is a bounded best effort,
    // never evidence that the server stopped: verify externally in real tests.
    void nativeRequest(this.#fetch, url.toString(), `KILL QUERY WHERE query_id = '${id}' SYNC`, headers,
      { signal: scope.signal, cancelled: () => new QueryCancelledError("deadline") }, 65_536)
      .catch(() => undefined).finally(() => { scope.dispose(); });
  }
}
