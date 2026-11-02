import type { QueryCommandInput } from "@aws-sdk/client-dynamodb";
import type { DynamoDbReadOperation } from "./read-operation.js";
import { cloneKey, compare, identity, invalid, keyValue, objectEntries, objectMap, ordinaryArray, requestError, text } from "./native-values.js";
import { type NativeDynamoDbIndex, type NativeDynamoDbKey, type NativeDynamoDbKeyAttribute, type NativeDynamoDbKeyValue, type NativeDynamoDbQuery, type NativeDynamoDbReadOptions, type NativeDynamoDbSortCondition, type NativeDynamoDbTable } from "./native-types.js";

export interface ResolvedIndex {
  readonly indexName: string;
  readonly kind: "gsi" | "lsi";
  readonly partitionKey: NativeDynamoDbKeyAttribute;
  readonly sortKey?: NativeDynamoDbKeyAttribute;
  readonly projected?: readonly string[];
}
export interface ResolvedTable {
  readonly tableName: string;
  readonly partitionKey: NativeDynamoDbKeyAttribute;
  readonly sortKey?: NativeDynamoDbKeyAttribute;
  readonly consistentRead: boolean;
  readonly attributes?: readonly string[];
  readonly indexes: ReadonlyMap<string, ResolvedIndex>;
}
export function keyAttributes(schema: { readonly partitionKey: NativeDynamoDbKeyAttribute; readonly sortKey?: NativeDynamoDbKeyAttribute }): NativeDynamoDbKeyAttribute[] {
  return [schema.partitionKey, ...(schema.sortKey === undefined ? [] : [schema.sortKey])];
}
function physicalName(value: unknown): string {
  const name = text(value, 255, true);
  if (!/^[A-Za-z0-9_.-]{3,255}$/u.test(name)) return invalid();
  return name;
}
function attribute(value: unknown): NativeDynamoDbKeyAttribute {
  const raw = objectMap(value, 2);
  if (Object.keys(raw).length !== 2 || !(raw.type === "S" || raw.type === "N" || raw.type === "B")) return invalid();
  return Object.freeze({ name: text(raw.name, 255, true), type: raw.type });
}
function names(value: unknown): readonly string[] {
  const result = ordinaryArray(value, 128).map((name) => text(name, 255, true));
  if (new Set(result).size !== result.length) return invalid();
  return Object.freeze(result);
}
function closed(raw: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(raw).some((name) => !allowed.includes(name))) return invalid();
}
export function resolveTables(value: unknown): ReadonlyMap<string, ResolvedTable> {
  const tables = new Map<string, ResolvedTable>();
  for (const [logical, value_] of objectEntries(value, 128)) {
    text(logical, 255, true);
    const raw = objectMap(value_, 6);
    closed(raw, ["tableName", "partitionKey", "sortKey", "consistentRead", "readAttributes", "indexes"]);
    const partitionKey = attribute(raw.partitionKey);
    const sortKey = raw.sortKey === undefined ? undefined : attribute(raw.sortKey);
    if (sortKey?.name === partitionKey.name || (raw.consistentRead !== undefined && typeof raw.consistentRead !== "boolean")) return invalid();
    const indexes = new Map<string, ResolvedIndex>();
    for (const [alias, index_] of objectEntries(raw.indexes ?? {}, 32)) {
      text(alias, 255, true);
      const index = objectMap(index_, 5);
      closed(index, ["indexName", "kind", "partitionKey", "sortKey", "projection"]);
      if (index.kind !== "gsi" && index.kind !== "lsi") return invalid();
      const pk = attribute(index.partitionKey); const sk = index.sortKey === undefined ? undefined : attribute(index.sortKey);
      if (pk.name === sk?.name) return invalid();
      if (index.kind === "lsi" && (sortKey === undefined || sk === undefined || pk.name !== partitionKey.name || pk.type !== partitionKey.type)) return invalid();
      const projected = index.projection === "ALL" ? undefined : index.projection === "KEYS_ONLY" ? [] : names(index.projection);
      // One physical attribute cannot have contradictory native key types.
      const types = new Map<string, string>();
      for (const key of [...keyAttributes({ partitionKey, ...(sortKey === undefined ? {} : { sortKey }) }), ...keyAttributes({ partitionKey: pk, ...(sk === undefined ? {} : { sortKey: sk }) })]) {
        if (types.has(key.name) && types.get(key.name) !== key.type) return invalid();
        types.set(key.name, key.type);
      }
      indexes.set(alias, Object.freeze({ indexName: physicalName(index.indexName), kind: index.kind, partitionKey: pk,
        ...(sk === undefined ? {} : { sortKey: sk }), ...(projected === undefined ? {} : { projected: Object.freeze(projected) }) }));
    }
    const allTypes = new Map<string, string>();
    for (const schema of [{ partitionKey, ...(sortKey === undefined ? {} : { sortKey }) }, ...indexes.values()]) {
      for (const key of keyAttributes(schema)) {
        if (allTypes.has(key.name) && allTypes.get(key.name) !== key.type) return invalid();
        allTypes.set(key.name, key.type);
      }
    }
    const attributes = raw.readAttributes === undefined || raw.readAttributes === "all" ? undefined : names(raw.readAttributes);
    tables.set(logical, Object.freeze({ tableName: physicalName(raw.tableName), partitionKey,
      ...(sortKey === undefined ? {} : { sortKey }), consistentRead: raw.consistentRead ?? false,
      ...(attributes === undefined ? {} : { attributes }), indexes }));
  }
  if (tables.size === 0) return invalid();
  return tables;
}

export interface ReadPlan {
  readonly table: ResolvedTable;
  readonly target: ResolvedTable | ResolvedIndex;
  readonly keyAttributes: readonly NativeDynamoDbKeyAttribute[];
  readonly partitionNames: ReadonlySet<string>;
  readonly selected?: readonly string[];
  readonly names: Record<string, string>;
  readonly expression?: string;
  readonly consistent: boolean;
}
export function readPlan(table: ResolvedTable, options: NativeDynamoDbReadOptions = {}, index?: ResolvedIndex): ReadPlan {
  const raw = objectMap(options, 2); closed(raw, ["projection", "consistentRead"]);
  if (raw.consistentRead !== undefined && typeof raw.consistentRead !== "boolean") return requestError();
  const consistent = raw.consistentRead ?? table.consistentRead;
  if (index?.kind === "gsi" && consistent) return requestError();
  const target = index ?? table;
  const keyMap = new Map<string, NativeDynamoDbKeyAttribute>(); const sortNames = new Set<string>();
  for (const schema of [table, target]) {
    for (const attribute of keyAttributes(schema)) keyMap.set(attribute.name, attribute);
    if (schema.sortKey !== undefined) sortNames.add(schema.sortKey.name);
  }
  const keys = [...keyMap.values()];
  const partitionNames = new Set(keys.map((v) => v.name).filter((name) => !sortNames.has(name)));
  const projected = index?.projected === undefined ? undefined : [...new Set([...index.projected, ...keys.map((v) => v.name)])];
  const requested = raw.projection === undefined ? undefined : names(raw.projection);
  if (requested?.some((name) => (table.attributes !== undefined && !table.attributes.includes(name) && !keyMap.has(name)) || (projected !== undefined && !projected.includes(name))) === true) return requestError();
  let selected = requested ?? table.attributes ?? projected;
  if (selected !== undefined) {
    selected = [...new Set([...selected, ...keys.map((v) => v.name)])];
    // Refuse implicit LSI table fetches and impossible GSI projections alike.
    if (projected !== undefined && selected.some((name) => !projected.includes(name))) return requestError();
  }
  const aliases = Object.fromEntries((selected ?? []).map((name, index_) => [`#a${String(index_)}`, name]));
  const expression = selected === undefined ? undefined : Object.keys(aliases).join(", ");
  return { table, target, keyAttributes: keys, partitionNames, ...(selected === undefined ? {} : { selected }), names: aliases,
    ...(expression === undefined ? {} : { expression }), consistent };
}
export function itemKey(op: DynamoDbReadOperation, raw: Readonly<Record<string, unknown>>, plan: ReadPlan): NativeDynamoDbKey {
  const key = Object.fromEntries(plan.keyAttributes.map((attribute) => [attribute.name, raw[attribute.name]]));
  return cloneKey(op, key, plan.keyAttributes, plan.partitionNames);
}
export function checkProjection(item: Readonly<Record<string, unknown>>, plan: ReadPlan): void {
  if (plan.selected !== undefined && Object.keys(item).some((name) => !plan.selected?.includes(name))) return invalid();
}

/** Structural SDK input keeps every emitted adapter declaration self-contained.
 * The implementation still checks this object against the actual vendor type. */
interface NativeQueryInput {
  readonly TableName: string;
  readonly IndexName?: string;
  readonly KeyConditionExpression: string;
  readonly ExpressionAttributeNames: Record<string, string>;
  readonly ExpressionAttributeValues: Record<string, NativeDynamoDbKeyValue>;
  readonly ConsistentRead: boolean;
  readonly ScanIndexForward: boolean;
  readonly ProjectionExpression?: string;
}
export interface QueryPlan extends ReadPlan {
  readonly input: NativeQueryInput;
  readonly scope: string;
  readonly partition: NativeDynamoDbKeyValue;
  readonly sort?: NativeDynamoDbSortCondition;
  readonly descending: boolean;
  readonly limit: number;
}
export function compileQuery(op: DynamoDbReadOperation, tables: ReadonlyMap<string, ResolvedTable>, request: NativeDynamoDbQuery, maximum: number): QueryPlan {
  op.account(request);
  const raw = objectMap(request, 9);
  closed(raw, ["collection", "index", "partition", "sort", "descending", "limit", "cursor", "projection", "consistentRead"]);
  const table = tables.get(text(raw.collection, 255, true)); if (table === undefined) return requestError();
  const index = raw.index === undefined ? undefined : table.indexes.get(text(raw.index, 255, true));
  if (raw.index !== undefined && index === undefined) return requestError();
  if (!Number.isSafeInteger(raw.limit) || typeof raw.limit !== "number" || raw.limit < 1 || raw.limit > maximum || (raw.descending !== undefined && typeof raw.descending !== "boolean")) return requestError();
  if (raw.consistentRead !== undefined && typeof raw.consistentRead !== "boolean") return requestError();
  const plan = readPlan(table, { ...(raw.projection === undefined ? {} : { projection: names(raw.projection) }), ...(raw.consistentRead === undefined ? {} : { consistentRead: raw.consistentRead }) }, index);
  const partition = keyValue(op, raw.partition, plan.target.partitionKey, true);
  const aliases: Record<string, string> = { ...plan.names, "#p": plan.target.partitionKey.name };
  const values: Record<string, NativeDynamoDbKeyValue> = { ":p": partition };
  let condition = "#p = :p"; let sort: NativeDynamoDbSortCondition | undefined;
  if (raw.sort !== undefined) {
    const attr = plan.target.sortKey; if (attr === undefined) return requestError();
    const input = objectMap(raw.sort, 2); closed(input, ["operator", "values"]);
    const operator = input.operator;
    if (!(operator === "=" || operator === "<" || operator === "<=" || operator === ">" || operator === ">=" || operator === "between" || operator === "begins_with")) return requestError();
    const supplied = ordinaryArray(input.values, 2);
    if (supplied.length !== (operator === "between" ? 2 : 1)) return requestError();
    const sorted = supplied.map((v) => keyValue(op, v, attr, false)); const first = sorted[0] ?? invalid();
    if ((operator === "begins_with" && "N" in first) || (operator === "between" && compare(first, sorted[1] ?? invalid()) > 0)) return requestError();
    aliases["#s"] = attr.name; values[":s0"] = first;
    if (operator === "between") { values[":s1"] = sorted[1] ?? invalid(); condition += " AND #s BETWEEN :s0 AND :s1"; }
    else if (operator === "begins_with") condition += " AND begins_with(#s, :s0)";
    else condition += ` AND #s ${operator} :s0`;
    sort = { operator, values: sorted };
  }
  const descending = raw.descending === true;
  const scope = JSON.stringify([raw.collection, raw.index ?? null, identity(partition), sort?.operator ?? null, sort?.values.map(identity) ?? null, descending, plan.consistent, plan.selected ?? null, raw.limit]);
  return { ...plan, input: { TableName: table.tableName, ...(index === undefined ? {} : { IndexName: index.indexName }), KeyConditionExpression: condition,
    ExpressionAttributeNames: aliases, ExpressionAttributeValues: values, ConsistentRead: plan.consistent, ScanIndexForward: !descending,
    ...(plan.expression === undefined ? {} : { ProjectionExpression: plan.expression }) } satisfies QueryCommandInput, scope, partition,
    ...(sort === undefined ? {} : { sort }), descending, limit: raw.limit };
}
export function matchesSort(value: NativeDynamoDbKeyValue, condition: NativeDynamoDbSortCondition): boolean {
  const first = condition.values[0] ?? invalid(); const order = compare(value, first);
  switch (condition.operator) {
    case "=": return order === 0; case "<": return order < 0; case "<=": return order <= 0; case ">": return order > 0; case ">=": return order >= 0;
    case "between": return order >= 0 && compare(value, condition.values[1] ?? invalid()) <= 0;
    case "begins_with": {
      if ("S" in value && "S" in first) return value.S.startsWith(first.S);
      if ("B" in value && "B" in first) return first.B.every((byte, index) => value.B[index] === byte);
      return false;
    }
  }
}
/** Return only configured metadata, never infer DescribeTable or IAM access. */
export function configuredTables(tables: ReadonlyMap<string, ResolvedTable>): Readonly<Record<string, NativeDynamoDbTable>> {
  const result: Record<string, NativeDynamoDbTable> = Object.create(null) as Record<string, NativeDynamoDbTable>;
  for (const [logical, table] of tables) {
    const indexes: Record<string, NativeDynamoDbIndex> = Object.create(null) as Record<string, NativeDynamoDbIndex>;
    for (const [alias, index] of table.indexes) indexes[alias] = Object.freeze({
      indexName: index.indexName, kind: index.kind, partitionKey: index.partitionKey,
      ...(index.sortKey === undefined ? {} : { sortKey: index.sortKey }), projection: index.projected ?? "ALL",
    });
    result[logical] = Object.freeze({ tableName: table.tableName, partitionKey: table.partitionKey,
      ...(table.sortKey === undefined ? {} : { sortKey: table.sortKey }), consistentRead: table.consistentRead,
      readAttributes: table.attributes ?? "all", indexes: Object.freeze(indexes) });
  }
  return Object.freeze(result);
}
