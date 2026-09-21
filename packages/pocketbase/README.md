# DALgo adapter for PocketBase

`@dal-go/dalgo2pocketbase` maps top-level DALgo collections and records to
PocketBase's records HTTP data plane (`/api/collections/{collection}/records`).
It uses the public record endpoints, not PocketBase's dashboard or management
API.

## Security and browser boundary

The adapter requires an HTTPS PocketBase URL, except for loopback development.
For a browser application, provide a currently authenticated **auth-record
user** token through `headers`; PocketBase collection `listRule`, `viewRule`,
`createRule`, `updateRule`, and `deleteRule` remain the authorization boundary.
Configure PocketBase CORS for the exact site origin and required `Authorization`
header. Test the deployed rule set: CORS approval is not authorization.

Never send a PocketBase superuser token to a browser, URL, source control,
analytics, or error reports. Superuser credentials bypass record rules and are
appropriate only in a trusted server environment. The adapter does not log
headers or response bodies. Provider errors expose HTTP status only, while
credential-provider, fetch, redirect, timeout, stream, and JSON failures are
redacted.

## Setup

```ts
import { collection } from "@dal-go/dalgo";
import { PocketBaseDatabase } from "@dal-go/dalgo2pocketbase";

const db = new PocketBaseDatabase({
  baseUrl: "https://db.example.com",
  headers: async () => ({ authorization: `Bearer ${await getFreshUserToken()}` }),
});
const items = collection<{ title: string; done: boolean }>("items");
await db.insert(items.key("a1b2c3d4e5f6g7h"), { title: "Buy milk", done: false });
```

By default, a DALgo collection name is the PocketBase collection name. Pass
`collectionName` to map it to a different PocketBase collection name or ID.
Both mapped collection names/IDs and record IDs are deliberately restricted:
record IDs must be PocketBase's 15-character alphanumeric form, and nested
DALgo keys are not supported. PocketBase-owned `id`, collection metadata,
timestamps, and `expand` are removed before a codec decodes record data;
encoded data may not write those fields.

## DALgo mapping

| DALgo operation | PocketBase records mapping |
| --- | --- |
| `get` | `GET .../records/{id}`; HTTP 404 is a missing snapshot. |
| `getMany` | Ordered, bounded parallel point reads. |
| `insert` | `POST .../records` with caller-supplied record `id`. |
| `update` | `PATCH .../records/{id}`; HTTP 404 becomes `NotFoundError`. |
| `delete` | `DELETE .../records/{id}`; HTTP 404 is an idempotent missing delete. |
| `query` | `GET .../records?page=1&perPage=...` using PocketBase filter and sort syntax. |

PocketBase's record-create API reports both duplicate IDs and ordinary schema
validation as HTTP 400. To avoid inspecting or exposing application error
bodies, `insert` returns `PocketBaseHttpError(400)` rather than falsely mapping
every validation failure to `AlreadyExistsError`.

The adapter translates equality, inequality, comparisons, `in`, `not-in`, and
`array-contains` filters; it translates ascending/descending sorting. Its
offset implementation requests the bounded leading `offset + limit` window and
slices it locally, preserving DALgo offset semantics. Cursors, collection
groups, nested keys, array-contains-any, text/geospatial operators,
aggregations, realtime, files, schema/rule management, and callback
transactions are rejected. `set` is also rejected: implementing it as PATCH
then POST would not be atomic, while PocketBase's transactional batch upsert is
an opt-in server feature and cannot faithfully provide DALgo callback semantics.

Requests and decoded responses default to 1 MiB, `getMany` to 100 keys/8
parallel reads, query results to 100 records, offset windows to 1,000 records,
and each request (including token generation and response streaming) to 15
seconds. These limits are configurable with hard caps. Tests inject `fetch`;
they do not exercise a live PocketBase deployment, CORS, auth tokens, rules,
or schema.

## Official references

- [PocketBase records Web API](https://pocketbase.io/docs/api-records/)
- [PocketBase JavaScript SDK and auth state](https://pocketbase.io/docs/js-sdk/)
- [PocketBase production and CORS configuration](https://pocketbase.io/docs/going-to-production/)

## Verification

`pnpm check` runs ESLint, deterministic Vitest HTTP-contract tests, declaration
build, and type checks the minimal example. No live PocketBase server is used.

## License

MIT
