# DALgo adapter for Appwrite TablesDB

`@dal-go/dalgo2appwrite` maps DALgo to Appwrite's current **TablesDB rows**
HTTP data plane (`/v1/tablesdb/.../tables/.../rows`). It intentionally does not
use the deprecated Documents/Databases API or management-only endpoints.

## Security and browser boundary

The adapter requires an HTTPS Appwrite endpoint (except loopback development),
a project ID, and database ID. It sends `X-Appwrite-Project` on every request.
Its default `browser-session` mode uses `fetch` with `credentials: "include"`.
For browser use, authenticate as the signed-in Appwrite user: rely on the
configured Appwrite session cookie or supply a refreshed, narrowly scoped
`X-Appwrite-JWT` from a header provider. Tables and rows must grant that user
only the required permissions. Configure Appwrite's Web platform/CORS for the
exact browser origin, including a non-wildcard `Access-Control-Allow-Origin`,
`Access-Control-Allow-Credentials: true`, and allowed Appwrite/JWT request
headers when credentialed cross-origin requests are used.

An `X-Appwrite-Key` is a server API key with scopes: it is for a trusted server
or Function only and must never be passed to browser code, a URL, source
control, analytics, or error reports. API keys are accepted only through the
explicit `credentialMode: "trusted-server"` plus `apiKey` option; browser mode
rejects `X-Appwrite-Key` from a header provider. Trusted-server requests use
`credentials: "omit"`. The adapter does not log headers or response bodies.
Its HTTP errors expose status only; credential-provider, fetch, redirect,
timeout, stream, and JSON errors are redacted.

## Setup

```ts
import { collection } from "@dal-go/dalgo";
import { AppwriteDatabase } from "@dal-go/dalgo2appwrite";

const db = new AppwriteDatabase({
  endpoint: "https://cloud.appwrite.io/v1",
  projectId: "my-project",
  databaseId: "app-data",
  headers: async () => ({ "x-appwrite-jwt": await getFreshUserJwt() }),
});
const items = collection<{ title: string; done: boolean }>("items");
await db.insert(items.key("milk"), { title: "Buy milk", done: false });
```

The table ID is the top-level DALgo collection name and the row ID is the
top-level DALgo key ID. Both must use Appwrite's 1-36 character ID syntax.
Appwrite system columns beginning with `$` are adapter-owned and are removed
before codec decoding; encoded record data may not contain them.

## DALgo mapping

| DALgo operation | TablesDB mapping |
| --- | --- |
| `get` | `GET .../rows/{rowId}`; HTTP 404 is a missing snapshot. |
| `getMany` | Ordered, bounded parallel point reads. |
| `insert` | `POST .../rows` with `{ rowId, data }`; HTTP 409 becomes `AlreadyExistsError`. |
| `set` | `PUT .../rows/{rowId}` upsert with `{ data }`. |
| `update` | `PATCH .../rows/{rowId}` with `{ data }`; HTTP 404 becomes `NotFoundError`. |
| `delete` | `DELETE .../rows/{rowId}`; HTTP 404 is an idempotent missing delete. |
| `query` | `GET .../rows?queries[]=...` with supported Appwrite filters, ordering, bounded limit, and offset. |

Supported filters are equality, inequality, comparisons, `in`/`not-in`, and
`array-contains` via TablesDB `contains`. Query cursors, collection groups,
nested keys, `array-contains-any`, full-text/geospatial operators,
aggregations, realtime subscriptions, permissions mutations, schema management,
and DALgo callback transactions are rejected. Appwrite has a transaction API,
but its explicit staged-operation lifecycle cannot safely implement DALgo's
atomic, retryable callback contract.

Raw REST query parameters are JSON objects serialized as `queries[]` values,
following Appwrite's current REST contract (for example
`{"method":"equal","column":"done","values":[false]}`). This adapter does
not use the legacy-looking `equal("done",[false])` shorthand.

Requests and decoded responses default to 1 MiB, `getMany` to 100 keys/8
parallel reads, queries to 100 rows, and each request (including credentials
and body consumption) to 15 seconds. These are configurable with hard caps.
Tests inject `fetch`; they do not verify a live Appwrite deployment, browser
CORS, user permissions, session policy, JWT issuer/audience, or table schema.

## Official references

- [TablesDB REST API](https://appwrite.io/docs/references/cloud/client-rest/tablesDB)
- [TablesDB rows](https://appwrite.io/docs/products/databases/tablesdb/rows)
- [Appwrite permissions](https://appwrite.io/docs/advanced/platform/permissions)
- [Web platform/CORS setup](https://appwrite.io/docs/advanced/platform/web)

## Verification

`pnpm check` runs ESLint, deterministic Vitest HTTP-contract tests, declaration
build, and type checks the minimal example. No live Appwrite service is used.

## License

MIT
