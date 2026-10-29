// Read-only TugQL execution against the Firestore Web SDK. This module must
// never import a Firestore write API (test/tugql.test.ts checks the import
// graph statically): browser hosts import it as `@dalgo/firestore/tugql`
// to run user queries on the signed-in user's own session.
import {
  executeRecursiveTugQLQuery,
  type CollectionSource,
  type ExistingRecord,
  type Key,
  type QueryExecutor,
  type QueryPage,
  type RecursiveQueryExecutionOptions,
  type RecursiveTugQLColumn,
  type RecursiveTugQLQuery,
  type RecursiveTugQLRelation,
  type StructuredQuery,
  type TugQLResolved,
} from "@dalgo/core";
import { doc, getDoc, getDocs, type DocumentSnapshot, type Firestore } from "firebase/firestore";
import { firestoreCollectionPath, keyFromDocumentPath } from "./path.js";
import { compileFirestoreQuery } from "./query.js";

/** The reserved TugQL field name of a record's own key (the Firestore document id). */
export const TUGQL_KEY_FIELD = "__key__" as const;

type Data = Record<string, unknown>;

/** Options of {@link runFirestoreTugQL}; the source mapping is the adapter's own. */
export type FirestoreTugQLOptions = Omit<RecursiveQueryExecutionOptions, "resolveSource">;

/** The tabular result of a TugQL query run against Firestore. */
export interface FirestoreTugQLResult {
  /**
   * Output column names. Without SELECT: `__key__` first, then the union of
   * the returned documents' fields in first-seen order. With SELECT: exactly
   * the selected columns.
   */
  readonly columns: readonly string[];
  readonly rows: readonly Data[];
}

/**
 * Builds the DALgo key of a TugQL `schema` read as a Firestore parent path
 * (`spaces/abc/ext/datatug`). The path must name a document: an even number
 * of non-empty segments.
 */
export function firestoreParentKey(schema: string): Key<string> {
  if (schema.split("/").includes("")) {
    throw new TypeError(`Firestore parent path "${schema}" has an empty segment`);
  }
  try {
    return keyFromDocumentPath(schema);
  } catch {
    throw new TypeError(`Firestore parent path "${schema}" must name a document (an even number of segments)`);
  }
}

/** Maps a resolved TugQL table relation to the Firestore collection it reads. */
export function firestoreTugQLSource(relation: RecursiveTugQLRelation): CollectionSource<Data> {
  if (relation.kind !== "table" || relation.name === undefined) {
    throw new TypeError("a Firestore TugQL source must be a named table relation");
  }
  return relation.schema === undefined
    ? { kind: "collection", name: relation.name }
    : { kind: "collection", name: relation.name, parent: firestoreParentKey(relation.schema) };
}

/**
 * Runs a resolved TugQL query (from `resolveTugQL` with `schemaless: true`)
 * against Firestore, reads only. Every table relation's parent path is
 * checked before the first read. A query whose only condition is
 * `__key__ = <value>` over a single collection reads that one document.
 */
export async function runFirestoreTugQL(
  firestore: Firestore,
  resolved: TugQLResolved | RecursiveTugQLQuery,
  options: FirestoreTugQLOptions = {},
): Promise<FirestoreTugQLResult> {
  const query = "kind" in resolved ? resolved : resolved.query;
  const relations = tableRelations(query);
  for (const relation of relations) firestoreTugQLSource(relation);

  const keyed = relations.length === 1 ? keyEquality(query) : undefined;
  const executor = keyed === undefined ? collectionExecutor(firestore) : documentExecutor(firestore, keyed);
  const page = await executeRecursiveTugQLQuery(executor, query, { ...options, resolveSource: firestoreTugQLSource });
  const rows = page.records.map((record) => record.data);
  return { columns: outputColumns(query.columns, rows), rows };
}

function outputColumns(columns: readonly RecursiveTugQLColumn[] | undefined, rows: readonly Data[]): string[] {
  if (columns !== undefined) {
    return columns.map(({ as, expression }) => as
      ?? (expression.kind === "field" ? expression.field.field
        : expression.kind === "aggregate" ? expression.function
          : expression.kind === "query" ? expression.query.as ?? "" : ""));
  }
  const names = new Set<string>([TUGQL_KEY_FIELD]);
  for (const row of rows) for (const name of Object.keys(row)) names.add(name);
  return [...names];
}

/** Collects every table relation of the query tree, nested queries included. */
function tableRelations(query: RecursiveTugQLQuery): RecursiveTugQLRelation[] {
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

interface KeyedRead {
  /** The document id, or undefined when the value can never name a document. */
  readonly id: string | undefined;
}

/** Recognizes a WHERE whose only condition is `__key__ = <literal>`. */
function keyEquality(query: RecursiveTugQLQuery): KeyedRead | undefined {
  // Only a direct collection scan can be answered by one document read; a
  // derived FROM (or a join) filters rows the inner query produced.
  if (query.from.kind !== "table" || query.from.joins.length > 0) return undefined;
  const where = query.where;
  if (where?.kind !== "comparison" || where.operator !== "==") return undefined;
  const names = new Set(["", query.from.alias, query.from.name]);
  const isKey = (side: typeof where.left): boolean => side.kind === "field"
    && side.field.field === TUGQL_KEY_FIELD && names.has(side.field.source);
  const value = isKey(where.left) && where.right.kind === "literal" ? where.right.value
    : isKey(where.right) && where.left.kind === "literal" ? where.left.value
      : notKeyed;
  if (value === notKeyed) return undefined;
  return { id: validDocumentId(value) ? value : undefined };
}

const notKeyed = Symbol("not-keyed");

function validDocumentId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value !== "." && value !== ".."
    && !value.includes("/") && !/^__.*__$/u.test(value);
}

function withKey(snapshot: DocumentSnapshot, key: Key): ExistingRecord<Data> {
  // A real document field literally named __key__ cannot be addressed.
  const data = Object.fromEntries(Object.entries(snapshot.data() ?? {}).filter(([name]) => name !== TUGQL_KEY_FIELD));
  return { key, exists: true, data: { [TUGQL_KEY_FIELD]: snapshot.id, ...data } };
}

function collectionExecutor(firestore: Firestore): QueryExecutor {
  return {
    async query<T>(structured: StructuredQuery<T>): Promise<QueryPage<T>> {
      const snapshot = await getDocs(compileFirestoreQuery(firestore, structured).query);
      const records = snapshot.docs.map((document) => withKey(document, keyFromDocumentPath(document.ref.path)));
      return { records: records as unknown as readonly ExistingRecord<T>[] };
    },
  };
}

/** Answers the single leaf scan of a key-equality query with one document read. */
function documentExecutor(firestore: Firestore, keyed: KeyedRead): QueryExecutor {
  return {
    async query<T>(structured: StructuredQuery<T>): Promise<QueryPage<T>> {
      if (structured.source.kind !== "collection") throw new TypeError("a keyed read needs a collection source");
      if (keyed.id === undefined) return { records: [] };
      const path = `${firestoreCollectionPath(structured.source)}/${keyed.id}`;
      const snapshot = await getDoc(doc(firestore, path));
      const records = snapshot.exists() ? [withKey(snapshot, keyFromDocumentPath(path))] : [];
      return { records: records as unknown as readonly ExistingRecord<T>[] };
    },
  };
}
