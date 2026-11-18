import { MongoReadError, type MongoDocument, type MongoReadRequest } from "./types.js";

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function onlyKeys(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new MongoReadError("unsupported");
}
export function field(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256
    || value.split(".").some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(part)
      || ["__proto__", "prototype", "constructor"].includes(part))) throw new MongoReadError("unsupported");
}
export function positive(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new MongoReadError("bounds");
  return result;
}
export function aborted(signal: AbortSignal): boolean { return signal.aborted; }
// JSON.stringify's lib declaration returns string even though a top-level
// undefined/function/symbol (or toJSON returning undefined) returns undefined.
function stringify(value: unknown): unknown { return JSON.stringify(value); }
export function jsonBytes(value: unknown, maximum: number): string {
  let text: unknown;
  try { text = stringify(value); } catch { throw new MongoReadError("protocol"); }
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > maximum) throw new MongoReadError("bounds");
  return text;
}

/** Refuses executable BSON, regular expressions and unbounded operator trees. */
export function validateFilter(filter: unknown): asserts filter is MongoDocument {
  let nodes = 0;
  const visit = (depth: number): void => {
    nodes += 1;
    if (nodes > 2048 || depth > 12) throw new MongoReadError("bounds");
  };
  const literal = (value: unknown, depth: number): void => {
    visit(depth);
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)) || Object.is(value, -0)) throw new MongoReadError("unsupported");
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > 256) throw new MongoReadError("bounds");
      for (const item of value) literal(item, depth + 1);
      return;
    }
    if (!object(value)) throw new MongoReadError("unsupported");
    const keys = Object.keys(value);
    const tags = ["$oid", "$numberInt", "$numberLong", "$numberDouble", "$numberDecimal", "$date", "$binary", "$timestamp", "$minKey", "$maxKey"];
    for (const key of keys) {
      if (key.startsWith("$")) {
        if (keys.length !== 1 || !tags.includes(key)) throw new MongoReadError("unsupported");
      } else field(key);
      literal(value[key], depth + 1);
    }
  };
  const match = (value: unknown, depth: number): void => {
    visit(depth);
    if (!object(value)) throw new MongoReadError("unsupported");
    for (const [key, operand] of Object.entries(value)) {
      if (["$and", "$or", "$nor"].includes(key)) {
        if (!Array.isArray(operand) || operand.length < 1 || operand.length > 64) throw new MongoReadError("unsupported");
        for (const child of operand) match(child, depth + 1);
        continue;
      }
      field(key);
      if (object(operand) && Object.keys(operand).some((name) => name.startsWith("$") && !["$oid", "$numberInt", "$numberLong", "$numberDouble", "$numberDecimal", "$date", "$binary", "$timestamp", "$minKey", "$maxKey"].includes(name))) {
        for (const [operator, value] of Object.entries(operand)) {
          if (!["$eq", "$ne", "$lt", "$lte", "$gt", "$gte", "$in", "$nin", "$exists"].includes(operator)) throw new MongoReadError("unsupported");
          if ((operator === "$in" || operator === "$nin") && (!Array.isArray(value) || value.length === 0 || value.length > 256)) throw new MongoReadError("unsupported");
          if (operator === "$exists" && typeof value !== "boolean") throw new MongoReadError("unsupported");
          literal(value, depth + 1);
        }
      } else literal(operand, depth + 1);
    }
  };
  match(filter, 0);
}

export function validateRequest(value: unknown, maxRows: number, maxRequestBytes: number): asserts value is MongoReadRequest {
  jsonBytes(value, maxRequestBytes);
  if (!object(value)) throw new MongoReadError("unsupported");
  if (value.kind === "discover") { onlyKeys(value, ["kind"]); return; }
  field(value.collection);
  positive(typeof value.limit === "number" ? value.limit : NaN, maxRows, maxRows);
  if (value.kind === "find") {
    onlyKeys(value, ["kind", "collection", "filter", "limit", "after"]);
    validateFilter(value.filter ?? {});
    if (value.after !== undefined && (typeof value.after !== "string" || value.after.length > 32_768)) throw new MongoReadError("bounds");
    return;
  }
  if (value.kind !== "aggregate") throw new MongoReadError("unsupported");
  onlyKeys(value, ["kind", "collection", "pipeline", "limit"]);
  if (!Array.isArray(value.pipeline) || value.pipeline.length > 16) throw new MongoReadError("bounds");
  for (const stage of value.pipeline) {
    if (!object(stage) || Object.keys(stage).length !== 1) throw new MongoReadError("unsupported");
    if (Object.hasOwn(stage, "$match")) { validateFilter(stage.$match); continue; }
    if (Object.hasOwn(stage, "$limit")) {
      positive(typeof stage.$limit === "number" ? stage.$limit : NaN, maxRows, maxRows);
      continue;
    }
    const sort = Object.hasOwn(stage, "$sort");
    const body = sort ? stage.$sort : stage.$project;
    if ((!sort && !Object.hasOwn(stage, "$project")) || !object(body) || Object.keys(body).length < 1 || Object.keys(body).length > 256) throw new MongoReadError("unsupported");
    for (const [key, item] of Object.entries(body)) {
      field(key);
      if (sort ? item !== 1 && item !== -1 : item !== 0 && item !== 1) throw new MongoReadError("unsupported");
    }
  }
}
