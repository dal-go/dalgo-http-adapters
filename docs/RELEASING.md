# Releasing DALgo adapters

The published packages in this workspace are `@dalgo/firestore` and
`@dalgo/indexeddb`. They have independent versions. Every other adapter is
currently private in its package manifest and is excluded from Changesets
publishing. Remove `private: true` only as part of preparing that adapter for
its first npm release.

For a user-visible change, add a changeset in the same pull request:

```sh
pnpm changeset
```

Select the changed package and its patch, minor, or major bump. Select both
packages only when both changed. Changesets adds individual changelog entries
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
`firestore@v<version>` or `indexeddb@v<version>` at that exact commit. A
release for one package leaves the other's version unchanged.

Publishing uses npm trusted publishing through GitHub Actions. The npm settings
for **each** published package must authorize GitHub repository
`dal-go/dalgo-http-adapters` and workflow `release.yml`. The workflow uses
Node 24, npm 11.11.0, and `id-token: write`; it contains no long-lived npm
token. Configure trusted publishing before merging a version pull request.
The existing [manual tagging workflow](../.github/workflows/tag-published-package.yml)
can reconcile a successfully published version if automated tagging fails.
If publishing itself fails, manually run **Release packages** with the exact
merged version pull request's commit SHA in `release_sha`. The workflow checks
that this commit belongs to `main` and was produced by the merged version pull
request, then safely retries publication and tagging. Do not use a later
unrelated commit SHA.

`@dalgo/core` is released from the separate `dalgo-js` repository. A new
core release does not automatically bump adapter versions or peer dependency
ranges across repositories. Change an adapter's `@dalgo/core` peer range and
add an adapter changeset when its compatibility contract changes.
