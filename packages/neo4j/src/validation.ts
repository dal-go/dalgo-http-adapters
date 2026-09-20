import { type KeyId } from "@dal-go/dalgo";
import type { Neo4jNode, ResolvedCollection } from "./types.js";

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const databaseName = /^[A-Za-z0-9_.-]+$/u;

export function assertIdentifier(value: string, description: string): string {
  if (!identifier.test(value)) {
    throw new TypeError(`${description} must match ${identifier.source}`);
  }
  return value;
}

export function quoteIdentifier(value: string, description: string): string {
  return `\`${assertIdentifier(value, description)}\``;
}

export function assertDatabaseName(value: string): string {
  if (!databaseName.test(value)) {
    throw new TypeError("Neo4j database must contain only letters, numbers, dots, dashes, or underscores");
  }
  return value;
}

export function validateBaseUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new TypeError("Neo4j baseUrl must not include credentials, query parameters, or a fragment");
  }
  if (url.pathname !== "/") {
    throw new TypeError("Neo4j baseUrl must be an origin without a path");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("Neo4j baseUrl must use HTTPS except for a loopback server");
  }
  return url;
}

export function assertJsonValue(value: unknown, description: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${description} contains a non-finite number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => { assertJsonValue(item, `${description}[${index.toString()}]`); });
    return;
  }
  if (isPlainRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${description}.${key}`);
    }
    return;
  }
  throw new TypeError(`${description} must contain JSON values only`);
}

export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

export function assertKeyId(value: unknown, description: string): KeyId {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new TypeError(`${description} must be a non-empty string or finite number`);
}

export function assertNode(value: unknown): Neo4jNode {
  if (!isPlainRecord(value) || !isPlainRecord(value.properties)) {
    throw new TypeError("Neo4j Query API returned a malformed node result");
  }
  return { properties: value.properties };
}

export function collectionForKey(
  collections: ReadonlyMap<string, ResolvedCollection>,
  collection: string,
): ResolvedCollection {
  const configured = collections.get(collection);
  if (configured === undefined) {
    throw new TypeError(`Neo4j collection is not configured: ${collection}`);
  }
  return configured;
}
