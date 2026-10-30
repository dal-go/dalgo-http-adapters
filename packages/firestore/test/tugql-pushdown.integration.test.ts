// Emulator acceptance tests of the Firestore TugQL pushdown (spec
// firestore-tugql-pushdown, plan Task 2). Reads go through a counting read
// seam (REQ:read-seam) over the Web SDK's own getDocs/getDoc.
import { parseRecursiveTugQL, parseTugQL, resolveTugQL, type RecursiveTugQLQuery, type TugQLResolveContext } from "@dalgo/core";
import {
  collection,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  queryEqual,
  where,
  type DocumentReference,
  type Query,
} from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runFirestoreTugQL, type FirestoreTugQLReader } from "../src/tugql.js";
import { emulatorDatabase } from "./fixtures/emulator.js";
import goldenText from "./fixtures/opt-in-or.golden.json?raw";
import { items, itemsOneUntitled, myData, myDataContext, myDataQueries, type Documents } from "./fixtures/items.js";

const db = emulatorDatabase("tugql-pushdown");
const { firestore } = db;

interface Reads {
  readonly queries: Query[];
  readonly documents: DocumentReference[];
  /** Documents returned by every getDocs and getDoc: the billed reads. */
  documentsRead: number;
}

let reads: Reads;

/** The counting read seam: the Web SDK's own reads, recorded. */
function countingReader(): FirestoreTugQLReader {
  return {
    async getDocs(firestoreQuery) {
      reads.queries.push(firestoreQuery);
      const snapshot = await getDocs(firestoreQuery);
      reads.documentsRead += snapshot.size;
      return snapshot;
    },
    async getDoc(reference) {
      reads.documents.push(reference);
      const snapshot = await getDoc(reference);
      reads.documentsRead += snapshot.exists() ? 1 : 0;
      return snapshot;
    },
  };
}

function resolve(text: string, bindings: TugQLResolveContext["bindings"] = []): RecursiveTugQLQuery {
  const parsed = parseTugQL(text);
  expect(parsed.diagnostics).toEqual([]);
  const result = resolveTugQL(parsed.document, {
    authorizedSchemas: [], relationships: [], pinnedImports: [], schemaless: true, bindings, contextVariables: myDataContext,
  });
  expect(result.diagnostics).toEqual([]);
  if (result.resolved === undefined) throw new Error("not resolved");
  return result.resolved.query;
}

const run = (resolved: RecursiveTugQLQuery, allowInMemoryEvaluation?: boolean) => runFirestoreTugQL(firestore, resolved, {
  reader: countingReader(),
  ...(allowInMemoryEvaluation === undefined ? {} : { allowInMemoryEvaluation }),
});

/** `from items where status in @states`, with `@states` bound (DALgo-JS substitutes `{ value }`). */
function statusIn(states: readonly string[]): RecursiveTugQLQuery {
  const schema = { tables: [{ name: "items", fields: ["status", "title", "a", "b", "rank"] }] };
  return parseRecursiveTugQL({ from: { name: "items" }, where: { left: { field: "status" }, op: "In", right: { value: states } } }, schema);
}

const expectQuery = (actual: Query | undefined, expected: Query): void => {
  expect(actual !== undefined && queryEqual(actual, expected)).toBe(true);
};

async function seed(documents: Documents): Promise<void> {
  await db.reset(documents);
}

beforeAll(async () => { await seed(items); });
beforeEach(() => { reads = { queries: [], documents: [], documentsRead: 0 }; });
afterAll(async () => { await db.close(); });

describe("pushed queries over 50 items", () => {
  it("reads only the 3 matching documents (ac:equality-filter-reads-only-matches)", async () => {
    const result = await run(resolve("from items\nwhere status = 'active'\n"));
    expect(reads.queries).toHaveLength(1);
    expect(reads.documents).toHaveLength(0);
    expectQuery(reads.queries[0], query(collection(firestore, "items"), where("status", "==", "active"), orderBy(documentId()), limit(10_001)));
    expect(reads.documentsRead).toBe(3);
    expect(result.rows.map((row) => row.__key__)).toEqual(["item-07", "item-23", "item-41"]);
  });

  it("pushes a bound `in` list and refuses 31 values before any read (ac:bound-parameter-and-in-list)", async () => {
    const result = await run(statusIn(["active", "paused"]));
    expect(reads.queries).toHaveLength(1);
    expectQuery(reads.queries[0], query(collection(firestore, "items"), where("status", "in", ["active", "paused"]), orderBy(documentId()), limit(10_001)));
    expect(reads.documentsRead).toBe(7);
    expect(result.rows).toHaveLength(7);

    reads = { queries: [], documents: [], documentsRead: 0 };
    const many = Array.from({ length: 31 }, (_, index) => `s${index.toString()}`);
    await expect(run(statusIn(many))).rejects.toMatchObject({ code: "in_memory_evaluation", path: "where" });
    expect(reads.queries).toHaveLength(0);
    expect(reads.documentsRead).toBe(0);
  });

  it("answers an empty bound `in` list with no read (ac:non-primitive-and-empty-values)", async () => {
    const result = await run(statusIn([]));
    expect(result.rows).toEqual([]);
    expect(reads.queries).toHaveLength(0);
    expect(reads.documentsRead).toBe(0);
  });

  it("orders, limits to LIMIT plus OFFSET and skips OFFSET in DALgo-JS (ac:order-limit-offset)", async () => {
    const result = await run(resolve("from items\norder by title asc\nlimit 5\noffset 10\n"));
    expect(reads.queries).toHaveLength(1);
    expectQuery(reads.queries[0], query(collection(firestore, "items"), orderBy("title", "asc"), orderBy(documentId(), "asc"), limit(15)));
    expect(reads.documentsRead).toBe(15);
    expect(result.rows.map((row) => row.title)).toEqual(["Title 11", "Title 12", "Title 13", "Title 14", "Title 15"]);

    reads.queries.length = 0;
    await expect(run(resolve("from items\norder by title asc\nlimit 9995\noffset 10\n"))).rejects.toMatchObject({ code: "query_limit", path: "limit" });
    expect(reads.queries).toHaveLength(0);
  });

  it("returns the golden rows of the OR query with the opt-in (ac:opt-in-runs-as-today)", async () => {
    const golden = JSON.parse(goldenText) as { query: string; result: unknown };
    const result = await run(resolve(golden.query), true);
    expect(result).toEqual(golden.result);
    // As at 57188a1: one unfiltered, bounded scan of the collection.
    expectQuery(reads.queries[0], query(collection(firestore, "items"), orderBy(documentId()), limit(10_001)));
    expect(reads.documentsRead).toBe(50);
  });

  it("reads one document for a __key__ equality (ac:key-read-kept)", async () => {
    const result = await run(resolve("from items\nwhere __key__ = 'item-02'\nselect title\n"));
    expect(reads.queries).toHaveLength(0);
    expect(reads.documents.map(({ path }) => path)).toEqual(["items/item-02"]);
    expect(result.rows).toEqual([{ title: "Title 02" }]);
  });
});

describe("Firestore semantics", () => {
  beforeAll(async () => { await seed(itemsOneUntitled); });
  afterAll(async () => { await seed(items); });

  it("excludes a document without the ORDER BY field, as Firestore does (ac:order-by-excludes-missing-field)", async () => {
    const result = await run(resolve("from items\norder by title asc\n"));
    const native = await getDocs(query(collection(firestore, "items"), orderBy("title", "asc")));
    expect(result.rows.map((row) => row.__key__)).toEqual(native.docs.map(({ id }) => id));
    expect(result.rows.map((row) => row.title)).toEqual(["Alpha", "Bravo", "Delta", "Echo"]);
  });
});

describe("My DataTug Data, no opt-in (ac:my-data-project-fully-pushed)", () => {
  beforeAll(async () => { await seed(myData); });
  afterAll(async () => { await seed(items); });

  it("reads one document for each keyed query", async () => {
    const expected = {
      "my-user-record": ["users/u1", "u1"],
      "my-datatug-settings": ["users/u1/ext/datatug", "datatug"],
      "my-personal-space": ["spaces/s1", "s1"],
    } as const;
    for (const [name, [path, key]] of Object.entries(expected)) {
      reads = { queries: [], documents: [], documentsRead: 0 };
      const result = await run(resolve(myDataQueries[name as keyof typeof expected]));
      expect(reads.documents.map((reference) => reference.path), name).toEqual([path]);
      expect(reads.queries, name).toHaveLength(0);
      expect(result.rows.map((row) => row.__key__), name).toEqual([key]);
    }
  });

  it("orders my projects by title in one query", async () => {
    const result = await run(resolve(myDataQueries["my-projects"]));
    expect(reads.queries).toHaveLength(1);
    expectQuery(reads.queries[0], query(collection(firestore, "spaces/s1/ext/datatug/projects"), orderBy("title", "asc"), orderBy(documentId(), "asc"), limit(10_001)));
    expect(result.rows.map((row) => row.title)).toEqual(["Alpha", "Zeta"]);
  });

  it("reads a project's queries with one unfiltered query", async () => {
    const result = await run(resolve(myDataQueries["project-queries"], [{ name: "projectId", set: true, value: "p1" }]));
    expect(reads.queries).toHaveLength(1);
    expectQuery(reads.queries[0], query(collection(firestore, "spaces/s1/ext/datatug/projects/p1/queries"), orderBy(documentId()), limit(10_001)));
    expect(result.rows.map((row) => row.__key__)).toEqual(["q1", "q2"]);
  });
});
