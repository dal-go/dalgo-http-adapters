import { Key, UnsupportedError, type CollectionSource } from "@dal-go/dalgo";
const forbidden = /[.#$[\]/]/;
export function assertSafeKey(key: Key): void {
  for (let current: Key | undefined = key; current !== undefined; current = current.parent) {
    if (typeof current.id !== "string" || current.id.length === 0 || current.collection.length === 0 || forbidden.test(current.id) || forbidden.test(current.collection)) throw new UnsupportedError("RTDB keys require non-empty string IDs and path-safe collection/ID segments");
  }
}
export function rtdbCollectionPath<T>(source: CollectionSource<T>): string { if (source.parent !== undefined) assertSafeKey(source.parent); if (source.name.length === 0 || forbidden.test(source.name)) throw new UnsupportedError("RTDB collection paths require safe segments"); return source.parent === undefined ? source.name : `${source.parent.path}/${source.name}`; }
export function keyFromRtdbPath(path: string): Key<string> {
  const segments = path.split("/");
  if (segments.length === 0 || segments.length % 2 !== 0 || segments.some((segment) => segment === "")) throw new TypeError(`invalid DALgo key path: ${path}`);
  let result: Key<string> | undefined;
  for (let index = 0; index < segments.length; index += 2) { const collection = segments[index]; const id = segments[index + 1]; if (collection === undefined || id === undefined) throw new TypeError(`invalid DALgo key path: ${path}`); result = new Key(collection, id, result); }
  if (result === undefined) throw new TypeError(`invalid DALgo key path: ${path}`);
  return result;
}
