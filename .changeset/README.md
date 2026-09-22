# Release notes for package changes

Add a changeset for a user-visible change to a published `@dalgo/*` adapter:

```sh
pnpm changeset
```

Select only the packages whose public API or behavior changed and choose the
appropriate patch, minor, or major bump for each. A change to Firestore does
not automatically bump IndexedDB. Documentation-only and internal changes
need no changeset.

The release workflow opens a version pull request from merged changesets.
After that pull request is merged, it publishes the changed packages. See
[the release procedure](../docs/RELEASING.md).
