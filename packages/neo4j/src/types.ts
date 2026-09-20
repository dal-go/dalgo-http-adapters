import type { Key } from "@dal-go/dalgo";

export interface Neo4jCollectionOptions {
  /** A pre-approved Neo4j node label; it is never taken from a DALgo query. */
  readonly label: string;
  /** Property which stores the DALgo key ID. Defaults to `id`. */
  readonly idProperty?: string;
}

export type Neo4jHeaders = Readonly<Record<string, string>>;
export type Neo4jHeadersProvider = Neo4jHeaders | (() => Neo4jHeaders | Promise<Neo4jHeaders>);

/**
 * The Query API only provides safe explicit transactions on Aura and on a
 * single-instance self-managed server. Selecting this option is an operator
 * assertion about the deployment, not auto-detection.
 */
export type Neo4jTransactionDeployment = "aura" | "single-instance";

export interface Neo4jDatabaseOptions {
  /** Query API origin, such as `https://example.databases.neo4j.io`. */
  readonly baseUrl: string | URL;
  readonly database: string;
  readonly collections: Readonly<Record<string, Neo4jCollectionOptions>>;
  /** Called for every HTTP request, allowing short-lived bearer tokens. */
  readonly headers?: Neo4jHeadersProvider;
  /** Bounded per-request deadline in milliseconds. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /** Enables DALgo callback transactions for a deployment known to be safe. */
  readonly transactionDeployment?: Neo4jTransactionDeployment;
  readonly fetch?: typeof fetch;
}

export interface ResolvedCollection {
  readonly collection: string;
  readonly label: string;
  readonly idProperty: string;
}

export interface Neo4jNode {
  readonly elementId?: string;
  readonly labels?: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface Neo4jErrorBody {
  readonly code?: string;
  readonly message?: string;
}

export class Neo4jQueryError extends Error {
  public readonly code: string | undefined;

  public constructor(code: string | undefined) {
    super(code === undefined ? "Neo4j Query API request failed" : `Neo4j Query API request failed (${code})`);
    this.name = "Neo4jQueryError";
    this.code = code;
  }
}

export function keyIdParameter(key: Key): string | number {
  if (key.parent !== undefined) {
    throw new TypeError("Neo4j node collections do not support DALgo parent keys");
  }
  return key.id;
}
