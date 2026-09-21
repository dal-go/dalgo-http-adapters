import { Key, type KeyId, type QuerySource } from "@dalgo/core";

export interface SerializedKeyPart {
  readonly collection: string;
  readonly id: KeyId;
}

export function collectionPath<T>(source: QuerySource<T>): string {
  if (source.kind !== "collection") {
    throw new TypeError("a collection-group source has no single collection path");
  }
  return source.parent === undefined ? source.name : `${source.parent.path}/${source.name}`;
}

export function serializeKey(key: Key): readonly SerializedKeyPart[] {
  const parts: SerializedKeyPart[] = [];
  let current: Key | undefined = key;
  while (current !== undefined) {
    parts.unshift({ collection: current.collection, id: current.id });
    current = current.parent;
  }
  return parts;
}

export function deserializeKey(parts: readonly SerializedKeyPart[]): Key {
  if (parts.length === 0) {
    throw new TypeError("a serialized key requires at least one part");
  }
  let current: Key | undefined;
  for (const part of parts) {
    current = new Key(part.collection, part.id, current);
  }
  if (current === undefined) {
    throw new TypeError("a serialized key requires at least one part");
  }
  return current;
}
