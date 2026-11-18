import type { StructuredQuery } from "@dalgo/core";
import type { AthenaAction, AthenaAuthority, AthenaSource, AthenaTransport } from "../src/types.js";
export const source: AthenaSource = {
  sourceId: "owned", region: "us-east-1", workGroup: "readers", catalog: "AwsDataCatalog", database: "native",
  outputLocation: "s3://owned-results/athena/", expectedBucketOwner: "111111111111", maxScanBytes: "10000000",
  encryption: { option: "SSE_S3" }, tables: { items: { table: "actual", columns: { id: "varchar", amount: "decimal(38,10)", note: "varchar" }, idColumn: "id" } }
};
export const query = (offset?: number): StructuredQuery<unknown> => ({ source: { kind: "collection", name: "items" }, filters: [], orders: [{ field: "id", direction: "asc" }], ...(offset === undefined ? {} : { offset }) });
export const info = [{ Name: "id", Type: "varchar" }, { Name: "amount", Type: "decimal", Precision: 38, Scale: 10 }, { Name: "note", Type: "varchar" }];
export function result(rows: readonly (readonly (string | null)[])[], next?: string, header = false): unknown {
  return { ResultSet: { ResultSetMetadata: { ColumnInfo: info }, Rows: [...(header ? [["id", "amount", "note"]] : []), ...rows].map(row => ({ Data: row.map(value => value === null ? {} : { VarCharValue: value }) })) }, ...(next === undefined ? {} : { NextToken: next }) };
}
export function json(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/x-amz-json-1.1" } }); }
export function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined, reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
export interface Event { action: AthenaAction; input: Record<string, unknown>; authority: AthenaAuthority; signal: AbortSignal }
export class Fixture implements AthenaTransport {
  public readonly calls: Event[] = []; public auth = 0; public identity = { principal: "owned-reader", generation: "one" };
  public pages: unknown[] = [result([["a", "9007199254740993.0001", ""]], undefined, true)];
  public states = ["SUCCEEDED"]; public scan = "9007199254740993";
  public override: ((event: Event) => Response | Promise<Response> | undefined) | undefined;
  readonly #queries = new Map<string, Record<string, unknown>>(); #sequence = 0;
  public authorize(): AthenaAuthority | Promise<AthenaAuthority> { this.auth++; return { ...this.identity }; }
  public request(action: AthenaAction, body: string, authority: AthenaAuthority, signal: AbortSignal): Response | Promise<Response> {
    const input = JSON.parse(body) as Record<string, unknown>; const event = { action, input, authority, signal }; this.calls.push(event);
    const overridden = this.override?.(event); if (overridden !== undefined) return overridden;
    if (action === "GetWorkGroup") return json({ WorkGroup: { Name: source.workGroup, State: "ENABLED", Configuration: {
      EnforceWorkGroupConfiguration: true, BytesScannedCutoffPerQuery: 10000000, EngineVersion: { EffectiveEngineVersion: "Athena engine version 3" },
      ResultConfiguration: { OutputLocation: source.outputLocation, ExpectedBucketOwner: source.expectedBucketOwner, EncryptionConfiguration: { EncryptionOption: "SSE_S3" } }
    } } });
    if (action === "StartQueryExecution") { const id = "query-" + String(++this.#sequence); this.#queries.set(id, input); return json({ QueryExecutionId: id }); }
    if (action === "GetQueryExecution") {
      const id = String(input.QueryExecutionId), original = this.#queries.get(id); if (original === undefined) throw new Error("fixture unexpected query");
      const state = this.states.length > 1 ? this.states.shift() : this.states[0];
      const payload = { QueryExecution: { QueryExecutionId: id, Query: original.QueryString, QueryExecutionContext: original.QueryExecutionContext, WorkGroup: original.WorkGroup, ExecutionParameters: original.ExecutionParameters,
        ResultConfiguration: { OutputLocation: source.outputLocation + id + ".csv", ExpectedBucketOwner: source.expectedBucketOwner, EncryptionConfiguration: { EncryptionOption: "SSE_S3" } },
        Status: { State: state }, Statistics: { DataScannedInBytes: this.scan } } };
      return new Response(JSON.stringify(payload).replace('"DataScannedInBytes":"' + this.scan + '"', '"DataScannedInBytes":' + this.scan), { headers: { "content-type": "application/x-amz-json-1.1" } });
    }
    if (action === "GetQueryResults") {
      const token = input.NextToken; const index = token === undefined ? 0 : Number(String(token).slice(1));
      const page = this.pages[index]; if (page === undefined) throw new Error("fixture missing page"); return json(page);
    }
    return new Response(null, { status: 200 });
  }
}
