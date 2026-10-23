---
"@dalgo/ovdb": minor
---

Rename DTQL to TugQL in the query-only executor. This is a breaking release with no aliases: the `@dalgo/ovdb/dtql` subpath is now `@dalgo/ovdb/tugql`, the packed output directory `dist-dtql` is now `dist-tugql`, and every exported name moves from `OpenVaultDbDTQL...` to `OpenVaultDbTugQL...` (`OpenVaultDbDTQLQueryExecutor` is `OpenVaultDbTugQLQueryExecutor`, `validateOpenVaultDbDTQLPlan` is `validateOpenVaultDbTugQLPlan`, `validateOpenVaultDbDTQLEvidence` is `validateOpenVaultDbTugQLEvidence`, `OpenVaultDbDTQLQueryOptions` is `OpenVaultDbTugQLQueryOptions`, `OpenVaultDbDTQLPlanConfiguration` is `OpenVaultDbTugQLPlanConfiguration`). The admitted request path changes from `/v1/databases/ecb/dtql` to `/v1/databases/ecb/tugql`, which OpenVaultDB already serves, and refusal messages say TugQL. The root `.` export is unchanged apart from these names.
