# @dal-go/dalgo2timestream

Bounded Amazon Timestream HTTP data-plane adapter for DALgo. It sends signed AWS JSON requests directly with Web Crypto; it does not bundle the AWS SDK.

## Install and configure

```ts
import { TimestreamDatabase } from "@dal-go/dalgo2timestream";

const db = new TimestreamDatabase({
  region: "eu-west-1",
  database: "sensors",
  credentials: async () => ({ accessKeyId, secretAccessKey, sessionToken }), // refreshed IAM credentials
  tables: { readings: { table: "readings", keyColumn: "reading_id", columns: { room: "room", temperature: "temperature", time: "time" } } },
});
```

`TimestreamDatabase` signs Query, WriteRecords, and DescribeEndpoints with SigV4 service name `timestream`. Before every independently cached Query or Write cell session, it calls signed `DescribeEndpoints` against its regional endpoint; the regional endpoint receives only discovery, and the selected HTTPS cell endpoint is used until the returned `CachePeriodInMinutes` expires. The configured region must match the endpoint. `queryEndpoint` and `writeEndpoint` override regional discovery endpoints for PrivateLink and deterministic tests; loopback HTTP is accepted only for those test discovery endpoints.

## Semantics and limits

The DALgo `get`, `getMany`, and bare collection `query().limit(n)` paths are bounded, top-level mapped-table reads. `get` verifies that at most one row has the configured string key. Generic filters, ordering, cursors, nested collections, mutations, deletes, and callback transactions are rejected before credentials are loaded or a network request is made. This is intentional: Timestream records are append-oriented, write/query consistency is eventual, and its service pagination token cannot truthfully be translated into a DALgo keyset cursor.

Use `querySql(sql, maxRows, nextToken?)` for read-only `SELECT`/`WITH` SQL, filters, ordering, and service pagination. Keep and submit the latest `nextToken` verbatim. Timestream limits `MaxRows` to 1–1000 and can return fewer rows to remain below its response size limit; service tokens are short-lived and must be used in order. The adapter additionally enforces configurable `maxRows` (default 1000), `maxResponseBytes` (1 MiB), and `timeoutMs` (30 seconds).

Use `writeRecords(table, records, commonAttributes?)` for native time-series ingestion. It accepts 1–100 records (configurable lower cap) and does not claim DALgo insert/set/update semantics. Timestream's `WriteRecords` is eventually consistent, so a successful write is not a read-after-write guarantee. Avoid retries unless your application applies the service's version/idempotency model.

Query scalars decode as `string` (`VARCHAR`, timestamps, dates, times, intervals), `boolean`, `number` (`INTEGER`/`DOUBLE`), or `bigint` (`BIGINT`). Null, array, row, and time-series values decode recursively; timestamps remain strings to preserve nanosecond precision. Malformed or unsupported service shapes fail closed.

## Deployment and credential safety

The browser Fetch API does not make AWS Timestream data-plane endpoints CORS-safe, and static IAM credentials must never reach a browser. A browser window is rejected unless `trustedRuntime: true` is explicitly set: that opt-in is only for a controlled environment that can protect credentials and satisfy the signed `Host` header. Use this package in a trusted server, Worker, or a private service layer that obtains short-lived, scope-bound credentials. Timestream endpoints may require VPC/PrivateLink networking and IAM permissions (`timestream:Query` and/or `timestream:WriteRecords`); the adapter discovers signed cells but does not tunnel VPC traffic or store credentials. Request URLs, response bodies, SQL, tokens, and credentials are intentionally excluded from errors.

See the official [Query API](https://docs.aws.amazon.com/timestream/latest/APIReference/API_query_Query.html), [WriteRecords API](https://docs.aws.amazon.com/timestream/latest/APIReference/API_WriteRecords.html), [query pagination guidance](https://docs.aws.amazon.com/timestream/latest/developerguide/code-samples.run-query.html), and [supported query data types](https://docs.aws.amazon.com/timestream/latest/developerguide/supported-data-types.html).
