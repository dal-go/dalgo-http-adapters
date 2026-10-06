import { canonicalJSON } from "./canonical.js";
import { fail, isObject, type JsonValue } from "./wire.js";
import { cloneFrozen, digest, exactKeys, integerText, normalizeParameter, supportedField, timestamp, validateSchema, type Observation, type SchemaField, type SourceProfile } from "./protocol.js";
// Explicit classifications pinned to Google REST discovery / generated SDK v0.296.0.
const tableMetadata = "creationTime description etag expirationTime friendlyName id kind labels lastModifiedTime numActiveLogicalBytes numActivePhysicalBytes numBytes numCurrentPhysicalBytes numLongTermBytes numLongTermLogicalBytes numLongTermPhysicalBytes numPartitions numPhysicalBytes numRows numTimeTravelPhysicalBytes numTotalLogicalBytes numTotalPhysicalBytes resourceTags selfLink streamingBuffer".split(" ");
const tableRejected = "biglakeConfiguration cloneDefinition defaultCollation defaultRoundingMode encryptionConfiguration externalCatalogTableOptions externalDataConfiguration managedTableType materializedView materializedViewStatus maxStaleness model partitionDefinition replicas restrictions snapshotDefinition tableConstraints tableReplicationInfo view".split(" ");
const datasetMetadata = "access creationTime defaultPartitionExpirationMs defaultTableExpirationMs description etag friendlyName id kind labels lastModifiedTime maxTimeTravelHours resourceTags satisfiesPzi satisfiesPzs selfLink storageBillingModel tags".split(" ");
const datasetRejected = "catalogSource defaultCollation defaultEncryptionConfiguration defaultRoundingMode externalCatalogDatasetOptions externalDatasetReference isCaseInsensitive linkedDatasetMetadata linkedDatasetSource restrictions type".split(" ");
const fieldRejected = "collation dataGovernanceTagsInfo dataPolicies dataPolicyList defaultValueExpression foreignTypeDefinition generatedColumn maxLength policyTags rangeElementType roundingMode timestampPrecision".split(" ");
export function object(value: JsonValue | undefined): Record<string, JsonValue> { if (value === undefined || !isObject(value))
  fail("malformed_wire"); return value; }
function rejected(value: Record<string, JsonValue>, keys: readonly string[]): void { for (const key of keys)
  if (Object.hasOwn(value, key) && value[key] !== null)
    fail("source_ineligible"); }
export function decodeSchema(raw: JsonValue): readonly SchemaField[] {
  const schema = object(raw);
  exactKeys(schema, ["fields"], [], "source_ineligible");
  let count = 0;
  const decode = (value: JsonValue | undefined, depth: number): SchemaField[] => {
    if (!Array.isArray(value) || value.length === 0 || depth > 8)
      fail("malformed_wire");
    return value.map(raw => {
      if (++count > 1024)
        fail("response_limit");
      const field = object(raw);
      exactKeys(field, ["name", "type"], ["mode", "fields", "precision", "scale", "description", "categories", ...fieldRejected], "source_ineligible");
      rejected(field, fieldRejected);
      if (typeof field.name !== "string" || typeof field.type !== "string" || field.name === "" || field.type === "")
        fail("malformed_wire");
      const mode = Object.hasOwn(field, "mode") ? field.mode : "NULLABLE";
      if (typeof mode !== "string")
        fail("malformed_wire");
      const result: SchemaField = {
        name: field.name, type: field.type, mode,
        ...(Object.hasOwn(field, "fields") ? {
          fields: decode(field.fields, depth + 1)
        } : {}),
        ...(Object.hasOwn(field, "precision") ? {
          precision: integerText(field.precision)
        } : {}),
        ...(Object.hasOwn(field, "scale") ? {
          scale: integerText(field.scale)
        } : {}),
      };
      return result;
    });
  };
  const result = decode(schema.fields, 0);
  validateSchema(result);
  return cloneFrozen(result);
}
export function validateDataset(raw: JsonValue, source: SourceProfile): void {
  const value = object(raw);
  exactKeys(value, ["datasetReference", "location"], [...datasetMetadata, ...datasetRejected], "source_ineligible");
  rejected(value, datasetRejected);
  const ref = object(value.datasetReference);
  exactKeys(ref, ["projectId", "datasetId"], [], "source_ineligible");
  if (ref.projectId !== source.sourceProject || ref.datasetId !== source.datasetId || value.location !== source.location)
    fail("source_changed");
}
export function same(a: unknown, b: unknown): boolean {
  const encoder = new TextEncoder();
  const aa = canonicalJSON(encoder.encode(JSON.stringify(a)));
  const bb = canonicalJSON(encoder.encode(JSON.stringify(b)));
  return aa.length === bb.length && aa.every((value, index) => value === bb[index]);
}
export async function validateTable(raw: JsonValue, source: SourceProfile, now: number): Promise<Observation> {
  const value = object(raw);
  exactKeys(value, ["tableReference", "type", "schema"], ["location", "timePartitioning", "rangePartitioning", "clustering", "requirePartitionFilter", ...tableMetadata, ...tableRejected], "source_ineligible");
  rejected(value, tableRejected);
  const table = object(value.tableReference);
  exactKeys(table, ["projectId", "datasetId", "tableId"], [], "source_ineligible");
  if (table.projectId !== source.sourceProject || table.datasetId !== source.datasetId || table.tableId !== source.tableId || (Object.hasOwn(value, "location") && value.location !== source.location))
    fail("source_changed");
  if (value.type !== "TABLE")
    fail("source_ineligible");
  const schema = decodeSchema(value.schema as JsonValue);
  if (!same(schema, source.schema))
    fail("source_changed");
  const fields = new Map(schema.map(field => [field.name, field]));
  const config: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of ["timePartitioning", "rangePartitioning", "clustering", "requirePartitionFilter"]) {
    if (!Object.hasOwn(value, key))
      continue;
    const item = value[key] as JsonValue;
    if (item === null)
      fail("source_ineligible");
    if (key === "requirePartitionFilter") {
      if (typeof item !== "boolean")
        fail("source_ineligible");
    }
    else {
      const settings = object(item);
      if (key === "clustering") {
        exactKeys(settings, ["fields"], [], "source_ineligible");
        if (!Array.isArray(settings.fields) || settings.fields.length < 1 || settings.fields.length > 4 || new Set(settings.fields).size !== settings.fields.length)
          fail("source_ineligible");
        for (const name of settings.fields) {
          const field = typeof name === "string" ? fields.get(name) : undefined;
          if (field === undefined || field.mode === "REPEATED" || field.fields !== undefined || ["BOOL", "BOOLEAN", "BYTES", "JSON", "RECORD", "STRUCT", "GEOGRAPHY", "RANGE", "INTERVAL"].includes(field.type))
            fail("source_ineligible");
          supportedField(field);
        }
      }
      else if (key === "timePartitioning") {
        if (Object.hasOwn(value, "rangePartitioning"))
          fail("source_ineligible");
        exactKeys(settings, ["type"], ["field", "expirationMs", "requirePartitionFilter"], "source_ineligible");
        if (!["DAY", "HOUR", "MONTH", "YEAR"].includes(String(settings.type)))
          fail("source_ineligible");
        if (Object.hasOwn(settings, "field")) {
          const field = typeof settings.field === "string" ? fields.get(settings.field) : undefined;
          if (field === undefined || !["DATE", "TIMESTAMP", "DATETIME"].includes(field.type))
            fail("source_ineligible");
        }
        if (Object.hasOwn(settings, "expirationMs"))
          integerText(settings.expirationMs);
        if (Object.hasOwn(settings, "requirePartitionFilter") && typeof settings.requirePartitionFilter !== "boolean")
          fail("source_ineligible");
        if (Object.hasOwn(settings, "requirePartitionFilter") && Object.hasOwn(value, "requirePartitionFilter") && settings.requirePartitionFilter !== value.requirePartitionFilter)
          fail("source_ineligible");
      }
      else {
        exactKeys(settings, ["field", "range"], [], "source_ineligible");
        const field = typeof settings.field === "string" ? fields.get(settings.field) : undefined;
        if (field === undefined || !["INTEGER", "INT64"].includes(field.type))
          fail("source_ineligible");
        const range = object(settings.range);
        exactKeys(range, ["start", "end", "interval"], [], "source_ineligible");
        const values = ["start", "end", "interval"].map(key => { const cell = normalizeParameter({
          name: "", type: "INT64"
        }, range[key]); return BigInt(cell as string); });
        if ((values[0] as bigint) >= (values[1] as bigint) || (values[2] as bigint) < 1n)
          fail("source_ineligible");
      }
    }
    config[key] = item;
  }
  const payload = {
    table: {
      projectId: source.sourceProject, datasetId: source.datasetId, tableId: source.tableId
    }, location: source.location, type: "TABLE" as const, config, schema
  };
  return cloneFrozen({
    ...payload, digest: await digest("Observation", payload), observedAt: timestamp(now)
  });
}
