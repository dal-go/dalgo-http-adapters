import { type Key, type KeyId } from "@dal-go/dalgo";
import type { NeptuneNode, ResolvedCollection } from "./types.js";

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function assertIdentifier(value: string, description: string): string {
  if (!identifier.test(value)) throw new TypeError(`${description} must match ${identifier.source}`);
  return value;
}

export function quoteIdentifier(value: string, description: string): string {
  return `\`${assertIdentifier(value, description)}\``;
}

export function validateBaseUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0 || url.pathname !== "/") {
    throw new TypeError("Neptune baseUrl must be an origin without credentials, path, query parameters, or fragment");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("Neptune baseUrl must use HTTPS except for a loopback server");
  }
  return url;
}

export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** Neptune openCypher node properties are scalar only in this DALgo mapping. */
export function assertPropertyMap(value: unknown, description: string): asserts value is Readonly<Record<string, string | number | boolean>> {
  if (!isPlainRecord(value)) throw new TypeError(`${description} must be a plain object`);
  for (const [key, property] of Object.entries(value)) {
    assertIdentifier(key, "Neptune property name");
    if (key.startsWith("~") || property === null || (typeof property !== "string" && typeof property !== "boolean" && (typeof property !== "number" || !Number.isFinite(property)))) {
      throw new TypeError(`${description}.${key} must be a non-null finite string, number, or boolean`);
    }
  }
}

export function assertQueryScalar(value: unknown, description: string): asserts value is string | number | boolean {
  if (value === null || (typeof value !== "string" && typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value)))) {
    throw new TypeError(`${description} must be a non-null finite string, number, or boolean`);
  }
}

export function collectionForKey(collections: ReadonlyMap<string, ResolvedCollection>, key: Key): ResolvedCollection {
  if (key.parent !== undefined) throw new TypeError("Neptune node collections do not support DALgo parent keys");
  if (typeof key.id !== "string" || key.id.length === 0) throw new TypeError("Neptune DALgo keys must have non-empty string IDs");
  const collection = collections.get(key.collection);
  if (collection === undefined) throw new TypeError(`Neptune collection is not configured: ${key.collection}`);
  return collection;
}

export function neptuneId(collection: ResolvedCollection, id: KeyId): string {
  if (typeof id !== "string" || id.length === 0) throw new TypeError("Neptune DALgo keys must have non-empty string IDs");
  return `${collection.idPrefix}${id}`;
}

export function dalgoId(collection: ResolvedCollection, id: string): string {
  if (!id.startsWith(collection.idPrefix)) throw new TypeError("Neptune response node ID is outside the configured collection mapping");
  const result = id.slice(collection.idPrefix.length);
  if (result.length === 0) throw new TypeError("Neptune response node ID has an empty DALgo key suffix");
  return result;
}

export function assertNode(value: unknown): NeptuneNode {
  if (!isPlainRecord(value) || value["~entityType"] !== "node" || typeof value["~id"] !== "string" || !Array.isArray(value["~labels"]) || !value["~labels"].every((label) => typeof label === "string") || !isPlainRecord(value["~properties"])) {
    throw new TypeError("Neptune openCypher returned a malformed node result");
  }
  return { id: value["~id"], labels: value["~labels"], properties: value["~properties"] };
}
