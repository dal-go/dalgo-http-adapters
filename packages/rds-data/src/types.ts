import type { RDSDataClient } from "@aws-sdk/client-rds-data";

export type RdsDataDialect = "postgresql" | "mysql";

/** Explicit mapping for one top-level DALgo collection. */
export interface RdsDataTable {
  readonly schema: string;
  readonly table: string;
  readonly keyColumn: string;
  /** This adapter never infers key identities from database wire values. */
  readonly keyType: "string" | "integer";
  /** The caller confirms a UNIQUE or PRIMARY KEY constraint before writes are enabled. */
  readonly uniqueKey?: boolean;
  /** DALgo field name to physical SQL column. */
  readonly columns: Readonly<Record<string, string>>;
}

export interface RdsDataDatabaseOptions {
  /** A configured AWS SDK v3 client. Credentials and region remain application-owned. */
  readonly client: RDSDataClient;
  /** Aurora DB cluster ARN (or Aurora Serverless v2/provisioned cluster with Data API enabled). */
  readonly resourceArn: string;
  /** Secrets Manager ARN for a database user. It must not be sent to browser code. */
  readonly secretArn: string;
  readonly database?: string;
  /** PostgreSQL and MySQL require distinct identifier quoting and SQL dialects. */
  readonly dialect: RdsDataDialect;
  readonly tables: Readonly<Record<string, RdsDataTable>>;
  readonly maxRows?: number;
  readonly maxGetManyKeys?: number;
  readonly timeoutMs?: number;
  /** Explicit opt-in only; AWS IAM, CORS and the database-secret model make browser use impractical. */
  readonly allowBrowser?: boolean;
}
