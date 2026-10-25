import {
  Key, UnsupportedError, providerEvidenceDigest, validateProviderReads,
  type ProviderReadObservation, type ProviderReadPlan, type QueryExecutor,
  type QueryMetadata, type QueryPage, type StructuredQuery,
} from "@dalgo/core";
import { decodeECBDaily, type XMLParser } from "./ecb-xml.js";
import { ECB_DAILY_URL, readECBXML, type ECBTransportOptions } from "./transport.js";

export interface ECBQueryOptions extends ECBTransportOptions {
  readonly collectionName: string;
  readonly executorId: string;
  /** Independently verified definitions, decoder binding and permission to read. */
  readonly providerReadPlan: ProviderReadPlan;
  /** Test injection; production uses the Window's native DOMParser. */
  readonly parser?: XMLParser;
}

async function evidence(plan: ProviderReadPlan, observation: Omit<ProviderReadObservation, "observationId">): Promise<QueryMetadata> {
  const binding = plan.bindings[0];
  if (binding === undefined) throw new TypeError("missing admitted binding");
  const observationId = await providerEvidenceDigest({
    format: "ovdb-read-observation-id/1", execution: plan.execution, binding, read: observation,
  });
  return validateProviderReads({
    sourceRights: plan.sourceRights, usedSourceIds: plan.usedSourceIds,
    providerReads: {
      format: "ovdb-provider-read/1", execution: plan.execution, bindings: plan.bindings,
      reads: [{ ...observation, observationId }],
      usage: [{ providerSourceId: binding.providerSourceId, rightsSourceId: binding.rightsSourceId, observationIds: [observationId] }],
    },
  }, plan);
}

/** Query-only executor: no persisted snapshots, cache, fallback, reads by ID or writes. */
export class ECBQueryExecutor implements QueryExecutor {
  readonly #options: ECBQueryOptions;
  public constructor(options: ECBQueryOptions) {
    if (options.collectionName.trim() === "" || options.collectionName.includes("/")) throw new TypeError("invalid collection name");
    if (options.executorId.trim() === "") throw new TypeError("executor ID is required");
    this.#options = { ...options, providerReadPlan: structuredClone(options.providerReadPlan) };
  }

  public async query<T>(query: StructuredQuery<T>, options?: { readonly signal?: AbortSignal }): Promise<QueryPage<T>> {
    const source = query.source;
    const sourceName = source.name;
    if (source.kind !== "collection" || source.name !== this.#options.collectionName || source.parent !== undefined) {
      throw new UnsupportedError("ECB collection source");
    }
    if (query.orders.length !== 0 || (query.offset ?? 0) !== 0 || query.startAt !== undefined
      || query.startAfter !== undefined || query.endAt !== undefined || query.endBefore !== undefined) {
      throw new UnsupportedError("ECB ordering, offsets and cursors");
    }
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0 || query.limit > 256)) throw new RangeError("invalid ECB query limit");
    const limit = query.limit ?? 256;
    const filters = query.filters.map((filter) => {
      if (!["time", "currency", "rate"].includes(filter.field) || filter.operator !== "==" || typeof filter.value !== "string") {
        throw new UnsupportedError("ECB filters require native string equality");
      }
      return { field: filter.field, value: filter.value };
    });
    const codec = source.codec;
    const parser = this.#options.parser ?? new DOMParser();
    const plan = structuredClone(this.#options.providerReadPlan);
    const request = plan.requests[0];
    const binding = plan.bindings[0];
    const right = plan.sourceRights[0];
    if (plan.execution.mode !== "direct" || plan.execution.executorId !== this.#options.executorId
      || plan.requests.length !== 1 || plan.bindings.length !== 1 || plan.sourceRights.length !== 1
      || request?.upstreamUrl !== ECB_DAILY_URL || (request.method as unknown) !== "GET" || Object.keys(request.params).length !== 0
      || binding?.resourceId !== request.resourceId || right?.source.recordset !== sourceName
      || binding.rightsSourceId !== right.sourceId || plan.usedSourceIds.length !== 1 || plan.usedSourceIds[0] !== right.sourceId) {
      throw new TypeError("ECB query requires an exact independently admitted direct plan");
    }
    options?.signal?.throwIfAborted();
    const requestDigest = await providerEvidenceDigest({ format: "ovdb-resource-request/1", ...request });
    const base = {
      resourceId: request.resourceId, requestDigest, upstreamUrl: ECB_DAILY_URL,
      attestation: "direct-executor-observed" as const,
    };
    // Exercise the core's closed plan/rights/digest/budget checks before HTTP.
    // This validation probe is discarded; only the actual observed read is returned.
    await evidence(plan, { ...base, fetchedAt: new Date().toISOString(), status: 200,
      contentType: "application/xml", sha256: "0".repeat(64), bytes: 0 });
    const read = await readECBXML(this.#options, options?.signal);
    options?.signal?.throwIfAborted();
    const rows = decodeECBDaily(read.bytes, parser);
    const hash = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(read.bytes));
    const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const metadata = await evidence(plan, {
      ...base, fetchedAt: read.fetchedAt, status: read.response.status,
      contentType: read.response.headers.get("Content-Type") ?? "", sha256, bytes: read.bytes.byteLength,
      referenceDate: rows[0]?.time ?? "",
      ...(read.response.headers.get("Last-Modified") === null ? {} : { lastModified: read.response.headers.get("Last-Modified") ?? "" }),
      ...(read.response.headers.get("ETag") === null ? {} : { etag: read.response.headers.get("ETag") ?? "" }),
    });
    options?.signal?.throwIfAborted();
    return {
      ...metadata,
      records: rows.filter((row) => filters.every((filter) => row[filter.field as keyof typeof row] === filter.value)).slice(0, limit)
        .map((row) => ({ key: new Key(sourceName, row.currency), exists: true as const,
          data: codec === undefined ? row as T : codec.decode(row) })),
    };
  }
}
