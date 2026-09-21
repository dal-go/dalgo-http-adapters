# DALgo adapter for Cloud Spanner REST

`@dal-go/dalgo2spanner` maps top-level DALgo collections to explicitly configured
Cloud Spanner tables through the official v1 REST data plane. It uses standard
`fetch`, the sessions API, parameterized GoogleSQL reads, and atomic single-use
mutation commits; it is not a wrapper over the server-oriented Node SDK.

## Browser security

This adapter is **HTTP-capable**, not browser-ready by default. Cloud Spanner
uses OAuth (`spanner.data` or `cloud-platform`) and the Google endpoint/CORS
configuration must be validated for the deployed browser origin. Supply an
expiring, least-privilege access token from an OAuth flow or a token broker.
Never put a service-account JSON key, refresh token, or a broad project token in
browser source, storage, URLs, or logs. A server-side broker/proxy is usually
the safer production boundary.

## Configure a bounded mapping

```ts
import { collection } from "@dal-go/dalgo";
import { SpannerDatabase } from "@dal-go/dalgo2spanner";

const db = new SpannerDatabase({
  projectId: "exampleproject",
  instanceId: "appinstance",
  databaseId: "appdb",
  accessToken: () => currentAccessToken(),
  tables: {
    items: {
      table: "Items",
      keyColumn: { column: "ItemId", type: "STRING", nullable: false },
      columns: {
        title: { column: "Title", type: "STRING" },
        complete: { column: "Complete", type: "BOOL" },
      },
    },
  },
});

const items = collection<{ title: string; complete: boolean }>("items");
await db.insert(items.key("milk"), { title: "Milk", complete: false });
```

Every identifier comes from validated configuration. Runtime filter values are
bound through named GoogleSQL parameters. A collection has one table and one
primary-key column; composite/interleaved keys deliberately do not masquerade
as DALgo string IDs.

## Semantics and limitations

- `get`, bounded ordered `getMany`, top-level structured filters/orders/limits,
  `insert`, full-row `set` (Spanner `replace`), partial `update`, and idempotent
  `delete` are supported. Writes use a one-request `singleUseTransaction`
  commit, which applies its mutation atomically.
- `insert` and `update` receive Spanner's native existing/missing-row behavior;
  callers should interpret an uncertain transport result as an unknown commit
  outcome, not retry a non-idempotent mutation blindly.
- `set` and `insert` require all configured data fields so no mapped column is
  silently preserved or made NULL. `update` accepts only declared fields.
- Callback transactions reject: correct retry of Spanner `ABORTED` transactions
  requires re-running the callback against a managed transaction, which this
  small HTTP adapter intentionally does not fake. Use the official client for
  that need.
- Query limits are probed with one extra row. Because this package does not
  implement a DALgo continuation cursor, it rejects a query that has more rows
  than its requested limit instead of returning a falsely complete page.
- Collection groups, nested keys, offsets, cursors, array filters, aggregation,
  streaming result sets, composite keys, and null range filters reject.
- Each DALgo operation creates and best-effort releases a REST session. Large
  results are bounded by `maxRows` and `maxResponseBytes`; this package uses
  `executeSql`, not the streaming API.

Result metadata must exactly match the configured projection and declared
Spanner scalar types. `INT64` remains a decimal string (including values beyond
JavaScript's safe-integer range), while `JSON` is parsed before the DALgo codec
runs. The adapter has an end-to-end deadline, rejects redirects, bounds and
cancels streamed response reads, redacts transport and HTTP response bodies,
and calls the token provider for every request.

## Verification

`pnpm check` runs mocked REST contract tests, linting, and TypeScript build. It
does not exercise a live project, IAM policy, OAuth consent flow, or CORS setup.

## Official references

- [Sessions and REST data methods](https://cloud.google.com/spanner/docs/reference/rest/v1/projects.instances.databases.sessions)
- [executeSql](https://cloud.google.com/spanner/docs/reference/rest/v1/projects.instances.databases.sessions/executeSql)
- [commit](https://cloud.google.com/spanner/docs/reference/rest/v1/projects.instances.databases.sessions/commit)
- [Mutation](https://cloud.google.com/spanner/docs/reference/rest/v1/Mutation)

## License

MIT
