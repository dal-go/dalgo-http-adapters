# DALgo adapter for Azure Data Explorer / Kusto

`@dal-go/dalgo2kusto` is a dependency-free TypeScript adapter over the Azure Data Explorer (Kusto) HTTPS **query** data plane. It sends only `POST /v2/rest/query` requests with Kusto's `x-ms-readonly: true` header; it never sends management commands.

## Security and browser use

This adapter is **HTTP-capable**, not browser-ready by default. Supply a short-lived Microsoft Entra bearer token for every request through `accessToken`. Browser use also requires deliberate CORS configuration for the cluster and a least-privilege Entra/OAuth design. Do not expose client secrets, service principals, long-lived tokens, or administrator credentials in browser code, URLs, storage, telemetry, or errors. A trusted token broker should authenticate the user, authorize the requested database access, mint audience-scoped short-lived tokens, and enforce origin policy.

## Mapping and supported surface

A DALgo collection is explicitly mapped to one Kusto table; `keyColumn` maps a root string DALgo key and `columns` maps returned document fields. The adapter projects only those mapped columns and validates the V2 response frames, primary table, names, row shape, scalar values, and successful DataSet completion.

| DALgo operation | Behavior |
| --- | --- |
| `get` / `getMany` | Parameterized KQL key lookup; `getMany` is bounded and issues independent queries. |
| `query` | Bounded `take` query for a mapped collection. |
| `insert`, `set`, `update`, `delete`, transactions | Rejected before network access. |
| `queryKql` | Explicit read-only KQL escape hatch with declared typed request parameters and validated scalar primary table. |

Generic DALgo filters, sort, offset, cursors, nesting, projections, aggregation, realtime, and streaming are rejected rather than guessed. Kusto ingestion/update/delete operations are management or specialized ingestion surfaces with different acknowledgement, retry, schema, and idempotency semantics; this package does not fake DALgo CRUD or transactions.

```ts
import { collection } from "@dal-go/dalgo";
import { KustoDatabase } from "@dal-go/dalgo2kusto";

const db = new KustoDatabase({
  clusterUrl: "https://example.eastus.kusto.windows.net",
  database: "Logs",
  accessToken: () => getFreshEntraToken(),
  tables: { events: { table: "Events", keyColumn: "EventId", columns: { message: "Message" } } },
});
await db.query(collection<{ message: string }>("events").query().limit(20).build());
```

Request deadlines cover token acquisition, transport, and bounded streamed body reading. Token/transport/redirect/timeout/malformed-response failures are redacted as `KustoRequestError`; provider error bodies are discarded and HTTP errors expose only status. Default deadline and response cap are 15 seconds and 1 MiB.

## Official references

- [Query/management HTTP request](https://learn.microsoft.com/en-us/kusto/api/rest/request)
- [Query V2 HTTP response](https://learn.microsoft.com/en-us/kusto/api/rest/response-v2)
- [Query parameters declaration](https://learn.microsoft.com/en-us/kusto/query/query-parameters-statement)
- [Azure Data Explorer authentication](https://learn.microsoft.com/en-us/azure/data-explorer/authentication-overview)

## Verification

`pnpm check` runs lint, deterministic HTTP-contract tests, and TypeScript build. It does not contact an Azure cluster or validate Entra/CORS/IAM configuration.

## License

MIT
