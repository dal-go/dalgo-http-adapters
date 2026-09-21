import {
  Key, UnsupportedError, identityCodec,
  type Codec, type Database, type ExistingRecord, type QueryPage, type ReadwriteTransaction, type RecordSnapshot, type StructuredQuery, type UpdateData,
} from "@dal-go/dalgo";
import type { TimestreamCredentials, TimestreamDatabaseOptions, TimestreamQueryPage, TimestreamRecord, TimestreamTable, TimestreamWriteResult } from "./types.js";

type JsonObject = Record<string, unknown>;
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const regionName = /^[a-z][a-z0-9-]*$/u;
const encoder = new TextEncoder();

function object(value: unknown): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
function positive(value: number | undefined, fallback: number, label: string): number { const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${label} must be a positive safe integer`); return result; }
function name(value: string, label: string): string { if (!identifier.test(value)) throw new TypeError(`${label} must be a simple SQL identifier`); return value; }
function quoted(value: string, label: string): string { return `"${name(value, label)}"`; }
function codec<T>(value?: Codec<T>): Codec<T> { return (value ?? identityCodec) as Codec<T>; }
function isLoopback(url: URL): boolean { return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"; }

function endpoint(value: string, label: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new TypeError(`${label} must be an absolute URL`); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) throw new TypeError(`${label} must use HTTPS except for loopback tests`);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) throw new TypeError(`${label} must be an origin without credentials, path, query, or fragment`);
  return url.origin;
}

function tables(input: Readonly<Record<string, TimestreamTable>>): Readonly<Record<string, TimestreamTable>> {
  const result: Record<string, TimestreamTable> = {};
  for (const [collection, table] of Object.entries(input)) {
    name(collection, "collection"); name(table.table, "Timestream table"); name(table.keyColumn, "key column");
    const seen = new Set([table.keyColumn]); const columns: Record<string, string> = {};
    for (const [field, column] of Object.entries(table.columns)) { name(field, "mapped field"); name(column, "mapped column"); if (seen.has(column)) throw new TypeError(`duplicate mapped Timestream column: ${column}`); seen.add(column); columns[field] = column; }
    result[collection] = Object.freeze({ table: table.table, keyColumn: table.keyColumn, columns: Object.freeze(columns) });
  }
  return Object.freeze(result);
}

function amzDate(now: Date): string { return now.toISOString().replace(/[:-]|\.\d{3}/gu, ""); }
function day(value: string): string { return value.slice(0, 8); }
function hex(bytes: ArrayBuffer): string { return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function sha256(value: string): Promise<string> { return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value))); }
function bytes(value: string): ArrayBuffer { const source = encoder.encode(value); return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer; }
async function hmac(key: ArrayBuffer, value: string): Promise<ArrayBuffer> { const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return crypto.subtle.sign("HMAC", imported, bytes(value)); }
async function signingKey(secret: string, date: string, region: string, service: string): Promise<ArrayBuffer> { const kDate = await hmac(bytes(`AWS4${secret}`), date); const kRegion = await hmac(kDate, region); const kService = await hmac(kRegion, service); return hmac(kService, "aws4_request"); }

/** Deliberately excludes response text, query text, request bodies, and credentials. */
export class TimestreamHttpError extends Error {
  public readonly status: number;
  public constructor(status: number) { super(`Timestream request failed with HTTP ${String(status)}`); this.name = "TimestreamHttpError"; this.status = status; }
}

/**
 * Bounded DALgo read view plus explicit Timestream Query and WriteRecords helpers.
 * Generic CRUD is intentionally absent: Timestream records are append-oriented and reads are eventually consistent.
 */
export class TimestreamDatabase implements Database {
  readonly #region: string; readonly #database: string; readonly #credentials: TimestreamDatabaseOptions["credentials"];
  readonly #tables: Readonly<Record<string, TimestreamTable>>; readonly #queryEndpoint: string; readonly #writeEndpoint: string;
  readonly #maxRows: number; readonly #maxResponseBytes: number; readonly #maxWriteRecords: number; readonly #timeoutMs: number; readonly #fetch: NonNullable<TimestreamDatabaseOptions["fetch"]>;

  public constructor(options: TimestreamDatabaseOptions) {
    if (!regionName.test(options.region)) throw new TypeError("region must be an AWS region identifier"); name(options.database, "database"); if (typeof options.credentials !== "function") throw new TypeError("credentials must be a refreshable function");
    this.#region = options.region; this.#database = options.database; this.#credentials = options.credentials; this.#tables = tables(options.tables);
    this.#queryEndpoint = endpoint(options.queryEndpoint ?? `https://query.timestream.${options.region}.amazonaws.com`, "queryEndpoint");
    this.#writeEndpoint = endpoint(options.writeEndpoint ?? `https://ingest.timestream.${options.region}.amazonaws.com`, "writeEndpoint");
    this.#maxRows = positive(options.maxRows, 1000, "maxRows"); if (this.#maxRows > 1000) throw new RangeError("maxRows cannot exceed Timestream Query MaxRows (1000)");
    this.#maxResponseBytes = positive(options.maxResponseBytes, 1024 * 1024, "maxResponseBytes"); this.#maxWriteRecords = positive(options.maxWriteRecords, 100, "maxWriteRecords"); if (this.#maxWriteRecords > 100) throw new RangeError("maxWriteRecords cannot exceed WriteRecords batch limit (100)");
    this.#timeoutMs = positive(options.timeoutMs, 30_000, "timeoutMs"); this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async get<T>(key: Key, valueCodec?: Codec<T>): Promise<RecordSnapshot<T>> {
    this.key(key); const table = this.table(key.collection);
    const projection = [`${quoted(table.keyColumn, "key column")} AS "__dalgo_key"`, ...Object.entries(table.columns).map(([field, column]) => `${quoted(column, "mapped column")} AS ${quoted(field, "mapped field")}`)].join(", ");
    const value = key.id.replaceAll("'", "''");
    const page = await this.querySql(`SELECT ${projection} FROM ${quoted(this.#database, "database")}.${quoted(table.table, "Timestream table")} WHERE ${quoted(table.keyColumn, "key column")} = '${value}' LIMIT 2`, 2);
    if (page.rows.length === 0) return { key, exists: false };
    if (page.rows.length !== 1) throw new UnsupportedError("Timestream get requires a uniquely mapped key column");
    return this.snapshot(key, page.rows[0] ?? {}, valueCodec);
  }

  public async getMany<T>(keys: readonly Key[], valueCodec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length > this.#maxRows) throw new UnsupportedError(`Timestream getMany above configured maxRows (${String(this.#maxRows)})`);
    return Promise.all(keys.map((key) => this.get(key, valueCodec)));
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    if (query.source.kind !== "collection" || query.source.parent !== undefined) throw new UnsupportedError("Timestream collection-group and nested collection queries");
    if (query.filters.length || query.orders.length || query.offset !== undefined || query.startAt !== undefined || query.startAfter !== undefined || query.endAt !== undefined || query.endBefore !== undefined) throw new UnsupportedError("Timestream generic DALgo filters, orders, offsets, and cursors; use querySql");
    const requested = query.limit ?? this.#maxRows; if (!Number.isSafeInteger(requested) || requested < 1 || requested > this.#maxRows) throw new UnsupportedError("Timestream query limit");
    const table = this.table(query.source.name); const projection = [`${quoted(table.keyColumn, "key column")} AS "__dalgo_key"`, ...Object.entries(table.columns).map(([field, column]) => `${quoted(column, "mapped column")} AS ${quoted(field, "mapped field")}`)].join(", ");
    const page = await this.querySql(`SELECT ${projection} FROM ${quoted(this.#database, "database")}.${quoted(table.table, "Timestream table")} LIMIT ${String(requested)}`, requested);
    if (page.nextToken !== undefined) throw new UnsupportedError("Timestream generic DALgo query cannot expose a service NextToken; use querySql");
    return { records: page.rows.map((row) => this.snapshot(new Key(query.source.name, this.rowKey(row)), row, query.source.codec) as ExistingRecord<T>) };
  }

  /** Executes bounded read-only Timestream SQL. Pass the returned nextToken verbatim to continue pagination. */
  public async querySql(queryString: string, maxRows = this.#maxRows, nextToken?: string): Promise<TimestreamQueryPage> {
    if (typeof queryString !== "string" || queryString.trim() === "" || queryString.includes("\u0000") || queryString.includes(";")) throw new TypeError("querySql requires one non-empty SQL statement without NUL or semicolon");
    if (!/^\s*(select|with)\b/iu.test(queryString)) throw new UnsupportedError("querySql only permits read-only SELECT or WITH statements");
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > this.#maxRows) throw new RangeError(`maxRows must be between 1 and ${String(this.#maxRows)}`);
    if (nextToken !== undefined && (typeof nextToken !== "string" || nextToken.length === 0 || nextToken.length > 2048)) throw new TypeError("nextToken must be a non-empty Timestream token");
    const request: JsonObject = { QueryString: queryString, MaxRows: maxRows, ...(nextToken === undefined ? {} : { NextToken: nextToken }) };
    const parsed = await this.request(this.#queryEndpoint, "timestream-query", "Timestream_20181101.Query", request);
    return this.parseQuery(parsed);
  }

  /** Writes at most the configured 100 native time-series records; this is not DALgo insert/set/update. */
  public async writeRecords(table: string, records: readonly TimestreamRecord[], commonAttributes?: TimestreamRecord): Promise<TimestreamWriteResult> {
    name(table, "Timestream table"); if (!Array.isArray(records) || records.length === 0 || records.length > this.#maxWriteRecords) throw new RangeError(`writeRecords requires 1 to ${String(this.#maxWriteRecords)} records`);
    for (const record of records) this.record(record); if (commonAttributes !== undefined) this.record(commonAttributes);
    const parsed = await this.request(this.#writeEndpoint, "timestream-write", "Timestream_20181101.WriteRecords", { DatabaseName: this.#database, TableName: table, Records: records, ...(commonAttributes === undefined ? {} : { CommonAttributes: commonAttributes }) });
    if (!object(parsed) || !object(parsed.RecordsIngested)) throw new TypeError("malformed Timestream WriteRecords response");
    const result: Record<string, number> = {}; for (const [kind, count] of Object.entries(parsed.RecordsIngested)) { if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new TypeError("malformed Timestream ingested count"); result[kind] = count; }
    return { recordsIngested: Object.freeze(result) };
  }

  public async insert<T>(key: Key, data: T, valueCodec?: Codec<T>): Promise<void> { void key; void data; void valueCodec; throw new UnsupportedError("Timestream insert semantics; use writeRecords"); }
  public async set<T>(key: Key, data: T, valueCodec?: Codec<T>): Promise<void> { void key; void data; void valueCodec; throw new UnsupportedError("Timestream replacement semantics; use writeRecords"); }
  public async update(key: Key, data: UpdateData): Promise<void> { void key; void data; throw new UnsupportedError("Timestream partial-update semantics"); }
  public async delete(key: Key): Promise<void> { void key; throw new UnsupportedError("Timestream delete semantics"); }
  public async runReadwriteTransaction<Result>(callback: (transaction: ReadwriteTransaction) => Promise<Result>): Promise<Result> { void callback; throw new UnsupportedError("Timestream callback transactions"); }

  private key(key: Key): asserts key is Key<string> { if (key.parent !== undefined) throw new UnsupportedError("Timestream nested collection keys"); if (typeof key.id !== "string") throw new UnsupportedError("Timestream keys must be strings"); }
  private table(collection: string): TimestreamTable { const table = this.#tables[collection]; if (table === undefined) throw new UnsupportedError(`Timestream collection is not mapped: ${collection}`); return table; }
  private rowKey(row: Readonly<JsonObject>): string { const key = row.__dalgo_key; if (typeof key !== "string") throw new TypeError("Timestream key column must decode as VARCHAR"); return key; }
  private snapshot<T>(key: Key<string>, row: Readonly<JsonObject>, valueCodec?: Codec<T>): RecordSnapshot<T> { const data = { ...row }; delete data.__dalgo_key; return { key, exists: true, data: codec(valueCodec).decode(data) }; }

  private record(record: TimestreamRecord): void {
    if (!object(record)) throw new TypeError("Timestream record must be an object");
    if (record.MeasureValueType === "MULTI" ? !Array.isArray(record.MeasureValues) || record.MeasureValues.length === 0 : typeof record.MeasureName !== "string" || typeof record.MeasureValue !== "string" || record.MeasureValueType === undefined) throw new TypeError("Timestream record must have one single measure or non-empty MULTI MeasureValues");
    if (record.Dimensions !== undefined && (!Array.isArray(record.Dimensions) || record.Dimensions.some((dimension) => !object(dimension) || typeof dimension.Name !== "string" || typeof dimension.Value !== "string"))) throw new TypeError("Timestream dimensions must have string Name and Value");
  }

  private async request(origin: string, service: "timestream-query" | "timestream-write", target: string, body: JsonObject): Promise<unknown> {
    const text = JSON.stringify(body); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const credentials = await this.credentials(controller.signal); const now = amzDate(new Date()); const payloadHash = await sha256(text); const host = new URL(origin).host;
      const headers: Record<string, string> = { "content-type": "application/x-amz-json-1.0", host, "x-amz-content-sha256": payloadHash, "x-amz-date": now, "x-amz-target": target };
      if (credentials.sessionToken !== undefined) headers["x-amz-security-token"] = credentials.sessionToken;
      const signedHeaders = Object.keys(headers).sort(); const canonicalHeaders = signedHeaders.map((header) => `${header}:${headers[header] ?? ""}\n`).join("");
      const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders.join(";")}\n${payloadHash}`; const scope = `${day(now)}/${this.#region}/${service}/aws4_request`;
      const stringToSign = `AWS4-HMAC-SHA256\n${now}\n${scope}\n${await sha256(canonicalRequest)}`; const signature = hex(await hmac(await signingKey(credentials.secretAccessKey, day(now), this.#region, service), stringToSign));
      headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`;
      const response = await this.#fetch(origin, { method: "POST", redirect: "error", signal: controller.signal, headers, body: text });
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new TimestreamHttpError(response.status); }
      const parsed = JSON.parse(await this.body(response)) as unknown; return parsed;
    } finally { clearTimeout(timer); }
  }

  private async credentials(signal: AbortSignal): Promise<TimestreamCredentials> {
    const result = await Promise.race([Promise.resolve(this.#credentials()), new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("Timestream request timed out")), { once: true }))]);
    if (!object(result) || typeof result.accessKeyId !== "string" || result.accessKeyId.trim() === "" || typeof result.secretAccessKey !== "string" || result.secretAccessKey.trim() === "" || (result.sessionToken !== undefined && (typeof result.sessionToken !== "string" || result.sessionToken === ""))) throw new TypeError("credentials must return non-empty AWS access key and secret");
    return result as TimestreamCredentials;
  }

  private async body(response: Response): Promise<string> {
    const advertised = response.headers.get("content-length"); if (advertised !== null && (!/^\d+$/u.test(advertised) || Number(advertised) > this.#maxResponseBytes)) { void response.body?.cancel().catch(() => undefined); throw new RangeError("Timestream response exceeds maxResponseBytes"); }
    if (response.body === null) throw new TypeError("Timestream response has no body"); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.byteLength; if (length > this.#maxResponseBytes) { await reader.cancel(); throw new RangeError("Timestream response exceeds maxResponseBytes"); } chunks.push(item.value); } } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return new TextDecoder().decode(bytes);
  }

  private parseQuery(value: unknown): TimestreamQueryPage {
    if (!object(value) || !Array.isArray(value.ColumnInfo) || !Array.isArray(value.Rows) || typeof value.QueryId !== "string") throw new TypeError("malformed Timestream Query response");
    const columns = value.ColumnInfo.map((column, index) => { if (!object(column) || typeof column.Name !== "string" || !object(column.Type)) throw new TypeError(`malformed Timestream column ${String(index)}`); return column; });
    const names = columns.map((column) => column.Name as string); if (new Set(names).size !== names.length) throw new TypeError("Timestream Query returned duplicate column names");
    const rows = value.Rows.map((row, index) => { if (!object(row) || !Array.isArray(row.Data) || row.Data.length !== columns.length) throw new TypeError(`malformed Timestream row ${String(index)}`); const result: JsonObject = {}; for (let column = 0; column < columns.length; column += 1) { const info = columns[column]; const datum = row.Data[column]; if (info === undefined || datum === undefined) throw new TypeError("malformed Timestream row data"); result[info.Name as string] = this.datum(info.Type as JsonObject, datum); } return Object.freeze(result); });
    if (value.NextToken !== undefined && (typeof value.NextToken !== "string" || value.NextToken.length === 0)) throw new TypeError("malformed Timestream NextToken");
    return Object.freeze({ columns: Object.freeze(names), rows: Object.freeze(rows), queryId: value.QueryId, ...(value.NextToken === undefined ? {} : { nextToken: value.NextToken }) });
  }

  private datum(type: JsonObject, datum: unknown): unknown {
    if (!object(datum)) throw new TypeError("malformed Timestream datum"); if (datum.NullValue === true) return null;
    if (typeof type.ScalarType === "string") { if (typeof datum.ScalarValue !== "string") throw new TypeError("malformed Timestream scalar"); const value = datum.ScalarValue; switch (type.ScalarType) { case "VARCHAR": case "TIMESTAMP": case "DATE": case "TIME": case "INTERVAL_DAY_TO_SECOND": case "INTERVAL_YEAR_TO_MONTH": case "UNKNOWN": return value; case "BOOLEAN": if (value === "true") return true; if (value === "false") return false; break; case "INTEGER": { const parsed = Number(value); if (Number.isSafeInteger(parsed)) return parsed; break; } case "BIGINT": try { return BigInt(value); } catch { break; } case "DOUBLE": { const parsed = Number(value); if (!Number.isNaN(parsed)) return parsed; break; } default: break; } throw new TypeError(`invalid Timestream ${type.ScalarType} scalar`); }
    const arrayInfo = type.ArrayColumnInfo;
    if (object(arrayInfo)) { const itemType = arrayInfo.Type; if (!object(itemType) || !Array.isArray(datum.ArrayValue)) throw new TypeError("malformed Timestream array"); return datum.ArrayValue.map((item) => this.datum(itemType, item)); }
    if (Array.isArray(type.RowColumnInfo)) { if (!object(datum.RowValue) || !Array.isArray(datum.RowValue.Data) || datum.RowValue.Data.length !== type.RowColumnInfo.length) throw new TypeError("malformed Timestream row datum"); const result: JsonObject = {}; for (let index = 0; index < type.RowColumnInfo.length; index += 1) { const info = type.RowColumnInfo[index]; const item = datum.RowValue.Data[index]; if (!object(info) || typeof info.Name !== "string" || !object(info.Type) || item === undefined) throw new TypeError("malformed Timestream row column"); result[info.Name] = this.datum(info.Type, item); } return result; }
    const seriesInfo = type.TimeSeriesMeasureValueColumnInfo;
    if (object(seriesInfo)) { const valueType = seriesInfo.Type; if (!object(valueType) || !Array.isArray(datum.TimeSeriesValue)) throw new TypeError("malformed Timestream timeseries"); return datum.TimeSeriesValue.map((point) => { if (!object(point) || typeof point.Time !== "string" || point.Value === undefined) throw new TypeError("malformed Timestream timeseries point"); return Object.freeze({ time: point.Time, value: this.datum(valueType, point.Value) }); }); }
    throw new TypeError("unsupported Timestream column type");
  }
}
