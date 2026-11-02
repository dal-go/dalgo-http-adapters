# DALGO Snowflake adapter

Read-only [DALgo TypeScript](https://github.com/dal-go/dalgo-http-adapters) adapter for existing mapped Snowflake SQL tables through the SQL API. The package remains private at source version 0.1.0; source publication is separate from registry availability. The adapter uses canonical public `@dalgo/core` 0.8.1 and `@dalgo/adapter-runtime` 0.1.2 APIs. No Snowflake SDK, replacement managed layout, or arbitrary SQL execution interface is introduced.

## Source use

Build the `packages/snowflake` subdirectory of a reviewed repository revision with the normal prepack script, which builds the sibling runtime first. A registry release is not claimed. Install the exact public core/runtime peers in a consumer; do not substitute the archived `@dal-go/dalgo` alias. Git source preparation remains subject to the consumer's exact dependency build policy; do not enable dependency scripts globally.

```ts
import { collection } from "@dalgo/core";
import { SnowflakeDatabase } from "@dal-go/dalgo2snowflake";

const db = new SnowflakeDatabase({
  endpoint: "https://my-org-my-account.snowflakecomputing.com",
  database: "APP", schema: "PUBLIC", warehouse: "COMPUTE_WH",
  token: async signal => obtainOAuthAccessToken(signal), // your server-side token provider
  tables: { users: { table: "USERS", idColumn: "ID" } },
});
const users = collection<Record<string, string | null>>("users");
const user = await db.get(users.key("user-1"));
const page = await db.query(users.query().where("NAME", "==", "Ada").limit(20).build());
```

See [the typechecked codec example](examples/read.ts). `get` accepts a codec separately; a collection's codec applies automatically to its queries. Tables must already exist. Identifier spelling is exact and case-sensitive; ordinary unquoted Snowflake identifiers are normally uppercase. Collection names map only through `tables`, within one configured database/schema. `idColumn` must hold unique, non-null values. Default keys are non-empty strings; `idType: "number"` permits safe integers. Standard Snowflake tables do not enforce primary-key uniqueness: maintain this invariant in ingestion. Duplicate keys encountered in a result cause failure; uniqueness outside a limited result is not audited.

## Capabilities and semantics

- `get` returns DALGO existing/missing snapshots. `getMany` preserves input order, missing records and duplicates, using sequential point reads; it is not a shared snapshot.
- Collection queries support scalar `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`; filters are ANDed. `== null` and `!= null` become SQL null predicates. Other comparisons follow SQL semantics, including exclusion of null rows from ordinary inequality and membership comparisons. Null-containing or empty membership lists are rejected.
- Query fields are exact top-level SQL columns. `DOCUMENT_ID` addresses `idColumn`, accepting an ID or matching DALGO `Key`. Ordering specifies `NULLS LAST`; an ascending ID tie-breaker is appended unless the ID is already ordered. Limits and offsets are supported. Offsets across separate queries can shift as underlying data changes.
- Returned row values retain Snowflake JSONv2 strings and nulls, including numbers, booleans, temporal values and JSON text. Use a codec to decode domain types without silently losing numeric precision. The ID remains present in record data.
- Async execution is polled; all result partitions are fetched. `maxRows` defaults to 10,000 (minimum 2, hard maximum 100,000). Queries without an explicit limit request one extra row to detect overflow and throw, never silently truncate. Explicit limits above `maxRows` are rejected. Returned pages have no `nextCursor`.

`runReadwriteTransaction` rejects with DALGO `UnsupportedError` **without invoking the callback**. DALGO interactive callback transactions require read-dependent writes within one transaction; the SQL API's documented multi-statement transaction facility does not provide that callback contract. Insert/set/update/delete are not exposed. Collection groups, parent keys, cursor boundaries, nested field paths, array operators, object/date/bigint filter values are also unsupported and rejected explicitly.

## Credentials and transport

Use a least-privilege read-only Snowflake role. `token(signal)` is called for each ordinary request, supporting rotation. Remote cancel alone reuses the bounded credential captured for its statement submission, without calling a potentially unrelated rotating provider again. OAuth is the default; pre-generated key-pair JWTs can use `tokenType: "KEYPAIR_JWT"`. Token generation, refresh, storage and signing remain the host application's responsibility. Never embed credentials in a browser bundle.

The endpoint must be an HTTPS `*.snowflakecomputing.com` account origin with no credentials, port, query or path. Redirects are refused. Server-provided status URLs are ignored; validated statement handles generate same-origin paths. Tokens are sent only in headers. Provider/fetch/server error text is deliberately omitted from adapter errors to avoid credential, SQL or data disclosure. A supplied `fetch` implementation is trusted and must implement standard Fetch security/decompression behavior.

## Bounded reads and cancellation

`get`, `getMany` and `query` each use one operation scope before key/query admission, credentials, HTTP, decoding or caller codecs. Additive `getWithSignal(key, signal, codec?)`, `getManyWithSignal(keys, signal, codec?)`, and `queryWithSignal(query, signal)` accept a genuine native `AbortSignal`. Authentic native state is read intrinsically, including exposed fetch signals; caller/provider shadow properties cannot replace it. Caller cancellation returns public runtime `QueryCancelledError` with reason `caller`; timeout returns reason `deadline`. Caller priority precedes elapsed deadline and Close. `close()` is idempotent, aborts owned requests and prevents new reads. It never destroys borrowed fetch or host globals.

One monotonic deadline covers the complete public call, including all sequential GetMany keys, polls, physical partitions, JSON walks, reader release and final codecs. Batch keys and query fields used after I/O are admitted before dispatch. Input iterators/accessors on batch/membership arrays are refused. Results are withheld on any failure; there is no acknowledged successful prefix. Caller codecs intentionally control their own domain conversion/allocation and cannot be safely preempted while synchronously executing. Fresh guards run after they return and before delivery.

Defaults and hard maxima:

| Option | Default | Maximum |
| --- | ---: | ---: |
| `timeoutMs` | 60,000 | 120,000 |
| `maxConcurrent` (no queue) | 4 | 16 |
| `maxKeys` | 100 | 1,000 |
| `maxRows` (aggregate result rows) | 10,000 | 100,000 |
| `maxRequestBytes` (aggregate JSON request bodies) | 65,536 | 1,048,576 |
| `maxResponseBytes` (aggregate decoded response bodies) | 16,777,216 | 33,554,432 |
| `maxPageBytes` | 4,194,304 | 16,777,216 |
| `maxRequests` (submit + status + partition) | 512 | 2,048 |
| `maxPartitions` | 128 | 1,024 |
| `maxColumns` | 512 | 4,096 |
| `maxNodes` (aggregate response JSON values) | 65,536 | 262,144 |
| `maxPolls` | 240 | 1,000 |

`pollIntervalMs` defaults to 250 (zero is allowed for deterministic fixtures), bounded by `timeoutMs`. Headers are capped at 64 KiB/1,024 entries. JSON nesting is capped at 32; duplicate object names, malformed Unicode and non-finite/unsafe integer metadata are refused. JSONv2 result cells remain their exact strings/null, so these metadata-number checks never round native SQL values. Request admission charges every repeated escaped UTF-8 occurrence before allocating the final body. Configured mappings are capped at 256, identifiers at 4,096 code units, batch string IDs at 16,384, filters at 64, orders at 16, membership at 1,000 and total bindings at 1,024. Other limits still apply when a row limit is increased.

Reader cancellation is nonblocking and rejection-safe. Ignored credentials/fetch/read/cancel promises hold their physical admission slot until they actually settle, including late response bodies. There is no unbounded retry queue. Body limits cover adapter-visible decoded streams, not fetch's internal network/decompression allocations, TLS headers before Fetch exposes them, codec heap, total process memory, server scan work or warehouse credits.

A single submission is never retried. Pending `202` and status-GET `429` use the original validated UUID handle and fixed account origin, ignoring server-supplied URLs. Optional later handles must match. Every partition is fetched whole under the same budgets; empty partitions are allowed. Malformed counts/columns/rows/partition counts fail whole before a successful result. There is no persistent cursor or `nextCursor` and no cross-call snapshot guarantee.

The server receives a positive execution timeout in seconds from the remaining original deadline, never `0` (Snowflake defines zero as its maximum timeout). Local cancellation alone is not a proof of remote termination. If a validated owned statement is still pending when caller cancellation, deadline, Close or polling/work exhaustion stops the read, the adapter makes at most one fixed-origin `POST /api/v2/statements/{ownedHandle}/cancel`. That cleanup has its own two-second scope and uses only the submit credential. It does not need a free ordinary admission slot. Ignored cancel requests/readers/late bodies remain physically retained after that local cleanup deadline. A cancel response never replaces the original local failure or retries with another principal.

Only a matching successful CancelStatus can represent server-reported cancellation. Unknown handles, an ignored/expired credential, rejection, malformed replies or cleanup expiry remain unknown/failed. A late submission that never delivered a validated handle cannot be safely guessed or cancelled; its body is cleaned without inventing authority. Completed statements are never cancelled because a later codec fails. This is a protocol implementation and account-free fixture contract, not evidence a hosted warehouse was stopped or a billing cap enforced.

Node is intended for a trusted server with native Fetch (declared Node 22+; executed versions must be reported separately). Verified transport/CA/proxy/decompression policy belongs to the host or supplied fetch; this package does not install a Node agent or silently turn off TLS verification. Pure ESM/DOM type compatibility is separate from actual browser SQL execution. Browser use requires an authorized short-lived credential broker or trusted bridge plus actual Snowflake CORS/account policy; long-lived JWT/private keys stay on the server. No browser auth UI is added.

Mapped existing-table reads are implemented. Dynamic discovery, public arbitrary SQL/native typed-binding APIs, wider numeric ID modes, cursor boundaries, writes and interactive callback transactions remain **not implemented** by this adapter. Snowflake itself supports SQL, writes and configured multi-statement transactions; these adapter gaps are not intrinsic provider limitations. Actual Snowflake execution/authorization/cancellation, warehouse costs, browser CORS/query, Go/CLI integration, installed package/release and Apps are separate unverified gates. This source change has not run hosted tests.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
```

Tooling: pnpm 11.20, TypeScript 6, ESLint and Vitest. The focused check typechecks the adapter, tests and example, runs tests, and builds ESM/declarations. Qualification of this change is pending Root-contained execution and independent review. GitHub default CodeQL is used; no custom CodeQL workflow is included. Packaging follows the [Firestore adapter](../firestore).

Wire references: Snowflake [bindings and submission](https://docs.snowflake.com/en/developer-guide/sql-api/submitting-requests), [polling, partitions and value encoding](https://docs.snowflake.com/en/developer-guide/sql-api/handling-responses), [authentication](https://docs.snowflake.com/en/developer-guide/sql-api/authenticating), [transactions](https://docs.snowflake.com/en/developer-guide/sql-api/using-transactions), [cancelling requests](https://docs.snowflake.com/en/developer-guide/sql-api/cancelling-requests) and [SQL API reference](https://docs.snowflake.com/en/developer-guide/sql-api/reference).
