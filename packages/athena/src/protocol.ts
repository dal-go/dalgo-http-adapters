import { fail } from "./errors.js";
import { decode, JsonInteger, object, utf8 } from "./json.js";
import { integer, type Operation } from "./operation.js";
import type { ReadPlan } from "./compiler.js";
import type { AthenaAction, AthenaAuthority, AthenaColumn, AthenaSource, AthenaTransport } from "./types.js";
import { array, field, text } from "./validation.js";
const responseBody = Object.getOwnPropertyDescriptor(Response.prototype, "body")?.get;
const responseHeaders = Object.getOwnPropertyDescriptor(Response.prototype, "headers")?.get;
const responseStatus = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get;
function native<T>(getter: ((this: Response) => unknown) | undefined, response: Response): T {
  if (getter === undefined) throw fail("protocol"); return Reflect.apply(getter, response, []) as T;
}
function body(response: Response): ReadableStream<Uint8Array> | null { return native(responseBody, response); }
export { body as responseBodyStream };
export function httpHeaders(response: Response): Headers { return native(responseHeaders, response); }
export function httpStatus(response: Response): number { return native(responseStatus, response); }
export function authority(value: unknown): AthenaAuthority {
  const principal = text(field(value, "principal"), 1024), generation = text(field(value, "generation"), 256);
  return { principal, generation };
}
export function sameAuthority(a: AthenaAuthority, b: AthenaAuthority): boolean { return a.principal === b.principal && a.generation === b.generation; }
export async function call(transport: AthenaTransport, action: AthenaAction, wire: string, credential: AthenaAuthority, op: Operation, empty = false): Promise<Record<string, unknown>> {
  op.request(utf8(wire)); let owned: Response | undefined; let reading = false;
  try {
    const response = await op.io(() => Promise.resolve(transport.request(action, wire, credential, op.signal)).then(value => { owned = value; return value; }), value => { op.cleanup(body(value)); });
    const headers = native<Headers>(responseHeaders, response); let size = 0; let count = 0;
    for (const [name, value] of headers) { if (++count > 512 || (size += utf8(name) + utf8(value)) > 65_536) throw fail("bounds"); }
    op.budget.bytes += size; if (op.budget.bytes > op.limits.maxResponseBytes) throw fail("bounds");
    const length = headers.get("content-length"); if (length !== null && (!/^\d+$/u.test(length) || Number(length) > op.limits.maxPageBytes)) throw fail("bounds");
    const status = native<number>(responseStatus, response);
    reading = true; const stream = body(response); const bytes = empty && stream === null ? new Uint8Array() : await op.bytes(stream); op.check();
    if (status !== 200) throw fail(status === 401 || status === 403 ? "permission" : "transport", status);
    if (empty) { if (bytes.length !== 0) throw fail("protocol"); return {}; }
    if (!["application/x-amz-json-1.1", "application/json"].includes(headers.get("content-type")?.split(";")[0]?.trim() ?? "")) throw fail("protocol");
    op.newDocument(); return object(decode(new TextDecoder("utf-8", { fatal: true }).decode(bytes), op));
  } finally { if (!reading && owned !== undefined) op.cleanup(body(owned)); }
}
export function long(value: unknown): string {
  if (value instanceof JsonInteger && /^\d+$/u.test(value.value)) return value.value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw fail("protocol"); return String(value);
}
function resultConfiguration(value: unknown, source: AthenaSource, execution: boolean): void {
  const config = object(value);
  if (typeof config.OutputLocation !== "string" || (execution ? !config.OutputLocation.startsWith(source.outputLocation) : config.OutputLocation !== source.outputLocation)) throw fail("protocol");
  if (config.ExpectedBucketOwner !== source.expectedBucketOwner) throw fail("protocol");
  const encryption = object(config.EncryptionConfiguration);
  if (encryption.EncryptionOption !== source.encryption.option || source.encryption.option === "SSE_KMS" && encryption.KmsKey !== source.encryption.kmsKey) throw fail("protocol");
}
export function preflight(value: unknown, source: AthenaSource): void {
  const work = object(object(value).WorkGroup), config = object(work.Configuration);
  if (work.Name !== source.workGroup || work.State !== "ENABLED" || config.EnforceWorkGroupConfiguration !== true) throw fail("permission");
  const cutoff = BigInt(long(config.BytesScannedCutoffPerQuery));
  if (cutoff < 10_000_000n || cutoff > BigInt(source.maxScanBytes)) throw fail("permission");
  const version = object(config.EngineVersion).EffectiveEngineVersion;
  if (typeof version !== "string" || !/^Athena engine version [2-9]\d*$/u.test(version)) throw fail("protocol");
  if (config.ManagedQueryResultsConfiguration !== undefined && object(config.ManagedQueryResultsConfiguration).Enabled === true || config.IdentityCenterConfiguration !== undefined && object(config.IdentityCenterConfiguration).EnableIdentityCenter === true) throw fail("configuration");
  resultConfiguration(config.ResultConfiguration, source, false);
}
export function execution(value: unknown, source: AthenaSource, plan: ReadPlan, queryId: string): { state: string; scanned?: string } {
  const query = object(object(value).QueryExecution), context = object(query.QueryExecutionContext);
  if (query.QueryExecutionId !== queryId || query.WorkGroup !== source.workGroup || query.Query !== plan.sql || context.Catalog !== source.catalog || context.Database !== source.database) throw fail("protocol");
  if (query.ExecutionParameters !== undefined) {
    const values = array(query.ExecutionParameters, 64);
    if (values.length !== plan.parameters.length || values.some((v, i) => v !== plan.parameters[i])) throw fail("protocol");
  }
  resultConfiguration(query.ResultConfiguration, source, true);
  const state = text(object(query.Status).State, 16); if (!["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"].includes(state)) throw fail("protocol");
  const scanned = query.Statistics === undefined || object(query.Statistics).DataScannedInBytes === undefined ? undefined : long(object(query.Statistics).DataScannedInBytes);
  return { state, ...(scanned === undefined ? {} : { scanned }) };
}
function optionalText(record: Record<string, unknown>, name: string): string | undefined { const value = record[name]; return value === undefined ? undefined : value === "" ? "" : text(value, 4096); }
function columns(value: unknown, plan: ReadPlan, op: Operation): AthenaColumn[] {
  const fields = array(object(value).ColumnInfo, op.limits.maxColumns); if (fields.length !== plan.columns.length) throw fail("protocol");
  return fields.map((item, i) => {
    const info = object(item); const name = text(info.Name), type = text(info.Type, 256); if (name !== plan.columns[i]) throw fail("protocol");
    const base = (value: string): string => value.toLowerCase().replace(/[<(].*$/u, "").replace(/^int$/u, "integer").replace(/^string$/u, "varchar");
    if (base(type) !== base(plan.types[i] ?? "")) throw fail("protocol");
    const result: { name: string; type: string; label?: string; catalog?: string; schema?: string; table?: string; precision?: number; scale?: number; nullable?: string; caseSensitive?: boolean } = { name, type };
    for (const [key, wire] of [["label", "Label"], ["catalog", "CatalogName"], ["schema", "SchemaName"], ["table", "TableName"], ["nullable", "Nullable"]] as const) { const v = optionalText(info, wire); if (v !== undefined) result[key] = v; }
    for (const [key, wire] of [["precision", "Precision"], ["scale", "Scale"]] as const) if (info[wire] !== undefined) result[key] = integer(info[wire], 0, 2_147_483_647);
    if (info.CaseSensitive !== undefined) { if (typeof info.CaseSensitive !== "boolean") throw fail("protocol"); result.caseSensitive = info.CaseSensitive; }
    return result;
  });
}
export interface PendingPage { columns: AthenaColumn[]; rows: (string | null)[][]; next?: string; header: boolean }
export function page(value: unknown, plan: ReadPlan, priorColumns: readonly AthenaColumn[] | undefined, headerConsumed: boolean, op: Operation): PendingPage {
  const payload = object(value), set = object(payload.ResultSet);
  const next = payload.NextToken === undefined ? undefined : text(payload.NextToken, 1024);
  const metadata = set.ResultSetMetadata === undefined ? priorColumns === undefined ? undefined : [...priorColumns] : columns(set.ResultSetMetadata, plan, op);
  if (metadata === undefined || priorColumns !== undefined && JSON.stringify(metadata) !== JSON.stringify(priorColumns)) throw fail("protocol");
  const width = metadata.length, rawRows = array(set.Rows ?? [], 1000); const result: (string | null)[][] = []; let header = headerConsumed;
  for (const rawRow of rawRows) {
    op.check(); const data = array(object(rawRow).Data ?? [], width); const row: (string | null)[] = [];
    for (let i = 0; i < width; i++) {
      const cell = data[i]; const value = cell === undefined ? undefined : object(cell).VarCharValue;
      if (value !== undefined && value !== null && typeof value !== "string") throw fail("protocol"); row.push(value ?? null);
    }
    if (!header) { if (row.some((cell, i) => cell !== metadata[i]?.name)) throw fail("protocol"); header = true; continue; }
    result.push(row);
  }
  if (!header && next === undefined) throw fail("protocol");
  return { columns: metadata, rows: result, ...(next === undefined ? {} : { next }), header };
}
