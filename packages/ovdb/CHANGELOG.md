# @dalgo/ovdb

## 0.3.2

### Patch Changes

- df4e5f2: Prepare a fresh coordinated release after correcting the four unpublished native adapter package names to the `@dalgo` npm scope. Include the shared adapter runtime, Firestore and OVDB in normal version-change publication so the complete prepared compatibility batch can be released through the reviewed version pull request.

## 0.3.1

### Patch Changes

- Publish the query-only TugQL adapter with the source's `@dalgo/core` peer range `>=0.6.0 <0.9.0`, retaining strict immutable-artifact checks against registry core 0.6.0 and adding core 0.8.0 and 0.8.1 under Node 20, Node 24 and Chromium. Include the existing `yaml` 2.8.3 security update.

## 0.3.0

### Minor Changes

- 6d57d69: Rename DTQL to TugQL in the query-only executor. This is a breaking release with no aliases: the `@dalgo/ovdb/dtql` subpath is now `@dalgo/ovdb/tugql`, the packed output directory `dist-dtql` is now `dist-tugql`, and every exported name moves from `OpenVaultDbDTQL...` to `OpenVaultDbTugQL...` (`OpenVaultDbDTQLQueryExecutor` is `OpenVaultDbTugQLQueryExecutor`, `validateOpenVaultDbDTQLPlan` is `validateOpenVaultDbTugQLPlan`, `validateOpenVaultDbDTQLEvidence` is `validateOpenVaultDbTugQLEvidence`, `OpenVaultDbDTQLQueryOptions` is `OpenVaultDbTugQLQueryOptions`, `OpenVaultDbDTQLPlanConfiguration` is `OpenVaultDbTugQLPlanConfiguration`). The admitted request path changes from `/v1/databases/ecb/dtql` to `/v1/databases/ecb/tugql`, which OpenVaultDB already serves, and refusal messages say TugQL. The root `.` export is unchanged apart from these names.

### Patch Changes

- 1ced3b3: A GitHub-path install of this source now accepts `@dalgo/core` 0.8 (the TugQL release): the source peer is `>=0.6.0 <0.9.0`. The npm package keeps its tested `>=0.6.0 <0.7.0` peer until a release gate covers the newer core.

## 0.2.0

### Minor Changes

- 7ebcb01: Publish the query-only native DTQL executor with independently admitted evidence, completed-body gating and one absolute cancellable execution budget.
