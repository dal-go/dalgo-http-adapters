# Releasing DALgo adapters

The public package manifests in this workspace are `@dalgo/adapter-runtime`,
`@dalgo/dalgo2couchdb`, `@dalgo/dalgo2libsql`, `@dalgo/dalgo2postgrest`,
`@dalgo/dalgo2typesense`, `@dalgo/firestore`, `@dalgo/indexeddb`,
`@dalgo/bigquery`, `@dalgo/http`, `@dalgo/ovdb`, `@dalgo/sqlite-sql`,
`@dalgo/sqlite-wasm` and `@dalgo/d1`. They have independent
versions; a public manifest does not establish npm availability. Every other
adapter is currently private in its package manifest and is excluded from Changesets
publishing. Remove `private: true` only as part of preparing that adapter for
its first npm release.

For a user-visible change, add a changeset in the same pull request:

```sh
pnpm changeset
```

Select the changed package and its patch, minor, or major bump. Select multiple
packages only when each changed. Changesets adds individual changelog entries
and version bumps; it does not make all adapters share one version. Use
`pnpm exec changeset status` to inspect pending bumps.

After the change reaches `main`, [Release packages](../.github/workflows/release.yml)
opens or updates a `changeset-release/main` version pull request. Review its
package versions, changelogs, and dependency ranges, and wait for its CI check
before merging it. The release workflow explicitly dispatches CI on this branch
because GitHub does not start ordinary pull-request workflows for branches
updated by `GITHUB_TOKEN`. The
workflow publishes only package versions changed by that merge, using direct
`npm publish` for trusted publishing. It then verifies each version's npm
`gitHead` and creates
`<package-directory>@v<version>` tags (for example `adapter-runtime@v<version>`,
`couchdb@v<version>` or `firestore@v<version>`) at that exact commit.
A release for one package leaves other package versions unchanged.

The four native adapters use the npm identities `@dalgo/dalgo2couchdb`,
`@dalgo/dalgo2libsql`, `@dalgo/dalgo2postgrest` and `@dalgo/dalgo2typesense`.
The GitHub owner and source repository remain `dal-go/dalgo-http-adapters`.
A namespace correction alone does not select a package for publication: the
publisher selects manifest-version changes. The recovery changeset therefore
requests ordinary patch releases for these four packages, the shared runtime,
Firestore and OVDB. Review the newly generated version pull request and its CI
before publication; source changes and pending bumps do not establish a release.

Publishing uses npm trusted publishing through GitHub Actions. The npm settings
for **each** published package must authorize GitHub repository
`dal-go/dalgo-http-adapters` and workflow `release.yml`. The workflow uses
Node 24, npm 11.11.0, and `id-token: write`; it contains no long-lived npm
token. Configure trusted publishing before merging a version pull request.

The corrected direct bootstrap procedure below is **not executed end to end**;
human MFA and npm bootstrap/trusted-publisher acceptance remain pending. Local
Linux package checks validate source and artifacts only; they do not establish
npm bootstrap publication or trusted-publisher acceptance.

A package's first publication requires separately verified namespace authority
and package-specific trusted-publisher setup. For an explicitly approved direct
bootstrap, prepare a separately reviewed placeholder artifact with version
`0.0.0-bootstrap.0` and publish it under `--tag bootstrap`. Keep it separate from
the real release artifact, the version pull request's versions and `latest`.
Do not change repository release versions to create this placeholder.

This direct bootstrap is distinct from [npm staged publishing](https://docs.npmjs.com/staged-publishing/):
`npm stage publish` submits an artifact for maintainer approval, and npm itself
creates `0.0.0-stage` when the package is new. Do not manually publish a
`0.0.0-stage` artifact. A historical version with that name alone does not
establish how it was created. This repository's reviewed version releases
continue to use direct OIDC `npm publish` through `release.yml`.

An E403, including "You cannot publish using the version", does not establish
success. Preserve the attempted artifact and inspect exact public registry
metadata before any retry or version change. Verify the expected package name,
version, bootstrap dist-tag, tarball URL and integrity; download the public
tarball, compare its SHA512 with the reviewed local artifact and inspect its
manifest and file inventory. Retain those receipts before claiming publication,
and verify owner/access and trusted-publisher settings separately before claiming
publication authority. If metadata is missing, conflicting or still processing,
keep the result unresolved; do not blindly republish or select another version.
Never bootstrap with a version the version pull request will release: npm
versions are immutable, and CI still requires the exact reviewed release
commit's `gitHead`, artifact integrity and provenance.
The existing [manual tagging workflow](../.github/workflows/tag-published-package.yml)
can reconcile a successfully published version if automated tagging fails.
If publishing itself fails, manually run **Release packages** with the exact
merged version pull request's commit SHA in `release_sha`. The workflow checks
that this commit belongs to `main` and was produced by the merged version pull
request, then safely retries publication and tagging. Do not use a later
unrelated commit SHA. The publish loop processes the shared runtime first, then
CouchDB, libSQL, PostgREST, Typesense, Firestore, IndexedDB, BigQuery, HTTP, OVDB,
SQLite SQL, SQLite WASM, then D1 and stops on the first failure. Before merging a BigQuery-only version
pull request, verify its manifest-version diff changes only BigQuery. If earlier
packages also change, their publication and tag gates must be resolved before
that merge; retrying the same SHA repeats an earlier package failure.

BigQuery package compatibility checks use the published `@dalgo/core@0.1.0`
baseline. The release workflow tests an external strict-peer consumer of the
exact packed artifact on Node 20 and 24, retains its SHA256/SRI and source SHA,
then publishes those same tarball bytes. Owner authorization and package-specific
trusted publishing remain release gates.

For a preliminary packed-artifact check, build and pack with Node 24, then run
`.github/scripts/check-bigquery-tarball.mjs <tarball> <fresh-external-directory>
<node-20.0.0-binary> <node-24-binary>` with Node 24. The checker installs exact
registry core with strict peers, checks declarations and both exports, runs the
existing synthetic corpus, SQL, metadata/consent and TIMESTAMP fixtures against
the packed production package on each runtime, and writes an artifact receipt.
It uses a Node-20-compatible test runner without changing workspace tooling.
The release workflow runs this checker against its retained packed artifact;
a standalone local check does not establish publication.

`@dalgo/core` is released from the separate `dalgo-js` repository. A new
core release does not automatically bump adapter versions or peer dependency
ranges across repositories. Change an adapter's `@dalgo/core` peer range and
add an adapter changeset when its compatibility contract changes.

HTTP uses the controlled npm organization scope and package name `@dalgo/http`;
the GitHub source repository remains `dal-go/dalgo-http-adapters`. Its independent
version changeset, release selection and `http@v<version>` source tags use that
exact package identity. Before publication, the release workflow packs once,
tests the retained tarball with registry `@dalgo/core@0.6.0` on Node 20 and 24
and in the native synthetic browser fixture, then reverifies source SHA,
package identity, SHA256 and SRI immediately before publication. Synthetic
checks make no provider requests. Package bootstrap and package-specific
trusted publishing remain external gates; a public manifest or reviewed local
tarball does not establish npm availability.

The query-only `@dalgo/ovdb` root and `./tugql` release uses an isolated `dist-tugql` inventory and exact tested tarball. The clean consumer verifies both exports, forbidden legacy imports, released registry core 0.6.0, 0.8.0 and 0.8.1, exact Node 20.0.0, Node 24 and Chromium with authored synthetic responses and no provider requests. Publication does not activate the public provider route; separately pinned public-free admission and Cloud/Directory acceptance remain required. First npm publication also requires an authorized bootstrap before trusted-publisher settings can be configured; a registry 404 does not prove namespace ownership or publication authority.
