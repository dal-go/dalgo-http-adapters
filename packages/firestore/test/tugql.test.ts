import { initializeApp } from "firebase/app";
import { getFirestore, type DocumentReference, type Query } from "firebase/firestore";
import { parseTugQL, resolveTugQL, type TugQLResolved } from "@dalgo/core";
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

const { firestoreParentKey, firestoreTugQLSource, runFirestoreTugQL } = await import("../src/tugql.js");

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
});
