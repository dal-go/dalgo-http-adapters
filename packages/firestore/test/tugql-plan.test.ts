// Unit tests of the pure pushdown planner (spec firestore-tugql-pushdown,
// plan Task 1). No Firestore instance is involved.
import {
  DOCUMENT_ID,
  parseRecursiveTugQL,
  parseTugQL,
  resolveTugQL,
  type RecursiveTugQLCondition,
  type RecursiveTugQLQuery,
  type TugQLResolveContext,
} from "@dalgo/core";
import { Timestamp } from "firebase/firestore";
import { describe, expect, it } from "vitest";
import {
  FirestoreTugQLRefusedError,
  planFirestoreTugQL,
  tableRelations,
  validDocumentId,
  type FirestoreTugQLPlan,
  type FirestoreTugQLPlanOptions,
} from "../src/tugql-plan.js";

function resolve(text: string, bindings: TugQLResolveContext["bindings"] = []): RecursiveTugQLQuery {
  const parsed = parseTugQL(text);
  expect(parsed.diagnostics).toEqual([]);
  const result = resolveTugQL(parsed.document, {
    authorizedSchemas: [],
    relationships: [],
    pinnedImports: [],
    schemaless: true,
    bindings,
    contextVariables: { SneatUserID: "u1", SneatUserPersonalSpaceID: "s1" },
  });
  expect(result.diagnostics).toEqual([]);
  if (result.resolved === undefined) throw new Error("not resolved");
  return result.resolved.query;
}

const plan = (text: string, options?: FirestoreTugQLPlanOptions): FirestoreTugQLPlan => planFirestoreTugQL(resolve(text), options);

/** A single-collection query over `items` with the given WHERE, as the binder leaves it. */
function itemsWhere(where: RecursiveTugQLCondition, extra: Partial<RecursiveTugQLQuery> = {}): RecursiveTugQLQuery {
  return { kind: "recursive-tugql", from: { kind: "table", name: "items", joins: [] }, where, ...extra };
}

const field = (name: string) => ({ kind: "field" as const, field: { field: name, source: "" } });
/** A parameter after binding: DALgo-JS substitutes `@name` with `{ value }`, a literal. */
const bound = (value: unknown) => ({ kind: "literal" as const, value: value as string });
const compare = (name: string, operator: "==" | "!=" | "<" | ">=" | "in" | "not-in", value: unknown): RecursiveTugQLCondition =>
  ({ kind: "comparison", left: field(name), operator, right: bound(value) });

const refused = (path: string, reason: string, code = "in_memory_evaluation") => ({ kind: "refused", code, path, reason });
const values = (count: number, prefix = "v"): string[] => Array.from({ length: count }, (_, index) => `${prefix}${index.toString()}`);

describe("planFirestoreTugQL: pushed queries (req:pushable-shape, req:one-firestore-query)", () => {
  it("pushes an equality filter with the fetched-row budget plus one as limit", () => {
    expect(plan("from items\nwhere status = 'active'\n")).toEqual({
      kind: "pushed",
      filters: [{ field: "status", operator: "==", value: "active" }],
      orders: [],
      limit: 10_001,
    });
    expect(plan("from items\nwhere status = 'active'\n", { maxFetchedRows: 50 })).toMatchObject({ kind: "pushed", limit: 51 });
  });

  it("pushes an unfiltered collection read", () => {
    expect(plan("from spaces/s1/ext/datatug/projects/p1/queries\n")).toEqual({ kind: "pushed", filters: [], orders: [], limit: 10_001 });
  });

  it("flips a comparison whose field is on the right and lists the inequality field as an order", () => {
    expect(plan("from items\nwhere 'x' = a and 2 < b and 3 >= c and d != 4\n")).toEqual({
      kind: "pushed",
      filters: [
        { field: "a", operator: "==", value: "x" },
        { field: "b", operator: ">", value: 2 },
        { field: "c", operator: "<=", value: 3 },
        { field: "d", operator: "!=", value: 4 },
      ],
      orders: [{ field: "b", direction: "asc" }, { field: "c", direction: "asc" }, { field: "d", direction: "asc" }],
      limit: 10_001,
    });
  });

  it("orders, then limits to LIMIT plus OFFSET (ac:order-limit-offset)", () => {
    expect(plan("from items\norder by title asc\nlimit 5\noffset 10\n")).toEqual({
      kind: "pushed", filters: [], orders: [{ field: "title", direction: "asc" }], limit: 15,
    });
    expect(plan("from items\nlimit 5\n")).toMatchObject({ limit: 5 });
  });

  it("puts inequality fields after the explicit orders, in the last explicit direction", () => {
    expect(plan("from items\nwhere rank > 3 and a <= 2 and rank < 9\norder by title desc\n")).toMatchObject({
      orders: [{ field: "title", direction: "desc" }, { field: "a", direction: "desc" }, { field: "rank", direction: "desc" }],
    });
    expect(plan("from items\nwhere rank > 3\norder by rank asc\n")).toMatchObject({ orders: [{ field: "rank", direction: "asc" }] });
  });

  it("compiles __key__ to the document id, without an inequality order of its own", () => {
    expect(plan("from items\nwhere __key__ > 'a'\norder by __key__ desc\n")).toEqual({
      kind: "pushed",
      filters: [{ field: DOCUMENT_ID, operator: ">", value: "a" }],
      orders: [{ field: DOCUMENT_ID, direction: "desc" }],
      limit: 10_001,
    });
  });

  it("pushes `in` and `not-in` lists of a bound parameter (ac:bound-parameter-and-in-list)", () => {
    expect(planFirestoreTugQL(itemsWhere(compare("status", "in", ["active", "paused"])))).toMatchObject({
      kind: "pushed", filters: [{ field: "status", operator: "in", value: ["active", "paused"] }],
    });
    const list = { kind: "comparison", left: field("rank"), operator: "not-in", right: { kind: "values", values: [1, 2] } } as const;
    expect(planFirestoreTugQL(itemsWhere(list))).toMatchObject({
      filters: [{ field: "rank", operator: "not-in", value: [1, 2] }], orders: [{ field: "rank", direction: "asc" }],
    });
  });

  it("keeps the disjunction product at 30 and a `not-in` list at 10 values", () => {
    const and = (...conditions: RecursiveTugQLCondition[]): RecursiveTugQLCondition => ({ kind: "and", conditions });
    expect(planFirestoreTugQL(itemsWhere(and(compare("a", "in", values(5)), compare("b", "in", values(6)))))).toMatchObject({ kind: "pushed" });
    expect(planFirestoreTugQL(itemsWhere(compare("a", "in", values(30))))).toMatchObject({ kind: "pushed" });
    expect(planFirestoreTugQL(itemsWhere(compare("a", "not-in", values(10))))).toMatchObject({ kind: "pushed" });
  });

  it("checks the plan after parameters are bound", () => {
    const query = resolve("parameters (\n  @s string required\n)\nfrom items\nwhere status = @s\n", [{ name: "s", set: true, value: "active" }]);
    expect(planFirestoreTugQL(query)).toMatchObject({ filters: [{ field: "status", operator: "==", value: "active" }] });
  });

  it("projects SELECT columns that are fields or arithmetic", () => {
    const literal = { kind: "literal" as const, value: 2 };
    const projected = itemsWhere(compare("status", "==", "active"), {
      columns: [{ expression: field("title") }, { expression: { kind: "binary", operator: "*", left: field("rank"), right: literal }, as: "twice" }],
    });
    expect(planFirestoreTugQL(projected)).toMatchObject({ kind: "pushed" });
  });
});

describe("planFirestoreTugQL: empty results (ac:non-primitive-and-empty-values)", () => {
  it("answers an empty `in` list with no read, and drops an empty `not-in` list", () => {
    expect(planFirestoreTugQL(itemsWhere(compare("status", "in", [])))).toEqual({ kind: "empty" });
    expect(planFirestoreTugQL(itemsWhere(compare("status", "not-in", [])))).toEqual({ kind: "pushed", filters: [], orders: [], limit: 10_001 });
  });

  it("answers __key__ values that name no document without a Firestore filter", () => {
    expect(plan("from items\nwhere __key__ = 'a/b' and status = 'x'\n")).toEqual({ kind: "empty" });
    expect(plan("from items\nwhere __key__ != '' and status = 'x'\n")).toMatchObject({ filters: [{ field: "status" }] });
    expect(planFirestoreTugQL(itemsWhere(compare("__key__", "in", ["a/b", "ok", "__x__"])))).toMatchObject({
      filters: [{ field: DOCUMENT_ID, operator: "in", value: ["ok"] }],
    });
    expect(planFirestoreTugQL(itemsWhere(compare("__key__", "in", ["a/b", ".."])))).toEqual({ kind: "empty" });
    expect(planFirestoreTugQL(itemsWhere(compare("__key__", "not-in", ["a/b", "."])))).toMatchObject({ kind: "pushed", filters: [] });
    expect(planFirestoreTugQL(itemsWhere(compare("__key__", "not-in", ["a/b", "ok"])))).toMatchObject({
      filters: [{ field: DOCUMENT_ID, operator: "not-in", value: ["ok"] }],
    });
  });
});

describe("planFirestoreTugQL: key-equality read (req:key-equality-read-kept)", () => {
  it("reads one document for a lone __key__ equality, on either side", () => {
    expect(plan("from users\nwhere __key__ = @SneatUserID\n")).toEqual({ kind: "key", id: "u1" });
    expect(plan("from users as u\nwhere 'u2' = u.__key__\n")).toEqual({ kind: "key", id: "u2" });
    expect(plan("from users\nwhere __key__ = 'u1'\ngroup by name\nselect name\n")).toEqual({ kind: "key", id: "u1" });
  });

  it("answers a key that cannot name a document with no read", () => {
    for (const id of ["a/b", "", "..", "__x__"]) expect(plan(`from users\nwhere __key__ = '${id}'\n`)).toEqual({ kind: "empty" });
    expect(plan("from users\nwhere __key__ = null\n")).toEqual({ kind: "empty" });
  });

  it("is not a key read with another condition, a join or a derived FROM", () => {
    expect(plan("from users\nwhere __key__ = 'u1' and name = 'Alex'\n")).toMatchObject({ kind: "pushed" });
    expect(plan("from users\nwhere __key__ = name\n")).toMatchObject({ kind: "refused" });
    const schema = { tables: [{ name: "users", fields: ["name", "__key__"] }] };
    const derived = parseRecursiveTugQL({
      from: { query: { as: "x", from: { name: "users" } } },
      where: { left: { field: "__key__" }, op: "==", right: { value: "u2" } },
    }, schema);
    expect(planFirestoreTugQL(derived)).toEqual(refused("from", "derived source"));
  });
});

describe("planFirestoreTugQL: refusals (ac:unpushable-refused-before-read, ac:non-primitive-and-empty-values)", () => {
  it("refuses OR, field-to-field and NULL comparisons at where", () => {
    expect(plan("from items\nwhere a = 1 or b = 2\n")).toEqual(refused("where", "OR"));
    expect(plan("from items\nwhere a = b\n")).toEqual(refused("where", "field compared with field"));
    expect(plan("from items\nwhere a = null\n")).toEqual(refused("where", "comparison with NULL"));
  });

  it("names the first offending conjunct", () => {
    expect(plan("from items\nwhere a = 1 and (b = 1 or c = 2) and d = e\n")).toEqual(refused("where.and[1]", "OR"));
    expect(plan("from items\nwhere a = 1 and b is null\n")).toEqual(refused("where.and[1]", "IS NULL"));
    expect(plan("from items\nwhere a is not null\n")).toEqual(refused("where", "IS NOT NULL"));
  });

  it("refuses a parameter bound to null", () => {
    const query = resolve("parameters (\n  @s string default 'x'\n)\nfrom items\nwhere status = @s\n", [{ name: "s", set: true, value: null }]);
    expect(planFirestoreTugQL(query)).toEqual(refused("where", "comparison with NULL"));
    expect(planFirestoreTugQL(itemsWhere(compare("status", "in", ["a", null])))).toEqual(refused("where", "comparison with NULL"));
  });

  it("refuses a Timestamp, a map, an array, NaN or an infinite value", () => {
    const reason = "value is not a string, finite number or boolean";
    for (const value of [Timestamp.fromMillis(0), { a: 1 }, ["a"], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planFirestoreTugQL(itemsWhere(compare("at", "==", value)))).toEqual(refused("where", reason));
    }
    expect(planFirestoreTugQL(itemsWhere(compare("at", "in", ["a", { a: 1 }])))).toEqual(refused("where", reason));
    expect(planFirestoreTugQL(itemsWhere(compare("at", "in", "a")))).toEqual(refused("where", "in needs a list"));
  });

  it("refuses more than 30 disjunctions (ac:bound-parameter-and-in-list)", () => {
    expect(planFirestoreTugQL(itemsWhere(compare("status", "in", values(31))))).toEqual(refused("where", "`in` disjunctions exceed 30"));
    const twoLists: RecursiveTugQLCondition = { kind: "and", conditions: [compare("a", "in", values(6)), compare("b", "in", values(6))] };
    expect(planFirestoreTugQL(itemsWhere(twoLists))).toEqual(refused("where.and[1]", "`in` disjunctions exceed 30"));
  });

  it("refuses Firestore's `!=` and `not-in` combinations", () => {
    const and = (...conditions: RecursiveTugQLCondition[]) => itemsWhere({ kind: "and", conditions });
    expect(planFirestoreTugQL(itemsWhere(compare("a", "not-in", values(11))))).toEqual(refused("where", "`not-in` list exceeds 10 values"));
    expect(planFirestoreTugQL(and(compare("a", "!=", 1), compare("b", "!=", 2)))).toEqual(refused("where.and[1]", "more than one `!=` or `not-in`"));
    expect(planFirestoreTugQL(and(compare("a", "not-in", [1]), compare("b", "not-in", [2])))).toEqual(refused("where.and[1]", "more than one `!=` or `not-in`"));
    const combined = "`not-in` combined with `in` or `!=`";
    expect(planFirestoreTugQL(and(compare("a", "!=", 1), compare("b", "not-in", [2])))).toEqual(refused("where.and[1]", combined));
    expect(planFirestoreTugQL(and(compare("a", "in", [1]), compare("b", "not-in", [2])))).toEqual(refused("where.and[1]", combined));
    expect(planFirestoreTugQL(and(compare("a", "not-in", [1]), compare("b", "in", [2])))).toEqual(refused("where.and[1]", combined));
    expect(planFirestoreTugQL(and(compare("a", "not-in", [1]), compare("b", "!=", 2)))).toEqual(refused("where.and[1]", combined));
  });

  it("refuses a JOIN, GROUP BY, HAVING, aggregates and subqueries at their nodes", () => {
    expect(plan("from items as i\njoin other as o\n  on o.x = i.y\nselect i.a\n")).toEqual(refused("from.joins[0]", "JOIN"));
    expect(plan("from items\ngroup by a\nselect a, count(*) as n\n")).toEqual(refused("groupBy", "GROUP BY"));
    expect(plan("from items\nselect count(*) as n\n")).toEqual(refused("columns[0]", "aggregate"));
    expect(plan("from items\nselect a, count(*) + 1 as n\n")).toEqual(refused("columns[1]", "aggregate"));
    const having: RecursiveTugQLQuery = { kind: "recursive-tugql", from: { kind: "table", name: "items", joins: [] }, having: compare("a", "==", 1) };
    expect(planFirestoreTugQL(having)).toEqual(refused("having", "HAVING"));

    const schema = { tables: [{ name: "items", fields: ["a"] }, { name: "other", fields: ["a"] }] };
    const scalar = parseRecursiveTugQL({
      from: { name: "items" },
      columns: [{ query: { as: "n", from: { name: "other" }, columns: [{ aggregate: { function: "count", args: [{ star: true }] }, as: "c" }] } }],
    }, schema);
    expect(planFirestoreTugQL(scalar)).toEqual(refused("columns[0]", "subquery"));
    const exists = parseRecursiveTugQL({ from: { name: "items" }, where: { exists: { query: { from: { name: "other" } } } } }, schema);
    expect(planFirestoreTugQL(exists)).toEqual(refused("where", "EXISTS subquery"));
    const notExists = parseRecursiveTugQL({ from: { name: "items" }, where: { notExists: { query: { from: { name: "other" } } } } }, schema);
    expect(planFirestoreTugQL(notExists)).toEqual(refused("where", "NOT EXISTS subquery"));
    const inQuery = parseRecursiveTugQL({ from: { name: "items" }, where: { left: { field: "a" }, op: "In", right: { query: { from: { name: "other" }, columns: [{ field: "a" }] } } } }, schema);
    expect(planFirestoreTugQL(inQuery)).toEqual(refused("where", "subquery"));
  });

  it("refuses a relation scan limit", () => {
    const scanned = { kind: "recursive-tugql", from: { kind: "table", name: "items", joins: [], scan: { orderBy: [], limit: 5 } } } as unknown as RecursiveTugQLQuery;
    expect(planFirestoreTugQL(scanned)).toEqual(refused("from", "relation scan limit"));
  });

  it("refuses comparisons Firestore cannot carry", () => {
    const literal = (value: number) => ({ kind: "literal" as const, value });
    expect(planFirestoreTugQL(itemsWhere({ kind: "comparison", left: literal(1), operator: "==", right: literal(1) }))).toEqual(refused("where", "no field operand"));
    expect(planFirestoreTugQL(itemsWhere({ kind: "comparison", left: field("tags"), operator: "array-contains", right: literal(1) }))).toEqual(refused("where", "operator array-contains"));
    expect(planFirestoreTugQL(itemsWhere({ kind: "comparison", left: literal(1), operator: "in", right: field("tags") }))).toEqual(refused("where", "field on the right of in"));
    expect(planFirestoreTugQL(itemsWhere({ kind: "comparison", left: field("a"), operator: "==", right: { kind: "param", name: "p" } }))).toEqual(refused("where", "unbound parameter @p"));
    expect(plan("from items\nwhere a = 1 + 2\n")).toEqual(refused("where", "binary expression"));
  });

  it("refuses a field name Firestore would read as another field", () => {
    expect(plan("from items\nwhere `a.b` = 1\n")).toEqual(refused("where", 'field name "a.b" is not a plain Firestore field'));
    expect(planFirestoreTugQL(itemsWhere(compare("__name__", "==", "x")))).toEqual(refused("where", 'field name "__name__" is not a plain Firestore field'));
    expect(plan("from items\norder by a asc, `b.c` desc\n")).toEqual(refused("orderBy[1]", 'field name "b.c" is not a plain Firestore field'));
  });

  it("refuses a __key__ range bound that is not a document id", () => {
    expect(plan("from items\nwhere __key__ > 'a/b'\n")).toEqual(refused("where", "`__key__` compared with a value that is not a document id"));
  });

  it("refuses LIMIT plus OFFSET over the fetched-row budget with query_limit, opt-in or not", () => {
    const reason = "LIMIT plus OFFSET exceeds maxFetchedRows (10000)";
    expect(plan("from items\norder by title asc\nlimit 9995\noffset 10\n")).toEqual(refused("limit", reason, "query_limit"));
    expect(plan("from items\nwhere a = 1 or b = 2\nlimit 9995\noffset 10\n", { allowInMemoryEvaluation: true })).toEqual(refused("limit", reason, "query_limit"));
    expect(plan("from items\nlimit 9990\noffset 10\n")).toMatchObject({ kind: "pushed", limit: 10_000 });
    expect(plan("from items\nlimit 11\n", { maxFetchedRows: 10 })).toEqual(refused("limit", "LIMIT plus OFFSET exceeds maxFetchedRows (10)", "query_limit"));
  });
});

describe("planFirestoreTugQL: opt-in (req:refuse-unless-allowed)", () => {
  it("evaluates an unpushable query in memory only with allowInMemoryEvaluation", () => {
    expect(plan("from items\nwhere a = 1 or b = 2\n", { allowInMemoryEvaluation: true })).toEqual({ kind: "in-memory" });
    expect(plan("from items\nwhere a = 1 or b = 2\n", { allowInMemoryEvaluation: false })).toMatchObject({ kind: "refused" });
  });

  it("still pushes a pushable query with the opt-in", () => {
    expect(plan("from items\nwhere status = 'active'\n", { allowInMemoryEvaluation: true })).toMatchObject({ kind: "pushed" });
  });
});

describe("planner helpers", () => {
  it("collects nested table relations", () => {
    expect(tableRelations(resolve("from items as i\njoin other as o\n  on o.x = i.y\nselect i.a\n")).map(({ name }) => name)).toEqual(["items", "other"]);
  });

  it("validates document ids", () => {
    expect(validDocumentId("u1")).toBe(true);
    for (const id of ["", ".", "..", "a/b", "__x__", 1, null]) expect(validDocumentId(id)).toBe(false);
  });

  it("carries code, path and reason on the refusal error", () => {
    const error = new FirestoreTugQLRefusedError("in_memory_evaluation", "where.and[1]", "OR");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "FirestoreTugQLRefusedError", code: "in_memory_evaluation", path: "where.and[1]", reason: "OR" });
    expect(error.message).toBe("in_memory_evaluation at where.and[1]: OR");
  });
});
