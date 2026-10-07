// Synthetic-only consumer. Never exported by the HTTP package.
import {
  Key, UnsupportedError, executeSourceComposedJoinedDTQLQuery, isJoinedDTQLQuery,
  parseDTQL, providerEvidenceDigest, requireNoSourceComposition,
  requireSourceCompositionConsumer, snapshotQueryMetadata,
  type AdmittedMaterializedJoinInput, type JoinedDTQLQuery, type ProviderReadPlan,
  type QueryExecutor, type QueryPage, type SourceCompositionJoinOptions,
  type SourceRight, type StructuredQuery,
} from "@dalgo/core";
import { ECB_DAILY_URL, ECBQueryExecutor, type ECBQueryOptions } from "@dal-go/dalgo2http";

export const syntheticXML = `<g:Envelope xmlns:g="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><Cube><Cube time="2037-02-03"><Cube currency="AAA" rate="001.23000"/><Cube currency="ZZZ" rate="0.00001"/></Cube></Cube></g:Envelope>`;
export interface Descriptor { readonly currency: string; readonly name: string; readonly note: { readonly text: string } }
export const descriptors: readonly Descriptor[] = [
  { currency: "AAA", name: "Invented Alpha", note: { text: "Fabricated descriptor; rights unknown" } },
];

/** Trusted fixture literals only; this is not a local database/query facade. */
export class ImmutableDescriptors implements QueryExecutor {
  readonly #records: QueryPage<Descriptor>["records"];
  public readonly maxRows: number;
  public readonly requestedLimit: number;
  public constructor(rows: readonly Descriptor[]) {
    const detached = structuredClone(rows);
    this.#records = Object.freeze(detached.map((row) => Object.freeze({
      key: Object.freeze(new Key("descriptors", row.currency)), exists: true as const,
      data: Object.freeze({ currency: row.currency, name: row.name, note: Object.freeze({ text: row.note.text }) }),
    })));
    this.maxRows = detached.length;
    this.requestedLimit = Math.max(1, this.maxRows);
    Object.freeze(this);
  }
  public query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    const source = query.source;
    if (source.kind !== "collection" || source.name !== "descriptors"
      || source.parent !== undefined || source.codec !== undefined
      || query.filters.length !== 0 || query.orders.length !== 0
      || (query.offset ?? 0) !== 0 || query.startAt !== undefined || query.startAfter !== undefined
      || query.endAt !== undefined || query.endBefore !== undefined
      || query.limit !== this.requestedLimit) {
      throw new UnsupportedError("synthetic descriptors exact admitted scan");
    }
    // Validation precedes any record access; the entire immutable array is returned.
    return Promise.resolve(Object.freeze({ records: this.#records as QueryPage<T>["records"] }));
  }
  public admittedInput(): AdmittedMaterializedJoinInput {
    return { executor: this, source: { serverId: "synthetic-local", recordset: "descriptors" },
      semanticRef: "synthetic-descriptor/native-currency-code/1",
      scanQuery: { source: { kind: "collection", name: "descriptors" }, filters: [], orders: [], limit: this.requestedLimit },
      scope: { kind: "complete", contractRef: "synthetic-immutable-descriptors/1", proof: "immutable-local-array",
        requestedLimit: this.requestedLimit, maxRows: this.maxRows }, admission: { kind: "unknown-local" } };
  }
}

export async function syntheticPlan(): Promise<ProviderReadPlan> {
  const right: SourceRight = {
    sourceId: "rights:synthetic/daily", source: { serverId: "synthetic", recordset: "daily" },
    declaration: { text: "Fabricated permission\n preserve whitespace" }, declarationScope: "recordset",
    declaredAt: { serverId: "synthetic", recordset: "daily" }, evidenceOrigin: "fixture-only",
    pins: [], transformations: ["ecb-eurofxref/1 XML to native strings"],
    attribution: { text: "Synthetic fixture credit" },
  };
  return {
    execution: { id: "synthetic-execution", mode: "direct", executorId: "synthetic-browser" },
    bindings: [{ providerSourceId: "provider:synthetic", rightsSourceId: right.sourceId, resourceId: "daily",
      definitionDigest: "a".repeat(64), decoderDigest: "b".repeat(64),
      rightsDigest: await providerEvidenceDigest({ format: "ovdb-rights-binding/1", right }) }],
    requests: [{ resourceId: "daily", method: "GET", upstreamUrl: ECB_DAILY_URL, params: {} }],
    sourceRights: [right], usedSourceIds: [right.sourceId],
  };
}

export function joinedQuery(kind: "inner" | "left" = "inner", projected = false, emptyWhere = false): JoinedDTQLQuery {
  const parsed = parseDTQL({
    from: { name: "daily", alias: "q", joins: [{ type: kind, from: { name: "descriptors", alias: "d" },
      on: [{ left: { field: "currency", source: "q" }, op: "==", right: { field: "currency", source: "d" } }] }] },
    columns: projected ? [{ field: "name", source: "d", as: "name" }] : [
      { field: "currency", source: "q", as: "currency" }, { field: "time", source: "q", as: "time" },
      { field: "rate", source: "q", as: "rate" }, { field: "name", source: "d", as: "name" },
    ],
    ...(emptyWhere ? { where: { left: { field: "currency", source: "q" }, op: "==", right: { value: "BBB" } } } : {}),
  }, { tables: [{ name: "daily", fields: ["currency", "time", "rate"] }, { name: "descriptors", fields: ["currency", "name"] }] });
  if (!isJoinedDTQLQuery(parsed)) throw new Error("expected synthetic join");
  return parsed;
}

export function joinOptions(executor: QueryExecutor, plan: ProviderReadPlan, local: ImmutableDescriptors): SourceCompositionJoinOptions {
  return { compositionId: "synthetic-browser-composition", maxFetchedRows: 512, maxResultRows: 512,
    maxRetainedBytes: 128 * 1024, maxMetadataBytes: 32 * 1024,
    resolveInput: (relation) => {
      if (relation.name === "descriptors") return local.admittedInput();
      if (relation.name !== "daily") throw new UnsupportedError("synthetic relation");
      return { executor, source: { serverId: "synthetic-browser", recordset: "daily" },
        semanticRef: "synthetic-native-quote/date-and-decimal-string/1",
        scanQuery: { source: { kind: "collection", name: "daily" }, filters: [], orders: [], limit: 256 },
        scope: { kind: "complete", contractRef: "ecb-eurofxref/1:synthetic-full-feed", proof: "ecb-full-decoded-feed", requestedLimit: 256 },
        admission: { kind: "provider-get", plan } };
    } };
}

export async function syntheticExecutor(options: Pick<ECBQueryOptions, "fetch" | "parser">): Promise<{ executor: ECBQueryExecutor; plan: ProviderReadPlan }> {
  const plan = await syntheticPlan();
  return { plan, executor: new ECBQueryExecutor({ ...options, collectionName: "daily", executorId: "synthetic-browser", providerReadPlan: plan }) };
}

/** Validate/snapshot metadata before row getters. Only a transient viewer is supported. */
export function viewSnapshot(page: QueryPage<Record<string, unknown>>) {
  requireSourceCompositionConsumer(page, "in-memory-viewer");
  const metadata = snapshotQueryMetadata(page);
  if (metadata.sourceComposition === undefined) throw new TypeError("missing synthetic composition");
  return { synthetic: true, metadata, rows: page.records.map((record) => record.data),
    notices: metadata.sourceComposition.inputs.map((input) => ({
      source: input.source, rightsStatus: input.rightsStatus, scope: input.scope,
      declarations: input.metadata.sourceRights?.map((right) => right.declaration.text) ?? [],
      attributions: input.metadata.sourceRights?.map((right) => right.attribution?.text ?? "") ?? [],
    })) };
}

/** Refuse raw composition presence before rows or sink dispatch, even if malformed. */
export function unsupportedSink(page: object, dispatch: () => void): void {
  requireNoSourceComposition(page);
  dispatch();
}

export async function materialize(executor: QueryExecutor, plan: ProviderReadPlan,
  rows: readonly Descriptor[] = descriptors, query = joinedQuery()) {
  return executeSourceComposedJoinedDTQLQuery(query, joinOptions(executor, plan, new ImmutableDescriptors(rows)));
}
