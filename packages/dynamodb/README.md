# DALgo adapter for Amazon DynamoDB

`@dal-go/dalgo2dynamodb` implements a deliberately bounded subset of the
[`@dal-go/dalgo`](https://github.com/dal-go/dalgo-js) database contracts on
the official modular AWS SDK for JavaScript v3 document client.

It is designed for browser applications that receive **temporary,
least-privilege AWS credentials** (normally through Amazon Cognito or web
identity federation). It does not obtain credentials and must never be given
an IAM user access key or another long-lived server credential.

## Qualification

| Capability | DynamoDB through this adapter |
| --- | --- |
| HTTP data plane | Yes — DynamoDB API requests signed by AWS SDK v3/SigV4 |
| Read / insert / update / delete | Yes — `GetItem`, `BatchGetItem`, conditional `PutItem`, `UpdateItem`, `DeleteItem` |
| Query/filter | Yes — partition-key `Query` plus DynamoDB filter expressions |
| Aggregation | No generic DALgo aggregation mapping |
| Transactions | DynamoDB has `TransactWriteItems`, but DALgo callback transactions are rejected because its read/write callback and retry semantics cannot be preserved honestly |
| Streaming / realtime | Not implemented; DynamoDB Streams is a server-side event-source integration, not browser realtime |
| Browser CORS | Browser JavaScript is supported by AWS SDK v3; requests still need network access to AWS endpoints and correctly signed credentials |
| Browser-safe authentication | Yes, with narrowly scoped, expiring Cognito or web-identity credentials |
| Official JS/TS SDK | Yes — `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` |
| Server credentials required | No; long-lived credentials are specifically unsafe in browser code |

AWS documents Cognito as the recommended way to issue temporary credentials to
web/mobile apps and documents the JavaScript v3 document client as the native
JavaScript-object abstraction over DynamoDB's wire values. See [Cognito
credentials for DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Cognito.Credentials.html),
[web identity federation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WIF.RunningYourApp.html),
and the [SDK v3 document-client guide](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-dynamodb-doc-client.html).

Browser readiness is conditional: this adapter receives an already-constructed
AWS client and cannot inspect or enforce the client's credential source, IAM
policy, table policy, session expiry, or browser network policy. It is safe in
a browser only when the application supplies short-lived, least-privilege
Cognito/web-identity credentials and scopes table access correctly.

## Install

```sh
pnpm add github:dal-go/dalgo-js github:dal-go/dalgo2dynamodb-js \
  @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

The repositories currently build as `@dal-go/dalgo` and
`@dal-go/dalgo2dynamodb`; no npm publication has been made.

## Required table layout

This adapter owns a small physical layout rather than guessing an application's
existing DynamoDB single-table schema. Create a table with two string key
attributes (the default names are `pk` and `sk`):

| Attribute | Stored value |
| --- | --- |
| `pk` | DALgo `key.collectionPath`, for example `spaces/s1/items` |
| `sk` | DALgo `key.path`, for example `spaces/s1/items/milk` |
| `__dalgo_id` | Original DALgo key ID, needed to reconstruct query records |
| `data` | The codec-encoded DALgo document object |

`partitionKey`, `sortKey`, `idAttribute`, `dataAttribute`, and
`maxQueryPages` are configurable when constructing the adapter. Attribute
names must be distinct. Codec output must be a non-null object and may not
contain `undefined` values.

## Browser setup

Create AWS credentials outside this package, using a Cognito identity pool or
web identity federation, and scope its IAM policy to the one table and the
specific `dynamodb:GetItem`, `BatchGetItem`, `PutItem`, `UpdateItem`,
`DeleteItem`, and `Query` actions your app needs.

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { collection } from "@dal-go/dalgo";
import { DynamoDbDatabase } from "@dal-go/dalgo2dynamodb";

const lowLevelClient = new DynamoDBClient({
  region: "eu-west-1",
  // credentials: a caller-owned, short-lived Cognito/web-identity provider
});
const client = DynamoDBDocumentClient.from(lowLevelClient);
const db = new DynamoDbDatabase(client, { tableName: "app-dalgo" });

const items = collection<{ done: boolean; title: string }>("items");
await db.insert(items.key("milk"), { done: false, title: "Buy milk" });
```

The example intentionally omits credential values. Do not put access keys,
session tokens, secrets, or authorization headers in source control, URLs,
analytics, or browser storage.

The complete, type-checked example is [examples/basic.ts](examples/basic.ts).

### Workspace package

This package is not yet published to npm. From the repository root, run
`pnpm install --frozen-lockfile` and
`pnpm --filter @dal-go/dalgo2dynamodb build`.

## Supported DALgo surface

- point reads and ordered `getMany` (up to DynamoDB's 100 distinct-key batch
  limit; duplicate requested keys are restored in output order)
- conditional `insert`, replace-style `set`, top-level-field `update`, and
  `delete`
- collection queries for the adapter's partition-key layout
- AND-combined equality, comparison, membership, `contains`, and
  `array-contains-any` filters over top-level encoded document fields
- ascending or descending document-ID order and adapter-issued `startAfter`
  pagination cursors
- nested collections; their partition value includes the complete parent path

The adapter rejects collection-group queries, arbitrary field ordering,
offsets, inclusive/end cursors, hand-built cursors, and DALgo callback
transactions. These are intentional semantic boundaries, not missing fallback
implementations.

DynamoDB filters run after DynamoDB reads the matched key range, so they do
not reduce read capacity. A limited filtered query can require multiple
underlying DynamoDB requests; the adapter continues through empty filtered
pages until it reaches the requested record limit or the native result range
ends. It rejects a repeated native pagination key and applies a 100-page safety
limit by default (`maxQueryPages` can adjust that bound). DynamoDB limits each
query response to 1 MB and items to 400 KB; design keys and documents
accordingly. See [Query](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html)
and [Scan/query filter behavior](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html).

## Verification

`npm run check` runs ESLint, deterministic Vitest command-contract tests, and
the declaration build. The tests mock the injected AWS document client; they
do **not** contact a DynamoDB table or claim live-service coverage.

## License

MIT
