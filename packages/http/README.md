# ECB daily XML query adapter

`@dalgo/http` implements the first supported slice for the named
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
when filters produce no rows. Raw XML is absent from evidence. The public peer contract requires registry `@dalgo/core >=0.6.0 <0.7.0`.

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
import { ECBQueryExecutor, type ECBQuote } from "@dalgo/http";

// admittedOptions includes a trusted Fetch, executor/collection identity,
// and an independently verified providerReadPlan. It is not learned from XML.
const executor = new ECBQueryExecutor(admittedOptions);
const controller = new AbortController();
const page = await executor.query(
  collection<ECBQuote>("daily").query().where("currency", "==", "AAA").build(),
  { signal: controller.signal },
);
```

Legacy DALgo JOIN/recursive execution continues to refuse rights-annotated pages.
The distinct `executeSourceComposedJoinedDTQLQuery` entry point supports the
reviewed JS-local materialized route. The release gate installs exact registry `@dalgo/core@0.6.0` and the packed HTTP
artifact in an isolated consumer. HTTP uses the verified public registry core
0.6.0 in its workspace lockfile, with a package-specific override that preserves
other adapters' independent core contracts.
The public 0.6.0 artifact exports the materialized source-composition API used
by the synthetic consumer below. The peer floor, workspace lock and release
consumer identity bind to that published version and its registry integrity.
The HTTP-only patch changeset produces version 0.1.1 in a reviewed version PR;
changing package visibility alone does not satisfy the changed-version release gate.
Registry discovery alone does not establish live query eligibility.

Validation uses fabricated XML/terms only: package tests use test-only jsdom.
`pnpm --filter @dalgo/http check` runs those tests and declaration build.
After build and fixture compilation, the native harness runs actual
`ECBQueryExecutor`, native Fetch/DOMParser and the separate materialized composer
against invented XML and currency descriptors. Run with Node 24:

```sh
pnpm install --frozen-lockfile
pnpm --filter @dalgo/http check
pnpm --filter @dalgo/http run check:clean-output
pnpm --filter @dalgo/http exec tsc -p tsconfig.browser-fixture.json
node packages/http/scripts/browser-smoke.mjs
```

Supply
`PLAYWRIGHT_MODULE` for an existing Playwright module and optionally `CHROME_PATH`
for installed Chrome. The harness owns two ephemeral loopback listeners and a
fresh browser context; both listeners and the browser close in `finally`, and
all non-fixture requests and service workers are blocked. Native ESM resolution
from HTTP's scope selects its registry core 0.6.0 import-only entry, never the root's
older core. A local import map serves that core, HTTP dist and the same core's
YAML browser entry/subtree from allowlisted installed package paths. No CDN or
bundler is involved. The typed helper under `test` compiles to ignored
`.browser-fixture-dist`, outside package exports and public `dist`.

The official HTTP check and standalone lint each build public exports before
typed lint resolves the fixture's self-package import. `check:clean-output` copies source,
tests and config into an owned temporary directory without `dist` or fixture
output, reuses installed dependencies, runs standalone lint and the official check
from separately clean output state and removes the copy in `finally`. CI runs this
regression even when earlier steps have built
the workspace; no committed or cached output can satisfy its bootstrap check.

The trusted test-only Fetch rewrites only the exact admitted ECB URL to the
second loopback origin, substitutes `Response.url`, and retains native CORS.
That declared identity is deliberately synthetic; the harness never sends a
network request to ECB. It tests normal, projected-away, empty local, WHERE-empty
and LEFT/null results, direct filtered-empty evidence, native CORS refusal,
malformed XML, changed/missing admission evidence, mutation, bounds and raw
unsupported-sink refusal. The receipt asserts exact loopback request counts
and `providerRequests: 0`.

The local executor admits exactly the fixed descriptor collection, no parent or
codec, empty filters/orders, no cursors, zero/absent offset and its fixed
positive limit (complete array length, or 1 when empty). It detaches/freezes
known literal rows and returns no cursor. Omitted rights are explicitly admitted
as `unknown-local`, never inferred as permission. ECB's complete scan is
unfiltered limit 256 with `ecb-full-decoded-feed`, scoped only to the decoded
fabricated feed. Native currency/date/decimal strings retain their meanings;
no EUR synthesis or conversion occurs.

The transient viewer validates/snapshots composition before row access and uses
`textContent` to show rows, original notices, rights status and source scopes,
even for zero rows. Unsupported sink callbacks refuse raw composition presence
before row getters or dispatch; no storage handler is implemented. Core budget
defaults are tightened for this fixture to 512 fetched/result rows, 128 KiB
retained and 32 KiB metadata. Legacy guards and the OVDB raw-field refusal stay
intact. No Go/OVDB roundtrip, persistence, public API facade, registry activation
or end-to-end join cancellation is implied. Real ECB CORS, availability, rights
admission and host configuration remain separate deployment gates. Release readiness does not establish live provider admission.

Public release validation runs `prepare-http-release.mjs pack`,
`check-http-tarball.mjs`, then `prepare-http-release.mjs verify` on the same
bytes. The consumer requires one registry core, the packed LICENSE, typed public
imports under both Node 20 and Node 24, public runtime imports, synthetic local
composition and pre-request refusal proofs bound to the same artifact, and the
synthetic native browser fixture. The immutable receipt requires both runtime
versions, source identity and artifact hashes. `release.yml` is the HTTP
publication route; the manual browser publisher remains limited to Firestore and
IndexedDB. HTTP package ownership and its own npm trusted publisher must be
verified separately before authorized publication.
