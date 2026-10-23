# Shared SQLite query compiler for DALgo adapters

`@dalgo/sqlite-sql` compiles one bounded, top-level DALgo `StructuredQuery`
into parameterized SQLite SQL. It is the single compiler shared by
[`@dalgo/d1`](../d1) and [`@dalgo/sqlite-wasm`](../sqlite-wasm); applications
normally use one of those adapters instead of this package.

```ts
import { compileSqlQuery } from "@dalgo/sqlite-sql";
import { UnsupportedError } from "@dalgo/core";

const dialect = { name: "SQLite", unsupported: (capability: string) => new UnsupportedError(capability) };
const { sql, args } = compileSqlQuery(dialect, {
  table: "Artist",
  primaryKey: ["ArtistId"],
  columns: { ArtistId: { column: "ArtistId" }, Name: { column: "Name" } },
}, {
  source: { kind: "collection", name: "Artist" },
  filters: [{ field: "Name", operator: ">=", value: "M" }],
  orders: [{ field: "Name", direction: "asc" }],
}, 25);
```

- Supported operators: `==`, `!=` (both map `null` to `IS [NOT] NULL`), `<`,
  `<=`, `>`, `>=`, `in`, `not-in` (1 to 100 values). At most 100 bound values.
- `DOCUMENT_ID` filters and orders map to a single-column primary key.
- Results are ordered by the requested orders and then by the primary key (or
  every declared column for keyless tables), so paging is deterministic.
- Identifiers are quoted; values are always bound. Callers cannot submit SQL.
- Cursors, collection-group and nested queries are rejected.

`@dalgo/core` is a type-only peer: the adapter passes its own error
constructor in `dialect.unsupported`, so thrown `UnsupportedError`s belong to
the adapter's `@dalgo/core` instance.
