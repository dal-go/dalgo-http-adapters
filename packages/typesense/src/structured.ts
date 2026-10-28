import {
  DOCUMENT_ID,
  UnsupportedError,
  type QueryFilter,
  type StructuredQuery,
  type TugQLComparison,
  type TugQLCondition,
  type TugQLConditionGroup,
  type TugQLExpression,
  type TugQLNullTest,
} from "@dalgo/core";

import { isLosslessNumber } from "./json.js";

/** A core `StructuredQuery` plus the approved provider-local additions. */
export interface TypesenseQuery<T> extends StructuredQuery<T> {
  /** Provider-local exact predicate, ANDed with the flat `filters` array. */
  readonly where?: TugQLCondition;
  /** Exact top-level fields to return. The native id is fetched but not returned unless named. */
  readonly projection?: readonly string[];
}

const SIMPLE_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_CONDITIONS = 64;
const MAX_STRING_BYTES = 1_024;
const MAX_IN_VALUES = 100;
const YIELD_EVERY = 256;

export type Truth = "true" | "false" | "unknown";

export type LiteralClass = "string" | "number" | "boolean";

export interface FilterLiteral {
  readonly class: LiteralClass;
  readonly value: string | number | boolean;
  readonly wire: string;
}

export interface ComparisonNode {
  readonly kind: "comparison";
  readonly field: string;
  readonly operator: "==" | "<" | "<=" | ">" | ">=" | "in";
  readonly literal?: FilterLiteral;
  readonly literals?: readonly FilterLiteral[];
}

export interface GroupNode {
  readonly kind: "group";
  readonly operator: "and" | "or";
  readonly children: readonly ConditionNode[];
}

export type ConditionNode = ComparisonNode | GroupNode;

export interface CompileOptions {
  readonly maxFilterBytes: number;
  readonly maxDepth?: number;
  readonly maxConditions?: number;
}

export function structuredField(value: unknown): string {
  const name = value === DOCUMENT_ID ? "id" : String(value);
  if (name === "id") return "id";
  if (!SIMPLE_FIELD.test(name)) {
    throw new UnsupportedError("Typesense structured queries support simple top-level fields only");
  }
  return name;
}

export function projectionFields(value: readonly string[] | undefined, maximum: number): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new UnsupportedError(`Typesense projection must contain from 1 to ${String(maximum)} fields`);
  }
  const fields = value.map((field) => structuredField(field));
  if (new Set(fields).size !== fields.length) {
    throw new UnsupportedError("Typesense projection fields must be unique");
  }
  return Object.freeze(fields);
}

export function orderFields(
  orders: StructuredQuery<unknown>["orders"],
  maximum: number,
): readonly { readonly field: string; readonly direction: "asc" | "desc" }[] {
  if (orders.length > maximum) {
    throw new UnsupportedError(`Typesense sort_by exceeds ${String(maximum)} fields`);
  }
  const result: { field: string; direction: "asc" | "desc" }[] = [];
  const seen = new Set<string>();
  for (const order of orders) {
    const field = structuredField(order.field);
    if (field === "id") throw new UnsupportedError("Typesense does not invent an id sort");
    if (order.direction !== "asc" && order.direction !== "desc") {
      throw new UnsupportedError("Typesense sort directions");
    }
    if (seen.has(field)) throw new UnsupportedError("Typesense duplicate sort fields");
    seen.add(field);
    result.push({ field, direction: order.direction });
  }
  return Object.freeze(result.map((item) => Object.freeze(item)));
}

export function isNumericSchemaType(type: string | undefined): boolean {
  return type === "int32" || type === "int64" || type === "float";
}

export function isNumericField(fields: ReadonlyMap<string, string>, field: string): boolean {
  return isNumericSchemaType(fields.get(field));
}

function stringLiteral(value: string): FilterLiteral {
  if (value.length === 0) throw new UnsupportedError("Typesense filter strings must not be empty");
  if (!value.isWellFormed()) {
    throw new UnsupportedError("Typesense filter strings must be valid, bounded and control-free");
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x60) {
      throw new UnsupportedError("Typesense filter strings must be valid, bounded and control-free");
    }
  }
  if (new TextEncoder().encode(value).byteLength > MAX_STRING_BYTES) {
    throw new UnsupportedError("Typesense filter strings exceed the supported byte length");
  }
  return { class: "string", value, wire: `\`${value}\`` };
}

function numberLiteral(value: number): FilterLiteral {
  if (!isLosslessNumber(value)) {
    throw new UnsupportedError("Typesense filter numbers must be finite, lossless safe values and not -0");
  }
  return { class: "number", value, wire: String(value) };
}

export function filterLiteral(value: unknown): FilterLiteral {
  if (typeof value === "string") return stringLiteral(value);
  if (typeof value === "number") return numberLiteral(value);
  if (typeof value === "boolean") return { class: "boolean", value, wire: value ? "true" : "false" };
  throw new UnsupportedError("Typesense filter values must be string, lossless number or boolean scalars");
}

function membershipLiterals(values: readonly unknown[]): readonly FilterLiteral[] {
  if (values.length === 0) throw new UnsupportedError("Typesense IN lists must not be empty");
  if (values.length > MAX_IN_VALUES) {
    throw new UnsupportedError(`Typesense IN lists must not exceed ${String(MAX_IN_VALUES)} values`);
  }
  const literals = values.map((value) => filterLiteral(value));
  const first = literals[0]?.class;
  if (!literals.every((literal) => literal.class === first)) {
    throw new UnsupportedError("Typesense IN lists must use one scalar class");
  }
  const wires = new Set(literals.map((literal) => literal.wire));
  if (wires.size !== literals.length) {
    throw new UnsupportedError("Typesense IN lists must not repeat a value");
  }
  return Object.freeze(literals);
}

function comparison(field: string, operator: QueryFilter<unknown>["operator"], right: unknown): ComparisonNode {
  if (operator === "!=" || operator === "not-in") {
    throw new UnsupportedError("Typesense structured negative predicates are refused before I/O");
  }
  if (operator === "array-contains" || operator === "array-contains-any") {
    throw new UnsupportedError("Typesense structured array membership is not an exact core contract and is refused before I/O");
  }
  if (operator === "in") {
    if (!Array.isArray(right)) throw new UnsupportedError("Typesense structured IN requires an array value");
    return { kind: "comparison", field, operator, literals: membershipLiterals(right) };
  }
  if (operator !== "==" && operator !== "<" && operator !== "<=" && operator !== ">" && operator !== ">=") {
    throw new UnsupportedError("Typesense structured comparison operator is not supported");
  }
  if (right === null) throw new UnsupportedError("Typesense structured null comparisons are refused before I/O");
  return { kind: "comparison", field, operator, literal: filterLiteral(right) };
}

function expressionScalar(expression: TugQLExpression): unknown {
  if (expression.kind === "literal") return expression.value;
  throw new UnsupportedError("Typesense structured comparisons require a literal right operand");
}

function expressionMembership(expression: TugQLExpression): readonly unknown[] {
  if (expression.kind === "values") return expression.values;
  if (expression.kind === "literal" && Array.isArray(expression.value)) return expression.value;
  throw new UnsupportedError("Typesense structured IN requires a values list");
}

function comparisonFromCondition(node: TugQLComparison): ComparisonNode {
  if (node.left.kind !== "field" || node.left.field.source !== "") {
    throw new UnsupportedError("Typesense structured comparisons require one unqualified field on the left");
  }
  const field = structuredField(node.left.field.field);
  if (node.operator === "in") return comparison(field, node.operator, expressionMembership(node.right));
  return comparison(field, node.operator, expressionScalar(node.right));
}

function compileWhere(
  value: TugQLCondition,
  depth: number,
  maxDepth: number,
  maxConditions: number,
  charge: () => void,
): ConditionNode {
  void maxConditions;
  charge();
  if (depth > maxDepth) throw new UnsupportedError("Typesense condition tree exceeds the configured depth bound");
  if (!("kind" in value)) return comparisonFromCondition(value as TugQLComparison);
  if (value.kind === "and" || value.kind === "or") {
    const group = value as TugQLConditionGroup;
    if (group.conditions.length === 0) throw new UnsupportedError("Typesense empty condition groups");
    return {
      kind: "group",
      operator: group.kind,
      children: group.conditions.map((child) => compileWhere(child, depth + 1, maxDepth, maxConditions, charge)),
    };
  }
  if (value.kind === "is-null" || value.kind === "is-not-null") {
    void (value as TugQLNullTest);
    throw new UnsupportedError("Typesense structured null tests are refused before I/O");
  }
  throw new UnsupportedError("Typesense condition type is not supported");
}

function collect(node: ConditionNode, fields: Set<string>, ranges: Set<string>): void {
  if (node.kind === "group") {
    for (const child of node.children) collect(child, fields, ranges);
    return;
  }
  fields.add(node.field);
  if (node.operator === "<" || node.operator === "<=" || node.operator === ">" || node.operator === ">=") {
    ranges.add(node.field);
  }
}

function render(node: ConditionNode, numeric: ReadonlyMap<string, string>, maxBytes: number): string {
  if (node.kind === "group") {
    const parts = node.children.map((child) => render(child, numeric, maxBytes));
    const result = `(${parts.join(node.operator === "and" ? " && " : " || ")})`;
    if (new TextEncoder().encode(result).byteLength > maxBytes) throw new RangeError("Typesense structured filter exceeds maxFilterBytes");
    return result;
  }
  const literal = node.literal?.wire;
  switch (node.operator) {
    case "==": return `${node.field}:=${String(literal)}`;
    case "<": case "<=": {
      if (!isNumericField(numeric, node.field)) throw new UnsupportedError("Typesense structured ranges require a schema-declared scalar numeric field");
      return `${node.field}:<=${String(literal)}`;
    }
    case ">": case ">=": {
      if (!isNumericField(numeric, node.field)) throw new UnsupportedError("Typesense structured ranges require a schema-declared scalar numeric field");
      return `${node.field}:>=${String(literal)}`;
    }
    case "in": return `${node.field}:=[${(node.literals ?? []).map((item) => item.wire).join(",")}]`;
    default: throw new UnsupportedError("Typesense structured comparison operator is not supported");
  }
}

/** Renders the final filter after the database has supplied the real schema. */
export function renderPredicate(node: ConditionNode, numeric: ReadonlyMap<string, string>, maxBytes: number): string {
  return render(node, numeric, maxBytes);
}

/**
 * Builds and validates the complete admitted condition AST before any request.
 * Numeric ranges are rendered later, once the real collection schema proves
 * that the field is a scalar numeric type.
 */
export function predicateRoot<T>(query: TypesenseQuery<T>, options: CompileOptions): ConditionNode | undefined {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxConditions = options.maxConditions ?? DEFAULT_MAX_CONDITIONS;
  let budget = 0;
  const charge = (): void => {
    budget += 1;
    if (budget > maxConditions) throw new UnsupportedError("Typesense condition tree exceeds the configured complexity bound");
  };
  const flat: ConditionNode[] = [];
  for (const filter of query.filters) {
    flat.push(comparison(structuredField(filter.field), filter.operator, filter.value));
    charge();
  }
  const where = query.where === undefined ? undefined : compileWhere(query.where, 1, maxDepth, maxConditions, charge);
  const children = [...flat, ...(where === undefined ? [] : [where])];
  if (children.length === 0) return undefined;
  return children.length === 1 ? children[0] as ConditionNode : { kind: "group", operator: "and", children };
}

export function collectPredicate(node: ConditionNode): { readonly fields: readonly string[]; readonly ranges: readonly string[] } {
  const fields = new Set<string>();
  const ranges = new Set<string>();
  collect(node, fields, ranges);
  return { fields: Object.freeze([...fields].sort()), ranges: Object.freeze([...ranges].sort()) };
}

export function createVerifier(node: ConditionNode): (data: Readonly<Record<string, unknown>>, check: () => void) => Promise<boolean> {
  return async (data, check) => {
    const state = { count: 0 };
    const truth = await evaluate(node, data, state, check);
    return truth === "true";
  };
}

interface EvalState { count: number; }

async function evaluate(
  node: ConditionNode,
  data: Readonly<Record<string, unknown>>,
  state: EvalState,
  check: () => void,
): Promise<Truth> {
  check();
  if (node.kind === "group") {
    const stopOn = node.operator === "or" ? "true" : "false";
    let unknown = false;
    for (const child of node.children) {
      const truth = await evaluate(child, data, state, check);
      if (truth === stopOn) return truth;
      if (truth === "unknown") unknown = true;
      await pulse(state, check);
    }
    if (unknown) return "unknown";
    return node.operator === "or" ? "false" : "true";
  }
  state.count += 1;
  const value = Object.hasOwn(data, node.field) ? data[node.field] : undefined;
  let result: Truth;
  if (node.operator === "in") {
    result = inTruth(value, node.literals ?? []);
  } else {
    const literal = node.literal;
    if (literal === undefined) throw new UnsupportedError("Typesense comparison has no literal");
    if (value === null || value === undefined) result = "unknown";
    else if (node.operator === "==") result = equal(value, literal.value) ? "true" : "false";
    else {
      const order = compare(value, literal.value);
      result = node.operator === "<" ? (order < 0 ? "true" : "false")
        : node.operator === "<=" ? (order <= 0 ? "true" : "false")
          : node.operator === ">" ? (order > 0 ? "true" : "false")
            : order >= 0 ? "true" : "false";
    }
  }
  await pulse(state, check);
  return result;
}

async function pulse(state: EvalState, check: () => void): Promise<void> {
  if (state.count % YIELD_EVERY !== 0) return;
  check();
  await yieldToEventLoop();
  check();
}

/** Yields an actual macrotask, not merely a promise microtask. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

/** The exact TypeScript core membership semantics: the entire left operand. */
function inTruth(left: unknown, literals: readonly FilterLiteral[]): Truth {
  let truth: Truth = "false";
  if (literals.length > 0) {
    if (literals.some((literal) => left !== null && left !== undefined && equal(left, literal.value))) truth = "true";
    else if (left === null || left === undefined) truth = "unknown";
  }
  return truth;
}

function equal(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") {
    return Number.isFinite(left) && Number.isFinite(right) && left === right;
  }
  return left === right;
}

/** Mirrors the pinned core's comparison order: null, then type rank, then value. */
function compare(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return right === undefined || right === null ? 0 : -1;
  if (right === undefined || right === null) return 1;
  const leftType = typeof left;
  const rightType = typeof right;
  if ((leftType === "number" && rightType === "number")
    || (leftType === "string" && rightType === "string")
    || (leftType === "boolean" && rightType === "boolean")) {
    return (left as number | string | boolean) < (right as number | string | boolean) ? -1 : 1;
  }
  return typeRank(left) - typeRank(right);
}

function typeRank(value: unknown): number {
  if (Array.isArray(value)) return 0;
  if (typeof value === "boolean") return 1;
  if (typeof value === "number") return 2;
  if (typeof value === "string") return 3;
  return 4;
}
