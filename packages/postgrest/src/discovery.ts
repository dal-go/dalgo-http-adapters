/** A bounded, read-only view of one exposed PostgREST relation. */
export interface PostgrestFieldDiscovery {
  readonly name: string;
  /** Declared JSON-Schema type, when the OpenAPI document declares one. */
  readonly type?: string;
  /** Declared provider type, normally PostgreSQL's type name. */
  readonly format?: string;
  readonly array: boolean;
  readonly itemsType?: string;
  /** `undefined` when the document does not declare `required`. */
  readonly nullable?: boolean;
  readonly declaredPrimaryKey: boolean;
  readonly typeStatus: "declared" | "unavailable";
  readonly enumValues?: readonly (string | number | boolean | null)[];
}

export interface PostgrestPrimaryKeyDiscovery {
  readonly status: "declared" | "not-declared" | "unavailable";
  readonly columns: readonly string[];
}

export interface PostgrestIdColumnDiscovery {
  readonly name: string;
  readonly present: boolean;
  readonly declaredPrimaryKey: boolean;
}

export interface PostgrestRelationDiscovery {
  readonly name: string;
  /** HTTP verbs PostgREST advertises for this relation path. */
  readonly methods: readonly string[];
  readonly readable: boolean;
  readonly fields: readonly PostgrestFieldDiscovery[];
  readonly fieldsStatus: "declared" | "unavailable" | "truncated";
  readonly omittedFields: number;
  readonly primaryKey: PostgrestPrimaryKeyDiscovery;
  readonly idColumn: PostgrestIdColumnDiscovery;
  /** True only when this adapter can address the relation with its configured ID column. */
  readonly adapterQueryable: boolean;
  readonly adapterQueryableReason?: string;
}

export type PostgrestDiscoveryReason =
  | "unauthorized"
  | "forbidden"
  | "metadata-disabled"
  | "request-failed"
  | "malformed-metadata"
  | "no-relations";

export interface PostgrestDiscoveryBounds {
  readonly maxRelations: number;
  readonly maxFieldsPerRelation: number;
  readonly maxMetadataBytes: number;
  readonly maxSchemaDepth: number;
}

/**
 * Discovery result. `status: "unavailable"` is deliberately not an empty
 * database: a denied, disabled, malformed or unreadable metadata endpoint and a
 * role that sees zero relations are all reported explicitly.
 */
export interface PostgrestDiscovery {
  readonly adapter: "@dal-go/dalgo2postgrest";
  readonly protocol: "postgrest-openapi";
  readonly endpoint: string;
  readonly schema?: string;
  readonly status: "available" | "unavailable";
  readonly reason?: PostgrestDiscoveryReason;
  readonly detail: string;
  readonly httpStatus?: number;
  readonly relations: readonly PostgrestRelationDiscovery[];
  readonly relationCount: number;
  readonly truncated: boolean;
  readonly omittedRelations: number;
  readonly bounds: PostgrestDiscoveryBounds;
}

export interface PostgrestConnectionStatus {
  readonly ok: boolean;
  readonly status:
    | "connected"
    | "unauthorized"
    | "forbidden"
    | "metadata-disabled"
    | "metadata-malformed"
    | "unreachable";
  readonly httpStatus?: number;
  readonly relationCount?: number;
  readonly schema?: string;
  readonly detail: string;
}

export interface PostgrestOpenApiParseOptions {
  readonly idColumn: string;
  readonly maxRelations: number;
  readonly maxFieldsPerRelation: number;
  readonly maxSchemaDepth: number;
}

export type PostgrestOpenApiParseResult =
  | {
    readonly status: "available";
    readonly relations: readonly PostgrestRelationDiscovery[];
    readonly relationCount: number;
    readonly truncated: boolean;
    readonly omittedRelations: number;
  }
  | {
    readonly status: "unavailable";
    readonly reason: "malformed-metadata" | "no-relations";
    readonly detail: string;
  };

const RELATION_PATH = /^\/([^/]+)$/u;
const ADAPTER_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PRIMARY_KEY_MARKER = /This is a Primary Key\.<pk\/>/u;
const METHOD_ORDER = ["get", "head", "post", "put", "patch", "delete", "options"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasOwn(value: object, name: string): boolean {
  return Object.hasOwn(value, name);
}

function schemaAt(document: unknown, ref: string): Record<string, unknown> | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref.slice(2).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  let node: unknown = document;
  for (const segment of segments) {
    if (!isPlainObject(node) || !hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return isPlainObject(node) ? node : undefined;
}

function resolvedSchema(
  document: unknown,
  value: unknown,
  depth: number,
  maxDepth: number,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const ref = value.$ref;
  if (ref === undefined) return value;
  if (typeof ref !== "string" || depth >= maxDepth) return undefined;
  const target = schemaAt(document, ref);
  return target === undefined ? undefined : resolvedSchema(document, target, depth + 1, maxDepth);
}

function definitionMap(document: Record<string, unknown>): Record<string, unknown> {
  if (isPlainObject(document.definitions)) return document.definitions;
  const components = document.components;
  if (isPlainObject(components) && isPlainObject(components.schemas)) return components.schemas;
  return {};
}

function relationDefinition(definitions: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  const direct = definitions[name];
  if (hasOwn(definitions, name) && isPlainObject(direct)) return direct;
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return undefined;
  }
  if (decoded === name) return undefined;
  const decodedDefinition = definitions[decoded];
  return hasOwn(definitions, decoded) && isPlainObject(decodedDefinition) ? decodedDefinition : undefined;
}

function methodsFor(pathItem: Record<string, unknown>): readonly string[] {
  return METHOD_ORDER.filter((method) => isPlainObject(pathItem[method]));
}

function propertySchema(
  document: unknown,
  schema: unknown,
  maxSchemaDepth: number,
): Record<string, unknown> | undefined {
  return resolvedSchema(document, schema, 0, maxSchemaDepth);
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function enumValues(value: unknown): readonly (string | number | boolean | null)[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: (string | number | boolean | null)[] = [];
  for (const item of value) {
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      result.push(item);
    } else if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0)) {
      result.push(item);
    } else {
      return undefined;
    }
  }
  return result;
}

function relationMetadata(
  document: Record<string, unknown>,
  definitions: Record<string, unknown>,
  name: string,
  pathItem: Record<string, unknown>,
  options: PostgrestOpenApiParseOptions,
): PostgrestRelationDiscovery {
  const definition = relationDefinition(definitions, name);
  const properties = definition === undefined ? undefined : definition.properties;
  const required = definition === undefined ? undefined : stringArray(definition.required);
  const requiredSet = required === undefined ? undefined : new Set(required);
  const methods = methodsFor(pathItem);

  if (!isPlainObject(properties)) {
    return {
      name,
      methods,
      readable: methods.includes("get"),
      fields: [],
      fieldsStatus: "unavailable",
      omittedFields: 0,
      primaryKey: { status: "unavailable", columns: [] },
      idColumn: { name: options.idColumn, present: false, declaredPrimaryKey: false },
      adapterQueryable: false,
      adapterQueryableReason: "the OpenAPI document does not declare this relation's fields",
    };
  }

  const entries = Object.entries(properties);
  const included = entries.slice(0, options.maxFieldsPerRelation);
  const fields: PostgrestFieldDiscovery[] = [];
  const primaryKeyColumns: string[] = [];
  for (const [fieldName, rawField] of included) {
    const field = propertySchema(document, rawField, options.maxSchemaDepth);
    const description = field !== undefined && typeof field.description === "string" ? field.description : "";
    const declaredPrimaryKey = PRIMARY_KEY_MARKER.test(description);
    if (declaredPrimaryKey) primaryKeyColumns.push(fieldName);
    const type = field !== undefined && typeof field.type === "string" ? field.type : undefined;
    const format = field !== undefined && typeof field.format === "string" ? field.format : undefined;
    const array = type === "array" || (format !== undefined && format.endsWith("[]"));
    const items = field !== undefined && isPlainObject(field.items) ? field.items : undefined;
    const itemsType = items !== undefined && typeof items.type === "string" ? items.type : undefined;
    const enum_ = field !== undefined ? enumValues(field.enum) : undefined;
    const typeStatus = type !== undefined || format !== undefined || itemsType !== undefined || enum_ !== undefined
      ? "declared"
      : "unavailable";
    fields.push({
      name: fieldName,
      ...(type === undefined ? {} : { type }),
      ...(format === undefined ? {} : { format }),
      array,
      ...(itemsType === undefined ? {} : { itemsType }),
      ...(requiredSet === undefined ? {} : { nullable: !requiredSet.has(fieldName) }),
      declaredPrimaryKey,
      typeStatus,
      ...(enum_ === undefined ? {} : { enumValues: enum_ }),
    });
  }

  const truncated = entries.length > included.length;
  const fieldsStatus = truncated ? "truncated" : "declared";
  const primaryKeyStatus = primaryKeyColumns.length > 0
    ? "declared"
    : truncated
      ? "unavailable"
      : "not-declared";
  const idColumnPresent = fields.some((field) => field.name === options.idColumn);
  const simpleName = ADAPTER_IDENTIFIER.test(name);
  const adapterQueryable = simpleName && idColumnPresent;
  let adapterQueryableReason: string | undefined;
  if (!simpleName) adapterQueryableReason = "the relation name is not a simple SQL identifier";
  else if (!idColumnPresent) adapterQueryableReason = `the configured ${options.idColumn} column is not declared on this relation`;

  return {
    name,
    methods,
    readable: methods.includes("get"),
    fields,
    fieldsStatus,
    omittedFields: entries.length - included.length,
    primaryKey: { status: primaryKeyStatus, columns: primaryKeyColumns },
    idColumn: {
      name: options.idColumn,
      present: idColumnPresent,
      declaredPrimaryKey: primaryKeyColumns.includes(options.idColumn),
    },
    adapterQueryable,
    ...(adapterQueryableReason === undefined ? {} : { adapterQueryableReason }),
  };
}

/**
 * Parses only the in-memory OpenAPI document. It never follows `$ref` over the
 * network: a remote or unresolvable reference makes that field's type
 * explicitly unavailable. Array/depth/body bounds are enforced by the caller
 * and by this parser's relation/field slices.
 */
export function parsePostgrestOpenApi(
  document: unknown,
  options: PostgrestOpenApiParseOptions,
): PostgrestOpenApiParseResult {
  if (!isPlainObject(document)) {
    return { status: "unavailable", reason: "malformed-metadata", detail: "the OpenAPI document is not a JSON object" };
  }
  const paths = document.paths;
  if (!isPlainObject(paths)) {
    return { status: "unavailable", reason: "malformed-metadata", detail: "the OpenAPI document has no path object" };
  }
  const definitions = definitionMap(document);
  const relationPaths: [string, Record<string, unknown>][] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    const match = RELATION_PATH.exec(path);
    if (match === null || !isPlainObject(pathItem) || path === "/") continue;
    const name = match[1];
    if (name === undefined) continue;
    relationPaths.push([name, pathItem]);
  }
  if (relationPaths.length === 0) {
    return {
      status: "unavailable",
      reason: "no-relations",
      detail: "the request role sees no exposed relations; this is not evidence that the database is empty",
    };
  }
  const included = relationPaths.slice(0, options.maxRelations);
  return {
    status: "available",
    relations: included.map(([name, pathItem]) => relationMetadata(document, definitions, name, pathItem, options)),
    relationCount: relationPaths.length,
    truncated: relationPaths.length > included.length,
    omittedRelations: relationPaths.length - included.length,
  };
}
