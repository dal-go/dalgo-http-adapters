import { fail } from "./wire.js";
import { hashPayload } from "./canonical.js";
import { normalizeScalar, type AnalyticalField } from "./values.js";
export interface SchemaField extends AnalyticalField {
  readonly name: string;
  readonly fields?: readonly SchemaField[];
  readonly precision?: string;
  readonly scale?: string;
}
export interface SourceProfile {
  readonly version: 1;
  readonly sourceId: string;
  readonly descriptorDigest: string;
  readonly logicalCollection: string;
  readonly sourceProject: string;
  readonly datasetId: string;
  readonly tableId: string;
  readonly location: string;
  readonly schema: readonly SchemaField[];
  readonly publisherReviewRef: string;
  readonly rightsReviewRef: string;
  readonly use: "connection-test" | "admitted";
}
export interface Principal {
  readonly kind: "google-user" | "workload";
  readonly subject: string;
  readonly generation: string;
}
export interface Execution {
  readonly jobProject: string;
  readonly principal: Principal;
  readonly maximumBytesBilled: string;
  readonly sessionBudgetBytes: string;
}
export interface Bounds {
  readonly pageSize: number;
  readonly maxRows: number;
  readonly maxPages: number;
  readonly responseBytes: number;
  readonly totalResponseBytes: number;
  readonly wallMs: number;
  readonly httpMs: number;
  readonly concurrency: 1;
}
export interface Predicate {
  readonly op: string;
  readonly column?: string;
  readonly value?: unknown;
  readonly items?: readonly Predicate[];
}
export interface ReadQuery {
  readonly from: string;
  readonly projection: readonly string[];
  readonly where: Predicate | null;
  readonly order: readonly {
    readonly column: string;
    readonly direction: "ASC" | "DESC";
  }[];
  readonly limit: number;
}
export interface Parameter {
  readonly name: string;
  readonly type: string;
  readonly value: string | boolean | null | readonly (string | boolean)[];
}
export interface CompiledPredicate {
  readonly op: string;
  readonly column?: string;
  readonly parameter?: string;
  readonly children?: readonly CompiledPredicate[];
}
export interface ReadPlan {
  readonly version: 1;
  readonly sourceDigest: string;
  readonly projection: readonly string[];
  readonly where: CompiledPredicate | null;
  readonly order: ReadQuery["order"];
  readonly limit: number;
  readonly parameters: readonly Parameter[];
  readonly sql: string;
  readonly digest: string;
}
export interface JobRef {
  readonly projectId: string;
  readonly jobId: string;
  readonly location: string;
}
export interface Observation {
  readonly table: {
    readonly projectId: string;
    readonly datasetId: string;
    readonly tableId: string;
  };
  readonly location: string;
  readonly type: "TABLE";
  readonly config: Readonly<Record<string, unknown>>;
  readonly schema: readonly SchemaField[];
  readonly digest: string;
  readonly observedAt: string;
}
export type RunState = "reserved" | "submitting" | "submission_unknown" | "running" | "completed" | "failed" | "cancelled" | "cancel_requested";
export interface Counters {
  bytes: number;
  rows: number;
  pages: number;
}
export interface Receipt {
  readonly version: 1;
  readonly runId: string;
  readonly approvalDigest: string;
  readonly sourceDigest: string;
  readonly observationDigest: string;
  readonly schemaDigest: string;
  readonly principal: Principal;
  readonly job?: JobRef;
  readonly state: RunState;
  readonly runStartedAt: string;
  readonly executionDeadline: string;
  readonly bounds: Bounds;
  readonly counters: Counters;
  readonly localStopped: boolean;
  readonly reason?: string;
  readonly processedBytes?: string;
  readonly billedBytes?: string;
  readonly cacheHit?: boolean;
  readonly warnings: readonly string[];
  readonly residualSourceReplacementRace: true;
}
export interface Page {
  readonly schema: readonly SchemaField[];
  readonly rows: readonly (readonly import("./values.js").AnalyticalCell[])[];
  readonly cursor?: string;
  readonly receipt: Receipt;
}
export function cloneFrozen<T>(value: T): T {
  let copy: T;
  try {
    copy = structuredClone(value);
  }
  catch {
    return fail("invalid_input");
  }
  function freeze(value: unknown): void {
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value))
        freeze(child);
      Object.freeze(value);
    }
  }
  freeze(copy);
  return copy;
}
export function timestamp(now: number): string { if (!Number.isSafeInteger(now))
  fail("invalid_input"); return new Date(now).toISOString().replace(/\.000Z$/u, "Z").replace(/(\.\d*?[1-9])0+Z$/u, "$1Z"); }
export function encoded(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }
export async function digest(name: Parameters<typeof hashPayload>[0], value: unknown): Promise<string> { return (await hashPayload(name, encoded(value))).digest; }
export function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = [], code: Parameters<typeof fail>[0] = "invalid_input"): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(code);
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)))
    fail(code);
}
export function nonempty(value: unknown, maximum = 1024): asserts value is string { if (typeof value !== "string" || value.length === 0 || value.length > maximum)
  fail("invalid_input"); normalizeScalar({
  type: "STRING"
}, value); }
export function identifier(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) || value.length > 128)
  fail("invalid_input"); }
export function project(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(value))
  fail("invalid_input"); }
export function positiveBytes(value: unknown): string { if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value) || value.length > 19 || BigInt(value) > 9223372036854775807n)
  fail("invalid_input"); return value; }
export function integerText(value: unknown, code: Parameters<typeof fail>[0] = "malformed_wire"): string { if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value) || value.length > 19 || BigInt(value) > 9223372036854775807n)
  fail(code); return value; }
export function validatePrincipal(value: Principal): void { exactKeys(value, ["kind", "subject", "generation"]); if (value.kind !== "google-user" && value.kind !== "workload")
  fail("invalid_input"); nonempty(value.subject); nonempty(value.generation); }
export function validateExecution(value: Execution): void { exactKeys(value, ["jobProject", "principal", "maximumBytesBilled", "sessionBudgetBytes"]); project(value.jobProject); validatePrincipal(value.principal); positiveBytes(value.maximumBytesBilled); positiveBytes(value.sessionBudgetBytes); }
export function bounds(value: Partial<Bounds> = {}): Bounds {
  exactKeys(value, [], ["pageSize", "maxRows", "maxPages", "responseBytes", "totalResponseBytes", "wallMs", "httpMs", "concurrency"]);
  const defaults: Bounds = {
    pageSize: 100, maxRows: 1000, maxPages: 100, responseBytes: 4 * 1024 * 1024, totalResponseBytes: 32 * 1024 * 1024, wallMs: 120000, httpMs: 15000, concurrency: 1
  };
  const maxima: Bounds = {
    ...defaults, pageSize: 1000, maxRows: 10000, responseBytes: 10 * 1024 * 1024
  };
  const result = {
    ...defaults, ...value
  };
  for (const key of Object.keys(defaults) as (keyof Bounds)[])
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > maxima[key])
      fail("invalid_input");
  return cloneFrozen(result);
}
export function validateSchema(value: readonly SchemaField[], depth = 0, counter = {
  count: 0
}): void {
  if (!Array.isArray(value) || value.length === 0 || depth > 32)
    fail("malformed_wire");
  const seen = new Set<string>();
  for (const field of value) {
    exactKeys(field, ["name", "type"], ["mode", "fields", "precision", "scale"], "malformed_wire");
    identifier(field.name);
    if (seen.has(field.name))
      fail("malformed_wire");
    seen.add(field.name);
    if (++counter.count > 1024)
      fail("response_limit");
    if (typeof field.type !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(field.type) || ![undefined, "NULLABLE", "REQUIRED", "REPEATED"].includes(field.mode))
      fail("malformed_wire");
    for (const key of ["precision", "scale"] as const)
      if (field[key] !== undefined)
        integerText(field[key]);
    if (field.fields !== undefined)
      validateSchema(field.fields, depth + 1, counter);
    if ((field.type === "RECORD" || field.type === "STRUCT") !== (field.fields !== undefined))
      fail("malformed_wire");
    if (field.scale !== undefined && field.precision === undefined)
      fail("malformed_wire");
    if (field.precision !== undefined || field.scale !== undefined) {
      if (!["NUMERIC", "BIGNUMERIC"].includes(field.type))
        fail("malformed_wire");
      const precision = Number(field.precision ?? (field.type === "NUMERIC" ? "38" : "76"));
      const scale = Number(field.scale ?? "0");
      if (precision < 1 || precision > (field.type === "NUMERIC" ? 38 : 76) || scale > (field.type === "NUMERIC" ? 9 : 38) || scale > precision || precision - scale > (field.type === "NUMERIC" ? 29 : 38))
        fail("malformed_wire");
    }
  }
}
export function validateSource(source: SourceProfile): void {
  exactKeys(source, "version sourceId descriptorDigest logicalCollection sourceProject datasetId tableId location schema publisherReviewRef rightsReviewRef use".split(" "));
  if (source.version !== 1 || !["connection-test", "admitted"].includes(source.use))
    fail("invalid_input");
  for (const key of ["sourceId", "descriptorDigest", "location", "publisherReviewRef", "rightsReviewRef"] as const)
    nonempty(source[key]);
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/u.test(source.location))
    fail("invalid_input");
  project(source.sourceProject);
  for (const key of ["logicalCollection", "datasetId", "tableId"] as const)
    identifier(source[key]);
  validateSchema(source.schema);
  const reviewedModes = (fields: readonly SchemaField[]): void => { for (const field of fields) {
    if (field.mode === undefined)
      fail("invalid_input");
    if (field.fields !== undefined)
      reviewedModes(field.fields);
  } };
  reviewedModes(source.schema);
}
export function supportedField(field: SchemaField): void { normalizeScalar(field, field.mode === "REQUIRED" ? sample(field.type) : null); if (field.fields !== undefined || field.mode === "REPEATED")
  fail("unsupported_type"); }
function sample(type: string): string { return ({
  BOOL: "true", BOOLEAN: "true", DATE: "2000-01-01", TIME: "00:00:00", DATETIME: "2000-01-01T00:00:00", BYTES: "", JSON: "null", STRING: ""
} as Record<string, string>)[type] ?? "0"; }
export function normalizeParameter(field: SchemaField, value: unknown): string | boolean | null {
  if (value === null)
    return null; // Parameters have declared type; column nullability is not parameter nullability.
  let wire: unknown = value;
  if (field.type === "BOOL" || field.type === "BOOLEAN") {
    if (typeof value !== "boolean")
      fail("invalid_input");
    wire = value ? "true" : "false";
  }
  const cell = normalizeScalar({
    type: field.type
  }, wire);
  if (typeof cell.value === "string" && ["NUMERIC", "BIGNUMERIC"].includes(cell.type))
    checkDecimalConstraints(field, cell.value);
  return cell.value;
}
export function checkDecimalConstraints(field: SchemaField, value: string): void {
  if (field.precision === undefined && field.scale === undefined)
    return;
  const [whole = "", fraction = ""] = value.replace(/^-/, "").split(".");
  const precision = Number(field.precision ?? (field.type === "NUMERIC" ? "38" : "76"));
  const scale = Number(field.scale ?? "0");
  if (fraction.length > scale || (whole === "0" ? 0 : whole.length) > precision - scale)
    fail("unsupported_value");
}
export async function compileReadPlan(source: SourceProfile, query: ReadQuery): Promise<ReadPlan> {
  validateSource(source);
  exactKeys(query, ["from", "projection", "where", "order", "limit"], [], "unsupported_query");
  if (query.from !== source.logicalCollection || !Array.isArray(query.projection) || query.projection.length < 1 || query.projection.length > 128 || new Set(query.projection).size !== query.projection.length || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 10000 || !Array.isArray(query.order) || query.order.length > 16)
    fail("unsupported_query");
  const fields = new Map(source.schema.map(field => [field.name, field]));
  const column = (name: unknown): SchemaField => { identifier(name); const field = fields.get(name); if (field === undefined)
    fail("unsupported_query"); supportedField(field); return field; };
  query.projection.forEach(column);
  const parameters: Parameter[] = [];
  let nodes = 0;
  const predicate = (p: Predicate, depth: number): {
    sql: string;
    condition: CompiledPredicate;
  } => {
    if (++nodes > 128 || depth >= 8)
      fail("unsupported_query");
    if (p === null || typeof p !== "object")
      fail("unsupported_query");
    if (p.op === "AND" || p.op === "OR") {
      exactKeys(p, ["op", "items"], [], "unsupported_query");
      if (!Array.isArray(p.items) || p.items.length === 0)
        fail("unsupported_query");
      const children = p.items.map(item => predicate(item, depth + 1));
      return {
        sql: `(${children.map(child => child.sql).join(` ${p.op} `)})`, condition: {
          op: p.op, children: children.map(child => child.condition)
        }
      };
    }
    exactKeys(p, ["op", "column"], ["value"], "unsupported_query");
    const field = column(p.column);
    if (["JSON", "BYTES"].includes(field.type) && !["IS NULL", "IS NOT NULL"].includes(p.op))
      fail("unsupported_type");
    const expression = `\`${field.name}\``;
    if (p.op === "IS NULL" || p.op === "IS NOT NULL") {
      if (Object.hasOwn(p, "value"))
        fail("unsupported_query");
      return {
        sql: `${expression} ${p.op}`, condition: {
          op: p.op, column: field.name
        }
      };
    }
    if (!["=", "!=", "<", "<=", ">", ">=", "IN"].includes(p.op) || !Object.hasOwn(p, "value"))
      fail("unsupported_query");
    if (["BOOL", "BOOLEAN"].includes(field.type) && !["=", "!=", "IN"].includes(p.op))
      fail("unsupported_query");
    if (p.value === null)
      fail("unsupported_query");
    const name = `p${parameters.length}`;
    if (p.op === "IN") {
      if (!Array.isArray(p.value) || p.value.length > 1000 || p.value.some(value => value === null))
        fail("unsupported_query");
      parameters.push({
        name, type: `ARRAY<${normalizeScalar({
          type: field.type
        }, null).type}>`, value: p.value.map(value => normalizeParameter(field, value) as string | boolean)
      });
      return {
        sql: p.value.length === 0 ? "FALSE" : `${expression} IN UNNEST(@${name})`, condition: {
          op: p.op, column: field.name, parameter: name
        }
      };
    }
    parameters.push({
      name, type: normalizeScalar({
        type: field.type
      }, null).type, value: normalizeParameter(field, p.value)
    });
    return {
      sql: `${expression} ${p.op} @${name}`, condition: {
        op: p.op, column: field.name, parameter: name
      }
    };
  };
  const normalizedWhere = query.where === null ? null : predicate(query.where, 0);
  const where = normalizedWhere === null ? "" : ` WHERE ${normalizedWhere.sql}`;
  const orderNames = new Set<string>();
  const ordering = query.order.map(item => { exactKeys(item, ["column", "direction"], [], "unsupported_query"); const field = column(item.column); if (["BOOL", "BOOLEAN", "JSON", "BYTES"].includes(field.type) || !["ASC", "DESC"].includes(item.direction) || orderNames.has(item.column))
    fail("unsupported_query"); orderNames.add(item.column); return `\`${item.column}\` ${item.direction}`; });
  const sourceDigest = await digest("SourceProfile", source);
  const payload = {
    version: 1 as const, sourceDigest, projection: [...query.projection], where: normalizedWhere?.condition ?? null, order: query.order, limit: query.limit, parameters, sql: `SELECT ${query.projection.map(name => `\`${name}\``).join(", ")} FROM \`${source.sourceProject}.${source.datasetId}.${source.tableId}\`${where}${ordering.length === 0 ? "" : ` ORDER BY ${ordering.join(", ")}`} LIMIT ${query.limit}`
  };
  return cloneFrozen({
    ...payload, digest: await digest("ReadPlan", payload)
  });
}
export function wireParameters(parameters: readonly Parameter[]): readonly unknown[] {
  return parameters.map(parameter => ({
    name: parameter.name, parameterType: Array.isArray(parameter.value) ? {
      type: "ARRAY", arrayType: {
        type: parameter.type.slice(6, -1)
      }
    } : {
      type: parameter.type
    }, parameterValue: Array.isArray(parameter.value) ? {
      arrayValues: parameter.value.map(value => ({
        value: typeof value === "boolean" ? String(value) : value
      }))
    } : {
      value: typeof parameter.value === "boolean" ? String(parameter.value) : parameter.value
    }
  }));
}
