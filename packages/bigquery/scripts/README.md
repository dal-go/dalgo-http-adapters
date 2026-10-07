# Native synthetic metadata acceptance

Build and check `packages/bigquery` from a cold checkout, then run the standalone
smoke with Node24 and explicit existing browser runtimes:

```sh
pnpm --filter @dalgo/bigquery check
PLAYWRIGHT_MODULE=/absolute/installed/playwright/index.mjs \
CHROME_PATH=/absolute/owned/chrome \
node packages/bigquery/scripts/browser-smoke.mjs
```

The smoke refuses absent runtimes/build output; it does not install dependencies
or silently skip. Existing CI covers package checks, not this browser command.
Its separately executed receipt is required for this slice's local acceptance;
mandatory native CI provisioning remains a separate follow-up. The script owns
two ephemeral loopback listeners, fresh isolated browser contexts and headless
Chrome; nested `finally` blocks close the browser and both listeners.

Native ESM imports the built public `/analytical` export. The private fixture
helper stays in `scripts`, outside public `dist` and the package `files` list.
No core/YAML mapping, public API/version/range, dependency/lock, release or shared
workspace change is needed. PR15's manifest/changelog/changeset lane and IndexedDB
remain separate.

The existing `MetadataFixtureHarness` runs the actual identity and metadata
clients. Exact fixed logical Google discovery/UserInfo/dataset/table URLs rewrite
only to fabricated JSON on the other loopback origin. Native fetch enforces real
preflight/CORS and redirect refusal; no physical Google URL is dispatched.
Discovery has no Authorization; UserInfo/metadata GETs have only the expected
synthetic token. Unknown paths, methods, query parameters and headers refuse.
Fresh contexts and zero-age preflights make per-case GET/OPTIONS counts explicit.
Allowed traffic is not intercepted by Playwright, since broad route interception
suppresses native preflights. A restrictive CSP allows scripts only from the app
origin and fetch only from the fixture origin; a native policy-violation negative
proves an external fetch is blocked before dispatch. Chrome also has a fail-closed
DNS rule for non-loopback names. The test observes every browser request and
rejects unexpected local paths; receipts never retain request headers or bodies.
Native cases have a 20-second watchdog in addition to production request bounds.

The vendored golden fixes clock/schema/provenance. A stable synthetic subject
without email succeeds; partial grants, missing subject, wrong discovery
issuer/endpoint and denied identity refuse before metadata. Cases also cover
independent owner consent, synchronous invalidation before/in flight and after
hashing, expiry, deadlines, malformed/oversized responses, redirects, CORS and
exact allowlists. Browser persistence is instrumented to refuse writes. Private
owner, subject, token and selected future project never enter public output,
errors or receipts; the public source-project locator remains part of the golden.

The exact `PublicMetadataObservation` envelope is unchanged and has no admission
fields. “Query activation blocked” is a separate fixture presentation label.
Receipts are synthetic acceptance only: no real GIS/OAuth, deployed provider CORS,
IAM, package publication/adoption, rights/semantic admission, billable jobs, rows,
copies/snapshots or provider result-materialization authorization is proved.

## Native synthetic analytical execution acceptance

After `pnpm --filter @dalgo/bigquery check`, run the separate analytical smoke
with Node 24 and the same explicit Playwright and Chrome runtime variables:

```sh
PLAYWRIGHT_MODULE=/absolute/installed/playwright/index.mjs \
CHROME_PATH=/absolute/owned/chrome \
node packages/bigquery/scripts/analytical-browser-smoke.mjs
```

This test imports the built public `/analytical` entry in native Chrome. A
synthetic GIS token callback is verified through the production Google identity
provider's fixed discovery and UserInfo URLs. The analytical client uses a
protected test preparation callback and the browser's `IndexedDBLedger`. Exact
logical Google URLs are rewritten only to a loopback fixture origin; native
`fetch` still performs authorization preflights and CORS checks. The success
case observes metadata, two dry runs and one capped synthetic submission,
delivers one synthetic row, and confirms the ledger did not retain the cell.
The denial case removes CORS permission at the first dry-run preflight and
confirms that no POST, approval, or run occurred. Browser requests outside the
two owned loopback origins fail. The script closes Chrome and both ephemeral
listeners even when an assertion fails.

Its receipt establishes a source-local network/browser acceptance seam only.
It does not exercise a real Google OAuth client, Google endpoint or job, IAM,
deployed CORS, provider result retention, or source rights. Synthetic fixtures
are not source snapshots or claims about live BigQuery data.
