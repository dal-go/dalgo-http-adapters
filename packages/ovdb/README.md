# OpenVaultDB TugQL executor

`@dalgo/ovdb` exposes the query-only `OpenVaultDbTugQLQueryExecutor` at both the package root and `@dalgo/ovdb/tugql`. Requires Node >=20 or a browser with Fetch and Web Crypto, and `@dalgo/core` `>=0.6.0 <0.7.0` (the npm package; a GitHub-path install of this source accepts `>=0.6.0 <0.9.0`, which includes the 0.8 TugQL release; see below).

The first native profile accepts one `daily` collection query, zero through ten flat string equality filters on `time`, `currency` and `rate`, and a limit of 1–50 (default 50). It preserves native lexical strings, validates one independently admitted source read and full immutable rights metadata, and returns `complete: true` only after bounded JSON reaches EOF and evidence passes. Completion describes a bounded query, not complete source inventory.

The trusted host supplies the exact endpoint, current independently pinned public admission, complete SourceRight, plan and browser origin. URL presence, matching response digests or registry discovery never grant permission or configure the executor. Production activation requires separate public-free admission and activation, origin/host verification and service cost controls. No production factory or authorization is included.

Create `createOpenVaultDbExecutionBudget()` **before** asynchronous admission, then call `createOpenVaultDbExecutionId(owner.budget)` once to issue the fresh nonce for that exact owner. Plan validation refuses a copied nonce under a different owner; weak ownership maps retain no global nonce history. Pass its exact frozen `budget` through plan validation, construction, query, evidence validation and final output handoff; generic `QueryExecutor.query(query)` uses that prebound signal. Use `raceOpenVaultDbExecutionBudget` around owned admission/evidence awaits and `assertOpenVaultDbExecutionBudget` immediately before releasing output. Keep the owner alive after adapter return, then call `owner.dispose()` in a final handoff `finally`; cancellation calls `owner.cancel()`. Each owner has one absolute ten-second monotonic deadline, which cannot be extended or reset.

One executor makes at most one POST. Fetch omits credentials and referrers, refuses redirects and uses no-store. The npm package has no bearer client, database, CRUD, direct provider fallback, history, cache or persistence API. A server-only attestation authenticates the deployed route; browser digest validation does not independently authenticate provider bytes or establish legal clearance. The browser relies on the route's duplicate-member JSON refusal before parsing its completed output.

Development keeps legacy adapter tests workspace-private. Only `dist-tugql`, README and LICENSE are packed into the npm tarball (the source tree's `dist` CRUD client is not), and release gates test those exact immutable tarball bytes under Node 20.0.0, Node 24 and Chromium. First publication and npm namespace/trusted publisher setup are external release prerequisites; this source change does not publish or activate provider access.

## CRUD client (`@dalgo/ovdb/client`): GitHub-path install only, not in the npm package yet

The npm release of `@dalgo/ovdb` does not contain this subpath: importing `@dalgo/ovdb/client` from an npm install fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. It is available only when installing this repository from GitHub, as described below, until a release gate covers it.

In the repository source the subpath `@dalgo/ovdb/client` exports the CRUD `OpenVaultDbDatabase` (a DALgo `Database`) and `OpenVaultDbHttpError`; fetch is injectable via the `fetch` option. It ships from `dist/` and is independent of the TugQL executor, whose `.` and `./tugql` exports are unchanged.

```ts
import { OpenVaultDbDatabase, OpenVaultDbHttpError } from "@dalgo/ovdb/client";

const db = new OpenVaultDbDatabase({ baseUrl, databaseId, accessToken, fetch });
```

### Installing from GitHub (before a release)

Pin `@dalgo/core` and this package from GitHub in the consuming project (pnpm 11). `<sha>` is a dal-go/dalgo-http-adapters commit that contains the `./client` export:

```jsonc
// package.json
"@dalgo/core": "github:dal-go/dalgo-js#24eb5b7ef8f044c274cb33beda353b2413e17c42",
"@dalgo/ovdb": "github:dal-go/dalgo-http-adapters#<sha>&path:/packages/ovdb"
```

```yaml
# pnpm-workspace.yaml: the GitHub tarballs build themselves on install
allowBuilds:
  '@dalgo/core@https://codeload.github.com/dal-go/dalgo-js/tar.gz/24eb5b7ef8f044c274cb33beda353b2413e17c42': true
  '@dalgo/ovdb@https://codeload.github.com/dal-go/dalgo-http-adapters/tar.gz/<sha>#path:/packages/ovdb': true
```

The package's `prepack` runs `npm run build`, which emits both `dist` and `dist-tugql`.
