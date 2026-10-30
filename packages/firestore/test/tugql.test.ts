import { initializeApp } from "firebase/app";
import { FirestoreError, getFirestore, type DocumentReference, type DocumentSnapshot, type Query, type QuerySnapshot } from "firebase/firestore";
import { parseRecursiveTugQL, parseTugQL, resolveTugQL, type RecursiveTugQLQuery, type TugQLResolved } from "@dalgo/core";
import pathSource from "../src/path.ts?raw";
import querySource from "../src/query.ts?raw";
import tugqlSource from "../src/tugql.ts?raw";
import tugqlPlanSource from "../src/tugql-plan.ts?raw";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  getDoc: [] as string[],
  getDocs: [] as string[],
  documents: new Map<string, Record<string, unknown>>(),
}));

vi.mock("firebase/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();
  const snapshot = (path: string, data: Record<string, unknown> | undefined) => ({
    id: path.split("/").at(-1),
    ref: { path },
    metadata: { fromCache: false, hasPendingWrites: false },
    exists: () => data !== undefined,
    data: () => data,
    get: (field: string) => data?.[field],
  });
  return {
    ...actual,
    getDoc: vi.fn((reference: DocumentReference) => {
      reads.getDoc.push(reference.path);
      return Promise.resolve(snapshot(reference.path, reads.documents.get(reference.path)));
    }),
    getDocs: vi.fn((query: Query) => {
      // A collection reference and a query both expose the collection path.
      const internal = query as unknown as { _query: { path: { canonicalString(): string } } };
      const collectionPath = internal._query.path.canonicalString();
      reads.getDocs.push(collectionPath);
      const docs = [...reads.documents.entries()]
        .filter(([path]) => path.slice(0, path.lastIndexOf("/")) === collectionPath)
        .map(([path, data]) => snapshot(path, data));
      return Promise.resolve({ docs, size: docs.length });
    }),
  };
});

const { FirestoreTugQLRefusedError, firestoreParentKey, firestoreTugQLSource, runFirestoreTugQL } = await import("../src/tugql.js");
type FirestoreTugQLReader = import("../src/tugql.js").FirestoreTugQLReader;

const app = initializeApp({ projectId: "demo-dalgo-js" }, "dalgo2firestore-tugql-tests");
const firestore = getFirestore(app);

function resolve(text: string): TugQLResolved {
  const parsed = parseTugQL(text);
  expect(parsed.diagnostics).toEqual([]);
  const result = resolveTugQL(parsed.document, {
    authorizedSchemas: [],
    relationships: [],
    pinnedImports: [],
    schemaless: true,
    contextVariables: { SneatUserID: "u1", SneatUserPersonalSpaceID: "s1" },
  });
  expect(result.diagnostics).toEqual([]);
  if (result.resolved === undefined) throw new Error("not resolved");
  return result.resolved;
}

beforeEach(() => {
  reads.getDoc.length = 0;
  reads.getDocs.length = 0;
  reads.documents.clear();
});

describe("firestoreParentKey", () => {
  it("builds the DALgo key chain of an even parent path", () => {
    const parent = firestoreParentKey("spaces/abc/ext/datatug");
    expect(parent.path).toBe("spaces/abc/ext/datatug");
    expect(parent.collection).toBe("ext");
    expect(parent.parent?.path).toBe("spaces/abc");
  });

  it("refuses an empty parent path segment naming the path", () => {
    expect(() => firestoreParentKey("spaces//x/y")).toThrow('Firestore parent path "spaces//x/y" has an empty segment');
  });

  it("refuses an odd parent path naming it", () => {
    expect(() => firestoreParentKey("spaces/abc/ext")).toThrow(
      'Firestore parent path "spaces/abc/ext" must name a document (an even number of segments)',
    );
  });

  it("maps a schema-qualified relation to a collection in its parent", () => {
    const source = firestoreTugQLSource({ kind: "table", name: "projects", schema: "spaces/s1/ext/datatug", joins: [] });
    expect(source.kind).toBe("collection");
    expect(source.name).toBe("projects");
    expect(source.parent?.path).toBe("spaces/s1/ext/datatug");
    expect(firestoreTugQLSource({ kind: "table", name: "users", joins: [] })).toEqual({ kind: "collection", name: "users" });
  });
});

describe("runFirestoreTugQL", () => {
  it("refuses an odd parent path before any Firestore read (ac:odd-parent-path-refused)", async () => {
    const resolved = resolve("FROM spaces/abc/ext/projects");
    await expect(runFirestoreTugQL(firestore, resolved)).rejects.toThrow(
      'Firestore parent path "spaces/abc/ext" must name a document (an even number of segments)',
    );
    expect(reads.getDoc).toEqual([]);
    expect(reads.getDocs).toEqual([]);
  });

  it("refuses an odd parent path in a joined relation before the first read", async () => {
    const resolved = resolve("FROM users AS u\nJOIN spaces/abc/ext/projects AS p\n  ON p.owner = u.__key__\nSELECT p.title");
    await expect(runFirestoreTugQL(firestore, resolved)).rejects.toThrow('"spaces/abc/ext"');
    expect(reads.getDocs).toEqual([]);
  });

  it("reads exactly one document for __key__ equality (ac:key-equality-reads-one-document)", async () => {
    reads.documents.set("users/u1", { name: "Alex", email: "a@example.com" });
    reads.documents.set("users/u2", { name: "Other" });
    const result = await runFirestoreTugQL(firestore, resolve("FROM users\nWHERE __key__ = @SneatUserID"));
    expect(reads.getDoc).toEqual(["users/u1"]);
    expect(reads.getDocs).toEqual([]);
    expect(result.columns).toEqual(["__key__", "name", "email"]);
    expect(result.rows).toEqual([{ __key__: "u1", name: "Alex", email: "a@example.com" }]);
  });

  it("returns zero rows when the keyed document is missing", async () => {
    const result = await runFirestoreTugQL(firestore, resolve("FROM users\nWHERE __key__ = 'nobody'"));
    expect(reads.getDoc).toEqual(["users/nobody"]);
    expect(reads.getDocs).toEqual([]);
    expect(result).toEqual({ columns: ["__key__"], rows: [] });
  });

  it("reads a keyed document under a parent path", async () => {
    reads.documents.set("users/u1/ext/datatug", { theme: "dark" });
    const result = await runFirestoreTugQL(firestore, resolve("FROM users/{SneatUserID}/ext\nWHERE __key__ = 'datatug'"));
    expect(reads.getDoc).toEqual(["users/u1/ext/datatug"]);
    expect(result.rows).toEqual([{ __key__: "datatug", theme: "dark" }]);
  });

  it("answers a key that cannot name a document with zero rows and no read", async () => {
    for (const id of ["a/b", "", "..", "__x__"]) {
      const result = await runFirestoreTugQL(firestore, resolve(`FROM users\nWHERE __key__ = '${id}'`));
      expect(result.rows).toEqual([]);
    }
    expect(reads.getDoc).toEqual([]);
    expect(reads.getDocs).toEqual([]);
  });

  it("projects SELECT columns on the key-equality fast path", async () => {
    reads.documents.set("users/u1", { name: "Alex", email: "a@example.com" });
    const result = await runFirestoreTugQL(firestore, resolve("FROM users\nWHERE __key__ = @SneatUserID\nSELECT email, __key__ AS id"));
    expect(reads.getDoc).toEqual(["users/u1"]);
    expect(result).toEqual({ columns: ["email", "id"], rows: [{ email: "a@example.com", id: "u1" }] });
  });

  it("queries a collection under a parent path with __key__ first and the union of fields", async () => {
    reads.documents.set("spaces/s1/ext/datatug/projects/p2", { title: "B", repo: "x/y" });
    reads.documents.set("spaces/s1/ext/datatug/projects/p1", { title: "A", stars: 3 });
    reads.documents.set("spaces/s2/ext/datatug/projects/p9", { title: "Other" });
    const result = await runFirestoreTugQL(firestore, resolve("FROM spaces/{SneatUserPersonalSpaceID}/ext/datatug/projects\nORDER BY title"));
    expect(reads.getDoc).toEqual([]);
    expect(reads.getDocs).toEqual(["spaces/s1/ext/datatug/projects"]);
    expect(result.rows).toEqual([
      { __key__: "p1", title: "A", stars: 3 },
      { __key__: "p2", title: "B", repo: "x/y" },
    ]);
    expect(result.columns).toEqual(["__key__", "title", "stars", "repo"]);
  });

  it("accepts __key__ in where and order-by clauses", async () => {
    for (const id of ["a", "b", "c"]) reads.documents.set(`items/${id}`, { n: id });
    const result = await runFirestoreTugQL(firestore, resolve("FROM items\nWHERE __key__ > 'a'\nORDER BY __key__ DESC\nSELECT __key__"));
    expect(reads.getDoc).toEqual([]);
    expect(result).toEqual({ columns: ["__key__"], rows: [{ __key__: "c" }, { __key__: "b" }] });
  });

  it("does not shortcut a key equality combined with another condition", async () => {
    reads.documents.set("users/u1", { name: "Alex" });
    const result = await runFirestoreTugQL(firestore, resolve("FROM users\nWHERE __key__ = 'u1' AND name = 'Alex'"));
    expect(reads.getDoc).toEqual([]);
    expect(reads.getDocs).toEqual(["users"]);
    expect(result.rows).toEqual([{ __key__: "u1", name: "Alex" }]);
  });

  it("accepts a bare recursive query", async () => {
    reads.documents.set("users/u1", { name: "Alex" });
    const result = await runFirestoreTugQL(firestore, resolve("FROM users\nWHERE __key__ = 'u1'").query);
    expect(result.rows).toEqual([{ __key__: "u1", name: "Alex" }]);
  });

  it("does not shortcut a key equality over a derived FROM", async () => {
    reads.documents.set("users/u1", { name: "Alex" });
    reads.documents.set("users/u2", { name: "Zed" });
    const schema = { tables: [{ name: "users", fields: ["name", "__key__"] }] };
    const firstByName = parseRecursiveTugQL({
      from: { query: { as: "x", from: { name: "users" }, orderBy: [{ field: "name" }], limit: 1 } },
      where: { left: { field: "__key__" }, op: "==", right: { value: "u2" } },
    }, schema);
    await expect(runFirestoreTugQL(firestore, firstByName)).rejects.toMatchObject({ code: "in_memory_evaluation", path: "from" });
    expect(reads.getDocs).toEqual([]);
    expect((await runFirestoreTugQL(firestore, firstByName, { allowInMemoryEvaluation: true })).rows).toEqual([]);
    expect(reads.getDoc).toEqual([]);

    const renamed = parseRecursiveTugQL({
      from: { query: { as: "x", from: { name: "users" }, columns: [{ field: "name", as: "__key__" }] } },
      where: { left: { field: "__key__" }, op: "==", right: { value: "Alex" } },
    }, schema);
    expect((await runFirestoreTugQL(firestore, renamed, { allowInMemoryEvaluation: true })).rows).toEqual([{ __key__: "Alex" }]);
    expect(reads.getDoc).toEqual([]);
  });
});

/** A read seam that counts calls and answers with fake snapshots. */
function fakeReader(documents: number, error?: Error) {
  const calls = { getDocs: 0, getDoc: 0 };
  const reader: FirestoreTugQLReader = {
    getDocs: () => {
      calls.getDocs += 1;
      if (error !== undefined) return Promise.reject(error);
      const docs = Array.from({ length: documents }, (_, index) => ({ id: `d${index.toString()}`, ref: { path: `items/d${index.toString()}` }, data: () => ({ a: 1 }) }));
      return Promise.resolve({ docs, size: docs.length } as unknown as QuerySnapshot);
    },
    getDoc: () => {
      calls.getDoc += 1;
      return Promise.resolve({ id: "u1", exists: () => true, data: () => ({ name: "Alex" }) } as unknown as DocumentSnapshot);
    },
  };
  return { reader, calls };
}

describe("runFirestoreTugQL refusals and read seam", () => {
  it("refuses unpushable queries before any read (ac:unpushable-refused-before-read)", async () => {
    const schema = { tables: [{ name: "items", fields: ["a"] }, { name: "other", fields: ["a"] }] };
    const scalar = parseRecursiveTugQL({
      from: { name: "items" },
      columns: [{ query: { as: "n", from: { name: "other" }, columns: [{ aggregate: { function: "count", args: [{ star: true }] }, as: "c" }] } }],
    }, schema);
    const cases: [TugQLResolved | RecursiveTugQLQuery, string, string][] = [
      [resolve("FROM items\nWHERE a = 1 OR b = 2"), "where", "OR"],
      [resolve("FROM items\nWHERE a = b"), "where", "field compared with field"],
      [resolve("FROM items\nWHERE a = NULL"), "where", "comparison with NULL"],
      [resolve("FROM items AS i\nJOIN other AS o\n  ON o.x = i.y\nSELECT i.a"), "from.joins[0]", "JOIN"],
      [resolve("FROM items\nGROUP BY a\nSELECT a, count(*) AS n"), "groupBy", "GROUP BY"],
      [scalar, "columns[0]", "subquery"],
    ];
    const { reader, calls } = fakeReader(0);
    for (const [query, path, reason] of cases) {
      const error = await runFirestoreTugQL(firestore, query, { reader }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FirestoreTugQLRefusedError);
      expect(error).toMatchObject({ code: "in_memory_evaluation", path, reason });
    }
    expect(calls).toEqual({ getDocs: 0, getDoc: 0 });
    expect(reads.getDocs).toEqual([]);
  });

  it("surfaces a missing-index error unchanged, with no second query (ac:index-error-surfaces)", async () => {
    const FirestoreErrorClass = FirestoreError as unknown as new (code: string, message: string) => FirestoreError;
    const missingIndex = new FirestoreErrorClass("failed-precondition", "The query requires an index. You can create it here: https://console.firebase.google.com/project/demo/firestore/indexes?create_composite=x");
    for (const allowInMemoryEvaluation of [false, true]) {
      const { reader, calls } = fakeReader(0, missingIndex);
      const pushed = runFirestoreTugQL(firestore, resolve("FROM items\nWHERE status = 'active'\nORDER BY rank DESC"), { reader, allowInMemoryEvaluation });
      await expect(pushed).rejects.toBe(missingIndex);
      expect(calls.getDocs).toBe(1);
    }
    const { reader, calls } = fakeReader(0, missingIndex);
    await expect(runFirestoreTugQL(firestore, resolve("FROM items\nWHERE a = 1 OR b = 2"), { reader, allowInMemoryEvaluation: true })).rejects.toBe(missingIndex);
    expect(calls.getDocs).toBe(1);
  });

  it("still fails with query_limit over a collection of more than 10,000 documents (ac:opt-in-runs-as-today)", async () => {
    const { reader, calls } = fakeReader(10_001);
    await expect(runFirestoreTugQL(firestore, resolve("FROM items\nWHERE a = 1 OR b = 2"), { reader, allowInMemoryEvaluation: true }))
      .rejects.toThrow("query_limit at root.from: fetched_rows");
    await expect(runFirestoreTugQL(firestore, resolve("FROM items\nWHERE a = 1"), { reader }))
      .rejects.toThrow("query_limit at root.from: fetched_rows");
    expect(calls.getDocs).toBe(2);
  });

  it("honours maxFetchedRows in the pushed limit", async () => {
    const { reader } = fakeReader(3);
    const result = await runFirestoreTugQL(firestore, resolve("FROM items\nWHERE a = 1"), { reader, maxFetchedRows: 3 });
    expect(result.rows).toHaveLength(3);
    await expect(runFirestoreTugQL(firestore, resolve("FROM items\nLIMIT 3\nOFFSET 1"), { reader, maxFetchedRows: 3 }))
      .rejects.toMatchObject({ code: "query_limit", path: "limit" });
  });

  it("reads a keyed document through the injected getDoc (ac:key-read-kept)", async () => {
    const { reader, calls } = fakeReader(0);
    const result = await runFirestoreTugQL(firestore, resolve("FROM users\nWHERE __key__ = @SneatUserID"), { reader });
    expect(calls).toEqual({ getDocs: 0, getDoc: 1 });
    expect(result.rows).toEqual([{ __key__: "u1", name: "Alex" }]);
  });
});

describe("@dalgo/firestore/tugql read-only by construction", () => {
  it("never names a Firestore write API in tugql.ts or anything it imports", () => {
    const writes = /\b(setDoc|updateDoc|deleteDoc|addDoc|writeBatch|runTransaction)\b/u;
    const sources: Record<string, string> = { "./tugql.js": tugqlSource, "./path.js": pathSource, "./query.js": querySource, "./tugql-plan.js": tugqlPlanSource };
    const seen = new Set<string>();
    const visit = (specifier: string): void => {
      if (seen.has(specifier)) return;
      seen.add(specifier);
      const text = sources[specifier];
      // A new relative import must be added to `sources` so it is checked too.
      expect(text, specifier).toBeDefined();
      expect(text, specifier).not.toMatch(writes);
      for (const match of (text ?? "").matchAll(/from\s+"(\.[^"]+)"/gu)) visit(match[1] ?? "");
    };
    visit("./tugql.js");
    expect([...seen]).toEqual(["./tugql.js", "./path.js", "./query.js", "./tugql-plan.js"]);
  });
});
