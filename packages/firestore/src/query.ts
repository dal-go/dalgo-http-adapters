import {
  DOCUMENT_ID,
  Key,
  UnsupportedError,
  type FieldPath,
  type QueryCursor,
  type QueryOrder,
  type QuerySource,
  type StructuredQuery,
} from "@dalgo/core";
import {
  collection,
  collectionGroup,
  documentId,
  endAt,
  endBefore,
  limit,
  orderBy,
  query as createQuery,
  startAfter,
  startAt,
  where,
  type DocumentSnapshot,
  type Firestore,
  type Query,
  type QueryConstraint,
} from "firebase/firestore";
import { firestoreCollectionPath } from "./path.js";

export interface CompiledFirestoreQuery<T> {
  readonly query: Query;
  readonly orders: readonly QueryOrder<T>[];
}

function firestoreField<T>(field: FieldPath<T>): string | ReturnType<typeof documentId> {
  return field === DOCUMENT_ID ? documentId() : field;
}

export function toFirestoreDocumentIdValue<T>(
  value: unknown,
  source: QuerySource<T>,
): unknown {
  if (value instanceof Key) {
    if (source.kind === "collection") {
      const collectionPath = firestoreCollectionPath(source);
      if (value.collectionPath !== collectionPath) {
        throw new TypeError(
          `document key belongs to ${value.collectionPath}, expected ${collectionPath}`,
        );
      }
      return value.path.slice(collectionPath.length + 1);
    }
    if (value.collection !== source.name) {
      throw new TypeError(
        `document key belongs to ${value.collection}, expected collection group ${source.name}`,
      );
    }
    return value.path;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toFirestoreDocumentIdValue(item, source));
  }
  return value;
}

function queryOrders<T>(dalQuery: StructuredQuery<T>): readonly QueryOrder<T>[] {
  if (dalQuery.orders.some(({ field }) => field === DOCUMENT_ID)) {
    return dalQuery.orders;
  }
  const direction = dalQuery.orders.at(-1)?.direction ?? "asc";
  return [...dalQuery.orders, { field: DOCUMENT_ID, direction }];
}

function addCursor(
  constraints: QueryConstraint[],
  value: QueryCursor | undefined,
  orderCount: number,
  createConstraint: (...values: unknown[]) => QueryConstraint,
): void {
  if (value === undefined) {
    return;
  }
  if (value.values.length !== orderCount) {
    throw new TypeError(
      `cursor has ${value.values.length.toString()} values but the compiled query has ${orderCount.toString()} order fields`,
    );
  }
  constraints.push(createConstraint(...value.values));
}

export function compileFirestoreQuery<T>(
  firestore: Firestore,
  dalQuery: StructuredQuery<T>,
): CompiledFirestoreQuery<T> {
  if ((dalQuery.offset ?? 0) !== 0) {
    throw new UnsupportedError("Firestore Web SDK query offsets");
  }

  const source = dalQuery.source.kind === "collection"
    ? collection(firestore, firestoreCollectionPath(dalQuery.source))
    : collectionGroup(firestore, dalQuery.source.name);
  const constraints: QueryConstraint[] = [];

  for (const filter of dalQuery.filters) {
    constraints.push(where(
      firestoreField(filter.field),
      filter.operator,
      filter.field === DOCUMENT_ID
        ? toFirestoreDocumentIdValue(filter.value, dalQuery.source)
        : filter.value,
    ));
  }

  const orders = queryOrders(dalQuery);
  for (const order of orders) {
    constraints.push(orderBy(firestoreField(order.field), order.direction));
  }

  addCursor(constraints, dalQuery.startAt, orders.length, startAt);
  addCursor(constraints, dalQuery.startAfter, orders.length, startAfter);
  addCursor(constraints, dalQuery.endAt, orders.length, endAt);
  addCursor(constraints, dalQuery.endBefore, orders.length, endBefore);

  if (dalQuery.limit !== undefined) {
    constraints.push(limit(dalQuery.limit));
  }

  return { query: createQuery(source, ...constraints), orders };
}

export function cursorFromSnapshot<T>(
  snapshot: DocumentSnapshot,
  orders: readonly QueryOrder<T>[],
): QueryCursor {
  return {
    values: orders.map(({ field }): unknown => (
      field === DOCUMENT_ID ? snapshot.id : snapshot.get(field) as unknown
    )),
  };
}
