# @dal-go/dalgo2typesense

A bounded, read-only native [Typesense](https://typesense.org) adapter for the
modern [`@dalgo/core`](https://github.com/dal-go/dalgo-js) TypeScript contracts.

It reads documents already stored in one existing Typesense collection. It does
not create collections, write documents, manage keys, expose an admin endpoint,
or require a DALgo envelope. The Typesense document `id` is always a string and
is the DALgo record key, so `"001"` and `"1"` remain different records.

This package is an independent MIT-licensed HTTP client. It does not link,
embed, copy or redistribute the Typesense server or SDK. The real-service test
fixture uses the GPL-3.0 Typesense server only as a disposable test dependency.

## Usage

```ts
import { collection } from "@dalgo/core";
import { TypesenseDatabase } from "@dal-go/dalgo2typesense";

// One per-physical-request callback. A pure `documents:search` credential can
// search and read exact ids; a separately scoped read-only credential with
// `collections:get`/`list` is used by a second adapter instance when schema
// metadata is genuinely needed. There is no separate metadata option, no
// fallback and no admin upgrade.
const db = new TypesenseDatabase({
  baseUrl: "https://typesense.example.com:8108",
  collection: "books",
  headers: () => ({ "X-TYPESENSE-API-KEY": searchKey }),
});

const books = collection<{ title: string; year: number }>("books");
const page = await db.queryWithSignal(
  {
    ...books.query().where("year", ">=", 1965).limit(20).build(),
    projection: ["title", "year"],
  },
  signal,
);
```

`queryWithSignal` is the additive shared cancellable surface. The caller signal
and one adapter deadline cover header acquisition, fetch, body reading and every
verification/page step. Verification yields a real macrotask on a bounded,
operation-wide work budget, so a caller timer can abort a large buffered
verification instead of waiting behind a microtask chain. A caller abort,
adapter deadline or `close()` rejects with the canonical `QueryCancelledError`;
the producer never copies `AbortSignal.reason`, a transport error or a response
body into the message.

## Typed native search

Native search is a separate, typed, bounded surface. It keeps Typesense typo,
prefix and drop-token semantics, and it never accepts a raw URL, arbitrary
option bag, management endpoint, multi-search, join or RPC call.

```ts
const result = await db.searchWithSignal({
  q: "Neuromancr",
  queryBy: ["title", "author"],
  filterBy: "genre:=`cyberpunk`",
  sortBy: [{ field: "year", direction: "desc" }],
  facetBy: ["year"],
  maxFacetValues: 10,
  limit: 20,
}, signal);
```

Facet values, counts and statistics are the server's real native values (an
optional server `highlighted` string is retained). A cutoff, short page or
`found` mismatch is reported as `partial`/`truncated`; it is never turned into a
clean end-of-data claim.

### Native full-text score

An ordinary native full-text query (`q != "*"`) returns the server's uint64
`text_match` wrapper as an **exact decimal string** in
`TypesenseNativeSearchHit.textMatch`. Typesense serialises a ranking such as
`578730123373578361`, which a JavaScript `number` would round. The raw response
scanner therefore admits one unsafe integer only at the exact
`hits[].text_match` protocol path (validated as an unsigned uint64), preserves
its decimal lexeme, and cross-checks the server's
`text_match_info.score` counterpart. Every application document value, facet
identity or other JSON number still has to round-trip losslessly and is refused
before codec, record or cursor exposure. There is no generic unsafe-number
exemption and no rounding.

Every read path — structured, native, point and batch — sets
`enable_curations=false` and `filter_curated_hits=true`. A curated or pinned
document cannot bypass `filter_by`, and the request types offer no override.

## Structured query subset

The adapter accepts the core `StructuredQuery` shape plus two approved,
provider-local additions:

```ts
interface TypesenseQuery<T> extends StructuredQuery<T> {
  where?: TugQLCondition;     // ANDed with the flat filters array
  projection?: readonly string[];
}
```

Admitted:

- one unqualified top-level collection, `q=*`;
- positive scalar `==`;
- `in` over a homogeneous non-empty scalar list;
- `<`, `<=`, `>`, `>=` only when the real collection schema declares the field
  as scalar `int32`, `int64` or `float`;
- bounded `AND`/`OR` groups in `where` plus flat filters;
- explicit safe sort fields (`sort_by`, at most three, no invented `id` sort);
- an exact projection of unique top-level fields.

Refused before I/O:

- joins, nested/collection-group sources, grouping, aggregation, subqueries,
  computed expressions, wildcard projections and qualified fields;
- null tests and null comparisons;
- **all negative structured predicates**: `!=`, `not-in`, and any negated
  group. Native negative string folding is not a safe candidate superset: it can
  omit a row the exact predicate would keep, and the verifier cannot repair a
  false negative;
- `array-contains` and `array-contains-any`, because the pinned TypeScript core
  has no established exact array-membership contract for these operators;
- empty/control/backtick-containing filter strings and unsafe numbers.

The native filter is only a **candidate producer**. The exact verifier evaluates
the same admitted tree with the pinned TypeScript core semantics: `in` compares
the entire left operand with each item by strict equality, a missing/null
comparison is UNKNOWN, and `AND`/`OR` short-circuit with three-valued truth.
Every candidate in the complete bounded prefix is verified before any row or
cursor is exposed. Any mismatch is a typed
`TypesenseSemanticError` (also a core `UnsupportedError`), never silent local
filtering, a returned prefix, a retry or a broader scan.

Filtered reads fetch the whole candidate window from offset zero through
`offset + limit`, including a requested filtered offset, verify it, and only then
apply the offset locally. This is why a later-page mismatch cannot leave an
apparently successful earlier prefix.

An unfiltered read whose DALgo limit is larger than the configured
`maxRowsPerPage` (and the absolute 250-row Typesense page cap) is served by
bounded physical paging. If the required physical page/window work would exceed
`maxQueryPages`/`maxQueryOffset`, the query is refused before I/O rather than
silently truncated or sent as one oversized page.

### Numeric candidates and documented differences

Typesense indexes `float` values in quantised buckets. A strict native `>` or
`<` can omit a raw value that the exact predicate would keep. Structured strict
ranges therefore use the inclusive `>=`/`<=` candidate with the **same wire
literal**, and the verifier still applies the original strict operator. A
boundary candidate that fails is a typed refusal, not a silent drop.

TypeScript compares only finite JavaScript numbers losslessly. Integers must be
safe integers; the adapter refuses non-roundtripping JSON before `JSON.parse`,
never coerces strings/BigInts into numbers, and never turns an unsafe int64 into
a `number`. Unlike the Go adapter, this is not a full int64/uint64 subset: values
such as `9007199254740993` are refused rather than represented. Arrays, objects,
booleans and null are not stringified.

The Go implementation also matches scalar `IN` against array elements; the
TypeScript core does **not**. This adapter follows TypeScript: an array-valued
left operand does not satisfy a scalar `IN`. If another `OR` branch makes the
whole condition true, the row is admitted; otherwise the row is refused. There
is no claim of Go overlap parity.

## Point and batch reads

`get` and `getMany` use one bounded exact-id search, never a management
document endpoint and never a metadata request:

```
filter_by=id:=[`001`,`1`]
```

Requested key order and duplicates are preserved; an absent id is an honest
`{ key, exists: false }`. Ids containing a backtick are refused before I/O
because a Typesense filter literal cannot escape one. A cutoff, inconsistent
`found` count or budget failure is a refusal, not a false "not found".

## Pagination and cursors

A non-empty page that may have more rows carries one opaque, adapter-issued,
single-use handle in `nextCursor.values`. The handle is bound to the endpoint,
collection, exact compiled query, projection, sort, page size, filtered/unfiltered
mode and credential scope (or the explicit non-secret `identityScope`).

- A foreign, malformed, already-used or changed-query handle is refused.
- Identity binds the **exact admitted predicate AST**, including original
  operators and literal classes, not only the rendered native candidate filter.
  Typesense widens `>`/`<` to `>=`/`<=`, so `>n` and `>=n` can render the same
  native filter; their handles are still different and swapping them is refused.
- The handle is leased only after every remaining planning bound passes. It is
  committed only after a successful page, including codec decoding. A canceled
  or failed attempt releases the lease and can retry the same handle.
- A page that has more rows but whose next position would exceed a configured
  offset/window/page bound is refused explicitly with
  `TypesenseContinuationBoundError`; an unusable handle is never returned.
- The registry, token bytes and conserved handles are bounded.
- Filtered continuation re-verifies the entire prefix from zero on every page.

Pagination is **offset based**. It is not a snapshot: concurrent inserts,
updates, deletes or a changed sort value can move rows between pages. Typesense
does not provide a stable cursor here, and the adapter does not invent an `id`
sort or claim snapshot isolation. Use explicit sort fields where order matters.

## Metadata

`schema()`, `listCollections()`, `testConnection()` and `describe()` make
read-only metadata requests through the same `headers` callback as every other
request. A pure `documents:search` adapter instance cannot read metadata and is
denied explicitly; a second instance with a scoped read-only credential that
carries `collections:get`/`list` can. There is no separate metadata option and no
admin fallback.

They report the real collection schema, keeping native array types such as
`string[]` in `field.type`. Typesense 30.2 always emits
`default_sorting_field`; a collection created without one reports the empty
string, which the adapter accepts as an honest sentinel rather than a malformed
schema (it is not a sorting guarantee). The implicit `id` is reported exactly
once as a non-nullable string, including when the server marks an explicitly
declared `id` as optional. A 401/403/404 is an explicit `unavailable` reason with
its status, never an empty list and never an admin fallback.

A pure `documents:search` key can search and read exact ids but cannot read
metadata. Numeric-range structured queries need readable schema to prove the
field type; without it they are refused rather than guessing.

## Bounds and lifecycle

Every operation has one deadline, one page budget, one per-response byte bound
and one cumulative response-byte bound. Rows have a full pre-projection JSON
size bound, requests have an encoded byte bound, filters/projections/sorts/
facets have explicit maxima, and `getMany` has key and retained-byte bounds.
Exhausting a budget stops further HTTP and fails the operation; it never returns
a partial success. Removing adapter ownership is explicit: every listener the
operation registered on the container or the shared root is removed on success,
error, cancellation and `close()` alike, so completed operations are not
retained and an in-flight operation still observes `close()`.

`close()`/`dispose()` is idempotent. It cancels owned operations, retires issued
cursors and rejects new work. A caller-supplied `fetch` is never mutated; the
default is `globalThis.fetch.bind(globalThis)`, including in a real browser.

Transport requires HTTPS. Plain HTTP is accepted only for an explicit loopback
host (`localhost`, `127.0.0.1`, `[::1]`) with
`allowInsecureLoopbackHttp: true`. Redirects are refused so a credential cannot
be forwarded to another origin. Header values are validated and never logged.

## Scope

This package is an adapter/SDK slice. It does not claim DataTug web UI, CLI or
hosted Typesense support, npm publication, or any application integration.
Direct browser execution needs a CORS-enabled deployment and an appropriately
scoped credential; short-lived scoped search keys are the intended browser
posture. A trusted Node/server runtime can keep the key server-side.
