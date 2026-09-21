# `@dal-go/dalgo2rds-data`

[DALgo](https://dalgo.io/) adapter for the HTTPS [Amazon RDS Data API](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.html), using a caller-supplied AWS SDK v3 `RDSDataClient`.

## Scope and configuration

The Data API is an HTTP data plane for Aurora clusters with the Data API enabled. AWS documents the currently supported Aurora engines, regions, and cluster configurations in [Enabling the RDS Data API](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.enabling.html); this is **not** an adapter for ordinary RDS PostgreSQL/MySQL instances, RDS SQL Server/Oracle, or database wire protocols.

```sh
pnpm add @dal-go/dalgo2rds-data @aws-sdk/client-rds-data @dal-go/dalgo
```

```ts
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { RdsDataDatabase } from "@dal-go/dalgo2rds-data";

const database = new RdsDataDatabase({
  client: new RDSDataClient({ region: "eu-west-1" }),
  resourceArn: "arn:aws:rds:eu-west-1:123456789012:cluster:my-db",
  secretArn: "arn:aws:secretsmanager:eu-west-1:123456789012:secret:db-user",
  database: "app",
  dialect: "postgresql", // or mysql
  tables: {
    todos: {
      schema: "public", table: "todos", keyColumn: "id", keyType: "integer",
      uniqueKey: true, // confirms a database UNIQUE/PRIMARY KEY constraint
      columns: { title: "title", done: "done" },
    },
  },
});
```

Mappings are deliberate: collection, schema/table, key type/key column, and every projected data column must be supplied. Identifiers are restricted to simple identifiers and quoted per configured dialect; values are RDS Data API SQL parameters, never string-interpolated. The adapter accepts scalar `null`, string, boolean, finite number, and safe integer values only. It deliberately rejects blobs, arrays, nested values, unsafe integers, unmapped fields, and nested DALgo keys.

## DALgo semantics

- `get`, bounded `getMany`, and top-level collection `query` are supported. Queries support scalar equality/inequality/comparison filters, ordering, `limit`, and `offset`. Cursors, collection groups, nested collections, membership/array operators, aggregate queries, and realtime streams are unsupported.
- `update` and idempotent `delete` are enabled only where `uniqueKey: true` confirms the database constraint. `update` requires exactly one affected row and maps zero rows to `NotFoundError`; `delete` accepts zero or one row. More than one affected row is an invalid mapping and fails closed.
- `insert` and `set` are intentionally unsupported. A duplicate-key response arrives as a redacted Data API database failure, so this adapter cannot safely map it to DALgo's `AlreadyExistsError`; a preliminary read/insert introduces a race. PostgreSQL and MySQL also use different atomic upsert syntax. Choosing either hidden behavior would fake DALgo semantics.
- The RDS Data API offers `BeginTransaction`, `CommitTransaction`, and `RollbackTransaction`, but this package rejects DALgo callback transactions for now. It does not claim a callback's multiple reads/writes are atomically routed on one server transaction until that lifecycle is implemented and tested. Database transactions therefore remain available through application-owned RDS Data API calls, not this DALgo abstraction.
- Responses must have exactly the generated projection metadata (`__dalgo_key` followed by mapped fields), bounded row counts, and valid scalar field unions. Invalid or oversized responses fail closed.
- `ExecuteStatement` has AWS's documented 1 MiB binary result cap and no continuation token: AWS terminates an over-limit result. Keep projections and `limit` small enough to fit; this adapter cannot resume it. For ordered pagination, callers are responsible for a deterministic order (normally including a unique final column); no order means database order, and cursor pagination is unsupported.

## Security and browser use

This package is **HTTP-capable, not browser-ready**. RDS Data API requests are SigV4-authenticated and `ExecuteStatement` uses a Secrets Manager database-user secret ARN. Browsers also need AWS CORS support, temporary IAM credentials, and a policy that authorizes the secret and target cluster. The constructor rejects browser use unless `allowBrowser: true`; that escape hatch is only for a carefully designed, short-lived credential flow and does not make putting a `secretArn` or broad AWS role in a public web app safe.

Use server-side/workload credentials and least-privilege IAM. AWS documents required Data API and Secrets Manager authorization in [Controlling access to the RDS Data API](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.access.html). Do not embed access keys, database passwords, tokens, or secret ARNs in client bundles. The adapter does not log SQL, parameter values, service error bodies, result data, or credentials; service failures are intentionally redacted.

The AWS API references are [ExecuteStatement](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_ExecuteStatement.html) and [Using the RDS Data API](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.html).
