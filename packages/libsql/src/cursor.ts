import { LibSQLCursorError } from "./errors.js";

/** Stable adapter identity: a cursor minted by another adapter or instance is foreign. */
export const LIBSQL_CURSOR_ADAPTER = "@dal-go/dalgo2libsql";
export const LIBSQL_CURSOR_VERSION = 1;

export type LibSQLCursorPosition = string | number | null;

const CURSOR_TOKEN = /^nls1_[A-Za-z0-9_-]{43}$/u;

export interface LibSQLCursorBinding {
  /** Digest of endpoint, collection, table, key, filters, order and page size. */
  readonly query: string;
  /** Digest of the explicit identity scope or the resolved request headers. */
  readonly scope: string;
}

interface StoredCursor extends LibSQLCursorBinding {
  readonly page: number;
  readonly values: readonly LibSQLCursorPosition[];
}

export interface PreviewCursor extends LibSQLCursorBinding {
  readonly page: number;
  readonly values: readonly LibSQLCursorPosition[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("libSQL cursor values must be finite numbers and not negative zero");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("libSQL cursor binding must be plain JSON");
}

/** FNV-1a over a random per-instance secret, so a digest never leaves the adapter. */
export function libSQLDigest(secret: string, value: string): string {
  let hash = 0xcbf29ce484222325n;
  const encoded = new TextEncoder().encode(`${secret}:${value}`);
  for (const byte of encoded) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function libSQLCanonicalJson(value: unknown): string { return canonicalJson(value); }

function randomSecret(): string {
  const crypto = globalThis.crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== "function") {
    throw new Error("libSQL cursors require crypto.getRandomValues");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const crypto = globalThis.crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== "function") {
    throw new Error("libSQL cursors require crypto.getRandomValues");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `nls1_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

/**
 * Bounded, single-use, adapter-issued cursor handles.
 *
 * A handle carries no row values: the adapter keeps the keyset position in
 * memory and the opaque token is only a registry key. A token is bound to the
 * exact endpoint/table/query/page size and credential scope, cannot be replayed,
 * and is evicted rather than growing memory without bound.
 *
 * `preview` reserves a handle so the caller can build its keyset request and
 * verify the observed credential scope before any fetch. `commit` retires it;
 * `release` returns it after a failed attempt, allowing a deliberate retry
 * without making replay invisible.
 */
export class LibSQLCursorRegistry {
  readonly #secret = randomSecret();
  readonly #issued = new Map<string, StoredCursor>();
  readonly #active = new Set<string>();
  readonly #consumed = new Map<string, true>();
  readonly #maxIssued: number;
  readonly #maxConserved: number;

  public constructor(maxIssued: number, maxConserved: number) {
    this.#maxIssued = maxIssued;
    this.#maxConserved = maxConserved;
  }

  public get maxIssued(): number { return this.#maxIssued; }
  public get maxConserved(): number { return this.#maxConserved; }

  public binding(value: unknown): string {
    return libSQLDigest(this.#secret, canonicalJson(value));
  }

  public scope(value: string): string {
    return libSQLDigest(this.#secret, `scope:${value}`);
  }

  public issue(binding: LibSQLCursorBinding, page: number, values: readonly LibSQLCursorPosition[]): string {
    while (this.#issued.size >= this.#maxIssued) {
      const oldest = this.#issued.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#issued.delete(oldest);
      this.#active.delete(oldest);
    }
    let token = randomToken();
    while (this.#issued.has(token) || this.#consumed.has(token) || this.#active.has(token)) token = randomToken();
    this.#issued.set(token, { ...binding, page, values: Object.freeze([...values]) });
    return token;
  }

  /**
   * Reserves a handle for one attempt. The query fingerprint is checked here,
   * before any request; the credential scope is checked by the caller after the
   * request headers are resolved and before the fetch.
   */
  public reserve(token: string, query: string): PreviewCursor {
    if (!CURSOR_TOKEN.test(token)) throw new LibSQLCursorError("malformed");
    if (this.#consumed.has(token)) throw new LibSQLCursorError("replayed");
    const stored = this.#issued.get(token);
    if (stored === undefined) throw new LibSQLCursorError("foreign");
    if (this.#active.has(token)) throw new LibSQLCursorError("replayed");
    if (stored.query !== query) throw new LibSQLCursorError("changed-query");
    this.#active.add(token);
    return { query: stored.query, scope: stored.scope, page: stored.page, values: stored.values };
  }

  public commit(token: string): void {
    this.#active.delete(token);
    this.#issued.delete(token);
    this.#consumed.set(token, true);
    while (this.#consumed.size > this.#maxConserved) {
      const oldest = this.#consumed.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#consumed.delete(oldest);
    }
  }

  public release(token: string): void {
    this.#active.delete(token);
  }
}
