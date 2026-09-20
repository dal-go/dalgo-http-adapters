import {
  DOCUMENT_ID,
  UnsupportedError,
  type QueryPage,
  type StructuredQuery,
} from "@dal-go/dalgo";
import { OpenVaultDbClient, translateOpenVaultDbError } from "./client.js";
import { keyFromOpenVaultDbPath } from "./path.js";

interface WireFilter {
  readonly field: string;
  readonly op: string;
  readonly value: unknown;
}

interface WireOrder {
  readonly field: string;
  readonly desc: boolean;
}

interface WireQuery {
  readonly collection: string;
  readonly parent?: string;
  readonly where?: readonly WireFilter[];
  readonly orderBy?: readonly WireOrder[];
  readonly limit?: number;
}

interface WireQueryResponse {
  readonly records: readonly {
    readonly key: string;
    readonly data: unknown;
  }[];
}

export function toOpenVaultDbQuery<T>(query: StructuredQuery<T>): WireQuery {
  if (query.source.kind === "collection-group") throw new UnsupportedError("OpenVaultDB collection-group queries");
  if ((query.offset ?? 0) !== 0) throw new UnsupportedError("OpenVaultDB query offsets");
  if (query.startAt !== undefined || query.startAfter !== undefined
    || query.endAt !== undefined || query.endBefore !== undefined) {
    throw new UnsupportedError("OpenVaultDB query cursors");
  }
  const where = query.filters.map((filter): WireFilter => {
    if (filter.field === DOCUMENT_ID) throw new UnsupportedError("OpenVaultDB document-id filters");
    if (filter.operator === "!=" || filter.operator === "not-in") {
      throw new UnsupportedError(`OpenVaultDB ${filter.operator} filters`);
    }
    return { field: filter.field, op: filter.operator, value: filter.value };
  });
  const orderBy = query.orders.map((order): WireOrder => {
    if (order.field === DOCUMENT_ID) throw new UnsupportedError("OpenVaultDB document-id ordering");
    return { field: order.field, desc: order.direction === "desc" };
  });
  return {
    collection: query.source.name,
    ...(query.source.parent === undefined ? {} : { parent: query.source.parent.path }),
    ...(where.length === 0 ? {} : { where }),
    ...(orderBy.length === 0 ? {} : { orderBy }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

export async function executeOpenVaultDbQuery<T>(
  client: OpenVaultDbClient,
  query: StructuredQuery<T>,
): Promise<QueryPage<T>> {
  try {
    const response = await client.request(client.queryPath(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toOpenVaultDbQuery(query)),
    });
    const body = await response.json() as WireQueryResponse;
    const codec = query.source.codec;
    return {
      records: body.records.map((record) => ({
        key: keyFromOpenVaultDbPath(record.key),
        exists: true as const,
        data: codec === undefined ? record.data as T : codec.decode(record.data),
        metadata: { source: "openvaultdb" },
      })),
    };
  } catch (error) {
    throw translateOpenVaultDbError(error);
  }
}
