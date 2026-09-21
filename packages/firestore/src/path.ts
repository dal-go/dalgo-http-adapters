import { Key, type CollectionSource } from "@dalgo/core";

export function firestoreCollectionPath<T>(source: CollectionSource<T>): string {
  return source.parent === undefined
    ? source.name
    : `${source.parent.path}/${source.name}`;
}

export function keyFromDocumentPath(path: string): Key<string> {
  const segments = path.split("/");
  if (segments.length === 0 || segments.length % 2 !== 0 || segments.some((part) => part === "")) {
    throw new TypeError(`invalid Firestore document path: ${path}`);
  }

  let current: Key<string> | undefined;
  for (let index = 0; index < segments.length; index += 2) {
    const collection = segments[index];
    const id = segments[index + 1];
    if (collection === undefined || id === undefined) {
      throw new TypeError(`invalid Firestore document path: ${path}`);
    }
    current = new Key(collection, id, current);
  }

  if (current === undefined) {
    throw new TypeError(`invalid Firestore document path: ${path}`);
  }
  return current;
}
