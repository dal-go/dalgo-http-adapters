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
import {
  doc,
  getDoc,
  getDocs,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Query,
  type QuerySnapshot,
} from "firebase/firestore";
import { firestoreCollectionPath, keyFromDocumentPath } from "./path.js";
import { compileFirestoreQuery } from "./query.js";
import { FirestoreTugQLRefusedError, planFirestoreTugQL, tableRelations, TUGQL_KEY_FIELD, type FirestoreTugQLPlan } from "./tugql-plan.js";

export {
  FirestoreTugQLRefusedError,
  planFirestoreTugQL,
  TUGQL_KEY_FIELD,
  type FirestoreTugQLPlan,
  type FirestoreTugQLPlanOptions,
  type FirestoreTugQLRefusalCode,
} from "./tugql-plan.js";

type Data = Record<string, unknown>;

/**
 * The Firestore read functions runFirestoreTugQL uses (REQ:read-seam). The
 * default is the Web SDK's own `getDocs` and `getDoc`; a test can inject a
 * reader that counts reads, inspects the query, or returns fakes.
 */
export interface FirestoreTugQLReader {
  getDocs(query: Query): Promise<QuerySnapshot>;
  getDoc(reference: DocumentReference): Promise<DocumentSnapshot>;
}

const webSDKReader: FirestoreTugQLReader = { getDocs, getDoc };

/** Options of {@link runFirestoreTugQL}; the source mapping is the adapter's own. */
export interface FirestoreTugQLOptions extends Omit<RecursiveQueryExecutionOptions, "resolveSource"> {
  /**
   * Allows a query that cannot run as one Firestore query (an OR, a JOIN, a
   * subquery, GROUP BY, …) to run as bounded collection scans evaluated in
   * memory by DALgo-JS. Every scanned document is a billed read. Without it
   * such a query fails with `in_memory_evaluation` before any read.
   */
  readonly allowInMemoryEvaluation?: boolean;
  /** The read functions; the Firestore Web SDK's by default. */
  readonly reader?: FirestoreTugQLReader;
}

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
 * Runs a resolved TugQL query (from `resolveTugQL` with `schemaless: true`,
 * parameters bound) against Firestore, reads only. Every table relation's
 * parent path is checked before the first read. Then the query is planned
 * ({@link planFirestoreTugQL}):
 * - a query whose only condition is `__key__ = <value>` reads that one document;
 * - a single-collection query with an AND of field-to-value comparisons runs
 *   as one Firestore query carrying its WHERE, ORDER BY and LIMIT;
 * - any other query fails with `in_memory_evaluation` before any read, unless
 *   `allowInMemoryEvaluation` is set.
 * DALgo-JS then applies WHERE, ORDER BY, OFFSET, LIMIT and SELECT to the
 * documents read. An error of a Firestore read reaches the caller unchanged.
 */
export async function runFirestoreTugQL(
  firestore: Firestore,
  resolved: TugQLResolved | RecursiveTugQLQuery,
  options: FirestoreTugQLOptions = {},
): Promise<FirestoreTugQLResult> {
  const query = "kind" in resolved ? resolved : resolved.query;
  for (const relation of tableRelations(query)) firestoreTugQLSource(relation);

  const { allowInMemoryEvaluation = false, reader = webSDKReader, ...execution } = options;
  const plan = planFirestoreTugQL(query, { ...execution, allowInMemoryEvaluation });
  if (plan.kind === "refused") throw new FirestoreTugQLRefusedError(plan.code, plan.path, plan.reason);
  const page = await executeRecursiveTugQLQuery(planExecutor(firestore, reader, plan), query, { ...execution, resolveSource: firestoreTugQLSource });
  const rows = page.records.map((record) => record.data);
  return { columns: outputColumns(query.columns, rows), rows };
}

function planExecutor(firestore: Firestore, reader: FirestoreTugQLReader, plan: Exclude<FirestoreTugQLPlan, { kind: "refused" }>): QueryExecutor {
  switch (plan.kind) {
    case "pushed": return pushedExecutor(firestore, reader, plan);
    case "key": return documentExecutor(firestore, reader, plan.id);
    case "empty": return emptyExecutor;
    case "in-memory": return collectionExecutor(firestore, reader);
  }
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

function withKey(snapshot: DocumentSnapshot, key: Key): ExistingRecord<Data> {
  // A real document field literally named __key__ cannot be addressed.
  const data = Object.fromEntries(Object.entries(snapshot.data() ?? {}).filter(([name]) => name !== TUGQL_KEY_FIELD));
  return { key, exists: true, data: { [TUGQL_KEY_FIELD]: snapshot.id, ...data } };
}

async function readQuery<T>(reader: FirestoreTugQLReader, firestore: Firestore, structured: StructuredQuery<T>): Promise<QueryPage<T>> {
  const snapshot = await reader.getDocs(compileFirestoreQuery(firestore, structured).query);
  const records = snapshot.docs.map((document) => withKey(document, keyFromDocumentPath(document.ref.path)));
  return { records: records as unknown as readonly ExistingRecord<T>[] };
}

/** Answers every leaf scan with an unfiltered, bounded collection read (opt-in only). */
function collectionExecutor(firestore: Firestore, reader: FirestoreTugQLReader): QueryExecutor {
  return { query: (structured) => readQuery(reader, firestore, structured) };
}

/**
 * Answers DALgo-JS's single leaf scan with the pushed Firestore query: the
 * scan's own source, with the plan's filters, orders and limit.
 */
function pushedExecutor(firestore: Firestore, reader: FirestoreTugQLReader, plan: Extract<FirestoreTugQLPlan, { kind: "pushed" }>): QueryExecutor {
  return {
    query: <T>(structured: StructuredQuery<T>) => readQuery(reader, firestore, {
      source: structured.source,
      filters: plan.filters,
      orders: plan.orders,
      limit: plan.limit,
    }),
  };
}

/** Answers the single leaf scan of a key-equality query with one document read. */
function documentExecutor(firestore: Firestore, reader: FirestoreTugQLReader, id: string): QueryExecutor {
  return {
    async query<T>(structured: StructuredQuery<T>): Promise<QueryPage<T>> {
      if (structured.source.kind !== "collection") throw new TypeError("a keyed read needs a collection source");
      const path = `${firestoreCollectionPath(structured.source)}/${id}`;
      const snapshot = await reader.getDoc(doc(firestore, path));
      const records = snapshot.exists() ? [withKey(snapshot, keyFromDocumentPath(path))] : [];
      return { records: records as unknown as readonly ExistingRecord<T>[] };
    },
  };
}

/** Answers the leaf scan of a query no document can match, without a read. */
const emptyExecutor: QueryExecutor = {
  query: <T>() => Promise.resolve<QueryPage<T>>({ records: [] }),
};
