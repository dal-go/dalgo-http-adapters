# Private ECB XML query adapter

`@dal-go/dalgo2http` is a private first implementation slice for the named
`ecb-eurofxref/1` daily XML contract. It implements DALgo `QueryExecutor` with
native string fields `time`, `currency`, and `rate`, and currency record IDs.
It supports string equality filters and a positive limit of at most 256.
Ordering, offsets, cursors, collection groups, nested collections, reads by ID,
mutations, snapshots, joins and recursive queries are outside this adapter.

The decoder follows the existing [DALgo Go decoder](https://github.com/dal-go/dalgo2http/blob/3c73adb7b395e1b180c674ab57f67cca8cba8de4/ecb_xml.go):
closed namespaces/hierarchy/attributes, one reference date, unique three-letter
non-EUR currencies, positive decimal strings, at most 256 quotes, strict UTF-8,
no DTD/entity references or foreign processing instructions. Subject and sender
presentation elements are optional. The browser's native XML well-formedness
checks can be stricter than Go's XML declaration handling. XML nodes and parser
errors are never inserted into a page. Production requires Window `DOMParser`;
a host enforcing Trusted Types must supply its reviewed policy/parser wrapper.
No DOM polyfill is shipped.

Every query requires an independently verified `ProviderReadPlan`, one direct
execution, one exact GET to `ECB_DAILY_URL`, an immutable definition/decoder
binding, and one matching rights source. Admission must precede construction;
this package's structural checks do not establish permission or publisher trust.
It validates the core's plan/digest/rights/budget rules before HTTP using a
private discarded validation probe, then validates only the actual observation
before returning records. All rights and read metadata are detached, including
when filters produce no rows. Raw XML is absent from evidence. The core version
is pinned only for this private package to the reviewed 0.5.0 source API.

The injected Fetch must be trusted and honor the request. Every query performs
a fresh bounded GET with `mode: cors`, `cache: no-store`, `redirect: error`, and
`credentials: omit`; there is no retry, fallback, persistence or adapter cache.
The whole HTTP/body deadline is 10 seconds by default (maximum 30), responses
are limited to 2 MiB, and the caller can cancel with an AbortSignal. Parsing is
synchronous after the input bound and cannot be interrupted mid-DOMParser call.
Response MIME must be XML. Browser-visible optional headers are bounded through
core evidence validation. No secret, authorization or custom cache headers are
sent. The fixed daily feed's real CORS, availability, rights admission and
Trusted Types host configuration remain deployment gates; they were not tested
against ECB. `no-cors` opaque responses cannot enable this path.

```ts
import { collection } from "@dalgo/core";
import { ECBQueryExecutor, type ECBQuote } from "@dal-go/dalgo2http";

// admittedOptions includes a trusted Fetch, executor/collection identity,
// and an independently verified providerReadPlan. It is not learned from XML.
const executor = new ECBQueryExecutor(admittedOptions);
const controller = new AbortController();
const page = await executor.query(
  collection<ECBQuote>("daily").query().where("currency", "==", "AAA").build(),
  { signal: controller.signal },
);
```

DALgo core currently refuses rights-annotated pages in JOIN/recursive execution.
Keep that gate: single-feed execution is available here, while federated joins
require separate rights-aware core composition work. Registry discovery alone
does not establish live query eligibility.

Validation uses fabricated XML/terms only: package tests use test-only jsdom.
`pnpm --filter @dal-go/dalgo2http check` runs those tests and declaration build.
After build, `node packages/http/scripts/browser-smoke.mjs` runs a native
Chromium XML and actual loopback cross-origin CORS pass/fail smoke. Supply
`PLAYWRIGHT_MODULE` for an existing Playwright module and optionally `CHROME_PATH`
for installed Chrome. The harness owns two ephemeral loopback listeners and a
fresh browser context; both listeners and the browser close in `finally`, and
all non-fixture requests are blocked. This is synthetic browser evidence only,
not a real ECB request or npm publication. Independent review is pending.
