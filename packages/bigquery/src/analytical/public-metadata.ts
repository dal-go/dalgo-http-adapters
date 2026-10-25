import { canonicalJSON } from "./canonical.js";
import { object } from "./metadata.js";
import { cloneFrozen } from "./protocol.js";
import { fail, type JsonValue } from "./wire.js";
import type { MetadataDiscovery } from "./metadata-client.js";

export interface PublicMetadataField {
  readonly name: string;
  readonly type: string;
  readonly mode: string;
  readonly fields?: readonly PublicMetadataField[];
}
export interface PublicMetadataObservation {
  readonly format: "ovdb-bigquery-observation/draft-1";
  readonly source_id: string;
  readonly source_project: string;
  readonly dataset_id: string;
  readonly table_id: string;
  readonly location: string;
  readonly object_type: string;
  readonly observed_at: string;
  readonly projection: "partial-public-schema";
  readonly provenance: { readonly kind: "synthetic-fixture"; readonly method: "datasets.get+tables.get"; readonly verifier: "public-projection-review-v1" };
  readonly schema: readonly PublicMetadataField[];
  readonly sha256: string;
}
const types = new Set(["STRING", "BYTES", "INTEGER", "INT64", "FLOAT", "FLOAT64", "BOOLEAN", "BOOL", "TIMESTAMP", "DATE", "TIME", "DATETIME", "GEOGRAPHY", "NUMERIC", "BIGNUMERIC", "JSON", "RECORD", "STRUCT", "RANGE"]);
function matches(value: unknown, pattern: RegExp, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) fail("malformed_wire");
}
/** Fixture-only public projection. Publication rights and provider authenticity
 * require a separate operator review; this never labels fixtures as observed. */
export async function projectFixtureMetadata(discovery: MetadataDiscovery): Promise<PublicMetadataObservation> {
  const s = discovery.source;
  matches(s.sourceId, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 80);
  matches(s.sourceProject, /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u, 63);
  for (const id of [s.datasetId, s.tableId]) matches(id, /^[A-Za-z_][A-Za-z0-9_]*$/u, 1024);
  const location = discovery.dataset.location;
  matches(location, /^(?:US|EU|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)$/u, 64);
  const type = discovery.table.type;
  if (typeof type !== "string" || !["TABLE", "VIEW", "EXTERNAL", "MATERIALIZED_VIEW", "SNAPSHOT"].includes(type)) fail("malformed_wire");
  let count = 0;
  const fields = (raw: JsonValue | undefined, depth: number): PublicMetadataField[] => {
    if (!Array.isArray(raw) || raw.length === 0 || depth > 8) fail("response_limit");
    const names = new Set<string>();
    return raw.map(value => {
      if (++count > 500) fail("response_limit");
      const f = object(value);
      matches(f.name, /^[A-Za-z_][A-Za-z0-9_]*$/u, 300);
      if (names.has(f.name.toLowerCase())) fail("malformed_wire");
      names.add(f.name.toLowerCase());
      if (typeof f.type !== "string" || !types.has(f.type)) fail("malformed_wire");
      const mode = f.mode ?? "NULLABLE";
      if (typeof mode !== "string" || !["NULLABLE", "REQUIRED", "REPEATED"].includes(mode)) fail("malformed_wire");
      const nested = f.type === "RECORD" || f.type === "STRUCT";
      if (!nested && Object.hasOwn(f, "fields")) fail("malformed_wire");
      // Copy only individually admitted properties, at every depth. Descriptions,
      // policy tags, descriptors, expressions and provider config are excluded.
      return { name: f.name, type: f.type, mode, ...(nested ? { fields: fields(f.fields, depth + 1) } : {}) };
    });
  };
  const at = new Date(discovery.observedAt);
  if (!Number.isFinite(at.getTime())) fail("malformed_wire");
  const observedAt = at.toISOString().replace(/\.\d{3}Z$/u, "Z");
  matches(observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u, 20);
  const value = {
    format: "ovdb-bigquery-observation/draft-1" as const,
    source_id: s.sourceId, source_project: s.sourceProject, dataset_id: s.datasetId, table_id: s.tableId,
    location, object_type: type, observed_at: observedAt,
    projection: "partial-public-schema" as const,
    provenance: { kind: "synthetic-fixture" as const, method: "datasets.get+tables.get" as const, verifier: "public-projection-review-v1" as const },
    schema: fields(object(discovery.table.schema).fields, 1),
  };
  const input = new TextEncoder().encode(JSON.stringify(value));
  if (input.length > 65536) fail("response_limit");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(canonicalJSON(input))));
  const result = { ...value, sha256: `sha256:${Array.from(digest, v => v.toString(16).padStart(2, "0")).join("")}` };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 65536) fail("response_limit");
  return cloneFrozen(result);
}
