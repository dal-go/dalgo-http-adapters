// The pure TugQL pushdown planner of the Firestore adapter (spec
// firestore-tugql-pushdown in dal-go/dalgo). It decides, from a resolved and
// bound TugQL query and the options alone, whether runFirestoreTugQL answers
// the query with one Firestore query, one document read, no read at all, an
// in-memory evaluation (opt-in only), or a refusal. It never touches Firestore.
import {
  DOCUMENT_ID,
  type QueryFilter,
  type QueryOperator,
  type QueryOrder,
  type RecursiveTugQLColumn,
  type RecursiveTugQLCondition,
  type RecursiveTugQLExpression,
  type RecursiveTugQLQuery,
  type RecursiveTugQLRelation,
} from "@dalgo/core";

/** The reserved TugQL field name of a record's own key (the Firestore document id). */
export const TUGQL_KEY_FIELD = "__key__" as const;

type Data = Record<string, unknown>;

/** The fetched-row budget of DALgo-JS's recursive executor when none is set. */
export const DEFAULT_MAX_FETCHED_ROWS = 10_000;

/** Firestore's limit on the disjunctions of one query (the product of `in` list sizes). */
export const MAX_DISJUNCTIONS = 30;

/** Firestore's limit on the values of one `not-in` list. */
export const MAX_NOT_IN_VALUES = 10;

/** The options the planner reads. */
export interface FirestoreTugQLPlanOptions {
  readonly allowInMemoryEvaluation?: boolean;
  readonly maxFetchedRows?: number;
}

/** The refusal codes of the planner. */
export type FirestoreTugQLRefusalCode = "in_memory_evaluation" | "query_limit";

/** How runFirestoreTugQL answers a query. */
export type FirestoreTugQLPlan =
  /** One Firestore query answers DALgo-JS's single leaf scan. */
  | { readonly kind: "pushed"; readonly filters: readonly QueryFilter<Data>[]; readonly orders: readonly QueryOrder<Data>[]; readonly limit: number }
  /** One `getDoc` of the document `id` answers the single leaf scan. */
  | { readonly kind: "key"; readonly id: string }
  /** No document can match: the leaf scan is answered with no read. */
  | { readonly kind: "empty" }
  /** Bounded collection scans evaluated by DALgo-JS (`allowInMemoryEvaluation` only). */
  | { readonly kind: "in-memory" }
  | { readonly kind: "refused"; readonly code: FirestoreTugQLRefusalCode; readonly path: string; readonly reason: string };

/**
 * The error of a refused TugQL query, thrown before any Firestore read. Its
 * message has the `<code> at <path>: <reason>` form of DALgo-JS's executor
 * errors (for example `query_limit at root.from: fetched_rows`).
 */
export class FirestoreTugQLRefusedError extends Error {
  public readonly code: FirestoreTugQLRefusalCode;
  /** The zero-based path of the first offending node, for example `where.and[1]`. */
  public readonly path: string;
  /** The condition of REQ:pushable-shape that failed, for example `OR`. */
  public readonly reason: string;

  public constructor(code: FirestoreTugQLRefusalCode, path: string, reason: string) {
    super(`${code} at ${path}: ${reason}`);
    this.name = "FirestoreTugQLRefusedError";
    this.code = code;
    this.path = path;
    this.reason = reason;
  }
}

type Refusal = Extract<FirestoreTugQLPlan, { kind: "refused" }>;

const refuse = (path: string, reason: string, code: FirestoreTugQLRefusalCode = "in_memory_evaluation"): Refusal =>
  ({ kind: "refused", code, path, reason });

/**
 * Plans a resolved TugQL query whose parameters are already bound (every
 * `@name` is a literal). A pure function of the query and the options.
 */
export function planFirestoreTugQL(query: RecursiveTugQLQuery, options: FirestoreTugQLPlanOptions = {}): FirestoreTugQLPlan {
  const maxFetchedRows = options.maxFetchedRows ?? DEFAULT_MAX_FETCHED_ROWS;
  if (query.limit !== undefined && query.limit + (query.offset ?? 0) > maxFetchedRows) {
    return refuse("limit", `LIMIT plus OFFSET exceeds maxFetchedRows (${maxFetchedRows.toString()})`, "query_limit");
  }
  const keyed = tableRelations(query).length === 1 ? keyEquality(query) : notKeyed;
  if (keyed !== notKeyed) return validDocumentId(keyed) ? { kind: "key", id: keyed } : { kind: "empty" };

  const pushed = pushedPlan(query, maxFetchedRows);
  if (pushed.kind !== "refused" || options.allowInMemoryEvaluation !== true) return pushed;
  return { kind: "in-memory" };
}

/** Collects every table relation of the query tree, nested queries included. */
export function tableRelations(query: RecursiveTugQLQuery): RecursiveTugQLRelation[] {
  const found: RecursiveTugQLRelation[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const node = value as Record<string, unknown>;
    if (node.kind === "table" && Array.isArray(node.joins)) found.push(node as unknown as RecursiveTugQLRelation);
    for (const child of Object.values(node)) visit(child);
  };
  visit(query);
  return found;
}

const notKeyed = Symbol("not-keyed");

/** Recognizes a WHERE whose only condition is `__key__ = <literal>` and returns the literal. */
function keyEquality(query: RecursiveTugQLQuery): unknown {
  // Only a direct collection scan can be answered by one document read; a
  // derived FROM (or a join) filters rows the inner query produced.
  if (query.from.kind !== "table" || query.from.joins.length > 0) return notKeyed;
  const where = query.where;
  if (where?.kind !== "comparison" || where.operator !== "==") return notKeyed;
  const names = new Set(["", query.from.alias, query.from.name]);
  const isKey = (side: RecursiveTugQLExpression): boolean => side.kind === "field"
    && side.field.field === TUGQL_KEY_FIELD && names.has(side.field.source);
  return isKey(where.left) && where.right.kind === "literal" ? where.right.value
    : isKey(where.right) && where.left.kind === "literal" ? where.left.value
      : notKeyed;
}

/** The adapter's document-id validation: a value that can name a Firestore document. */
export function validDocumentId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value !== "." && value !== ".."
    && !value.includes("/") && !/^__.*__$/u.test(value);
}

function pushedPlan(query: RecursiveTugQLQuery, maxFetchedRows: number): FirestoreTugQLPlan {
  const relation = query.from;
  if (relation.kind !== "table") return refuse("from", "derived source");
  if (relation.joins.length > 0) return refuse("from.joins[0]", "JOIN");
  if ("scan" in relation && relation.scan !== undefined) return refuse("from", "relation scan limit");

  const where: WhereFilters | Refusal = query.where === undefined ? { filters: [], empty: false } : whereFilters(query.where);
  if ("kind" in where) return where;
  if (query.groupBy !== undefined) return refuse("groupBy", "GROUP BY");
  if (query.having !== undefined) return refuse("having", "HAVING");

  const orders: QueryOrder<Data>[] = [];
  for (const [index, order] of (query.orderBy ?? []).entries()) {
    const field = firestoreField(order.field.field);
    if (field === undefined) return refuse(`orderBy[${index.toString()}]`, `field name "${order.field.field}" is not a plain Firestore field`);
    orders.push({ field, direction: order.direction });
  }
  for (const [index, column] of (query.columns ?? []).entries()) {
    const problem = columnProblem(column);
    if (problem !== undefined) return refuse(`columns[${index.toString()}]`, problem);
  }

  if (where.empty) return { kind: "empty" };
  return {
    kind: "pushed",
    filters: where.filters,
    orders: withInequalityOrders(orders, where.filters),
    limit: query.limit === undefined ? maxFetchedRows + 1 : query.limit + (query.offset ?? 0),
  };
}

function columnProblem(column: RecursiveTugQLColumn): string | undefined {
  const visit = (expression: RecursiveTugQLExpression): string | undefined => {
    if (expression.kind === "query") return "subquery";
    if (expression.kind === "aggregate") return "aggregate";
    if (expression.kind === "binary") return visit(expression.left) ?? visit(expression.right);
    return undefined;
  };
  return visit(column.expression);
}

/**
 * Firestore orders a query with inequality filters by those fields (after the
 * explicit orders, before the document id). compileFirestoreQuery appends an
 * explicit document-id order, which would otherwise come first and demand a
 * composite index, so the inequality fields are listed explicitly, exactly
 * where Firestore itself would put them.
 */
function withInequalityOrders(orders: readonly QueryOrder<Data>[], filters: readonly QueryFilter<Data>[]): QueryOrder<Data>[] {
  const ordered = new Set(orders.map(({ field }) => field));
  const direction = orders.at(-1)?.direction ?? "asc";
  const inequalities = filters
    .filter(({ field, operator }) => field !== DOCUMENT_ID && !["==", "in"].includes(operator))
    .map(({ field }) => field)
    .filter((field) => !ordered.has(field));
  return [...orders, ...[...new Set(inequalities)].sort().map((field) => ({ field, direction }))];
}

interface WhereFilters {
  readonly filters: QueryFilter<Data>[];
  /** True when a conjunct can match no document (an empty `in` list, a key that names no document). */
  readonly empty: boolean;
}

interface Conjunct {
  readonly condition: RecursiveTugQLCondition;
  readonly path: string;
}

function flatten(condition: RecursiveTugQLCondition, path: string, into: Conjunct[]): void {
  if (condition.kind === "and") {
    for (const [index, child] of condition.conditions.entries()) flatten(child, `${path}.and[${index.toString()}]`, into);
  } else {
    into.push({ condition, path });
  }
}

const SCALAR_OPERATORS: ReadonlySet<QueryOperator> = new Set(["==", "!=", "<", "<=", ">", ">="]);
const FLIPPED: Readonly<Record<QueryOperator, QueryOperator>> = {
  "==": "==", "!=": "!=", "<": ">", "<=": ">=", ">": "<", ">=": "<=",
  in: "in", "not-in": "not-in", "array-contains": "array-contains", "array-contains-any": "array-contains-any",
};

function whereFilters(where: RecursiveTugQLCondition): WhereFilters | Refusal {
  const conjuncts: Conjunct[] = [];
  flatten(where, "where", conjuncts);
  const filters: QueryFilter<Data>[] = [];
  let empty = false;
  let disjunctions = 1;
  let inCount = 0;
  let notEqualCount = 0;
  let notInCount = 0;
  for (const { condition, path } of conjuncts) {
    const filter = conjunctFilter(condition);
    if ("reason" in filter) return refuse(path, filter.reason);
    if (filter.kind === "empty") { empty = true; continue; }
    if (filter.kind === "none") continue;
    const { operator, value } = filter.filter;
    if ((operator === "not-in" && inCount + notEqualCount > 0) || ((operator === "in" || operator === "!=") && notInCount > 0)) {
      return refuse(path, "`not-in` combined with `in` or `!=`");
    }
    if ((operator === "!=" || operator === "not-in") && notEqualCount + notInCount > 0) return refuse(path, "more than one `!=` or `not-in`");
    if (operator === "in") {
      disjunctions *= (value as readonly unknown[]).length;
      if (disjunctions > MAX_DISJUNCTIONS) return refuse(path, `\`in\` disjunctions exceed ${MAX_DISJUNCTIONS.toString()}`);
      inCount += 1;
    }
    if (operator === "not-in") {
      if ((value as readonly unknown[]).length > MAX_NOT_IN_VALUES) return refuse(path, `\`not-in\` list exceeds ${MAX_NOT_IN_VALUES.toString()} values`);
      notInCount += 1;
    }
    if (operator === "!=") notEqualCount += 1;
    filters.push(filter.filter);
  }
  return { filters, empty };
}

type ConjunctFilter =
  | { readonly kind: "filter"; readonly filter: QueryFilter<Data> }
  /** The conjunct matches no document. */
  | { readonly kind: "empty" }
  /** The conjunct holds for every document Firestore can return. */
  | { readonly kind: "none" }
  | { readonly reason: string };

const NOT_COMPARISON: Readonly<Record<Exclude<RecursiveTugQLCondition["kind"], "comparison">, string>> = {
  and: "AND", or: "OR", "is-null": "IS NULL", "is-not-null": "IS NOT NULL", exists: "EXISTS subquery", "not-exists": "NOT EXISTS subquery",
};

function conjunctFilter(condition: RecursiveTugQLCondition): ConjunctFilter {
  if (condition.kind !== "comparison") return { reason: NOT_COMPARISON[condition.kind] };
  const { left, right } = condition;
  if (!SCALAR_OPERATORS.has(condition.operator) && condition.operator !== "in" && condition.operator !== "not-in") {
    return { reason: `operator ${condition.operator}` };
  }
  if (left.kind === "query" || right.kind === "query") return { reason: "subquery" };
  if (left.kind === "field" && right.kind === "field") return { reason: "field compared with field" };
  const field = left.kind === "field" ? left : right.kind === "field" ? right : undefined;
  if (field === undefined) return { reason: "no field operand" };
  const operand = field === left ? right : left;
  if (field === right && !SCALAR_OPERATORS.has(condition.operator)) return { reason: `field on the right of ${condition.operator}` };
  const operator = field === left ? condition.operator : FLIPPED[condition.operator];
  if (operand.kind === "param") return { reason: `unbound parameter @${operand.name}` };
  if (operand.kind !== "literal" && operand.kind !== "values") return { reason: `${operand.kind} expression` };
  const value: unknown = operand.kind === "literal" ? operand.value : operand.values;

  const name = firestoreField(field.field.field);
  const isKey = name === DOCUMENT_ID;
  if (name === undefined) return { reason: `field name "${field.field.field}" is not a plain Firestore field` };

  if (operator === "in" || operator === "not-in") {
    if (!Array.isArray(value)) return { reason: `${operator} needs a list` };
    const values = value as readonly unknown[];
    for (const item of values) {
      const problem = valueProblem(item);
      if (problem !== undefined) return { reason: problem };
    }
    // A value that names no document can neither match nor exclude a document.
    const kept = isKey ? values.filter(validDocumentId) : values;
    if (kept.length === 0) return operator === "in" ? { kind: "empty" } : { kind: "none" };
    return { kind: "filter", filter: { field: name, operator, value: kept } };
  }
  const problem = valueProblem(value);
  if (problem !== undefined) return { reason: problem };
  if (isKey && !validDocumentId(value)) {
    if (operator === "==") return { kind: "empty" };
    if (operator === "!=") return { kind: "none" };
    return { reason: "`__key__` compared with a value that is not a document id" };
  }
  return { kind: "filter", filter: { field: name, operator, value } };
}

function valueProblem(value: unknown): string | undefined {
  if (value === null || value === undefined) return "comparison with NULL";
  if (typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return undefined;
  return "value is not a string, finite number or boolean";
}

/**
 * The Firestore field path of a TugQL field: the name itself when Firestore
 * reads it as that one top-level field. A dotted or special name would be
 * read by Firestore as another (nested or reserved) field, so it is refused.
 */
function firestoreField(name: string): string | undefined {
  if (name === TUGQL_KEY_FIELD) return DOCUMENT_ID;
  if (name === "" || /[.~*/[\]`]/u.test(name) || /^__.*__$/u.test(name)) return undefined;
  return name;
}
