import { collection } from "@dalgo/core";

import { NativeLibSQLDatabase } from "../src/index.js";

interface Item { readonly title: string; readonly rank: number | null; }

// Read-only access to existing tables/views. The allowlist below is the only
// surface discovery or metadata can select; it never creates a table/envelope.
const database = new NativeLibSQLDatabase({
  serverUrl: "https://your-libsql-http-server.example",
  headers: () => ({ authorization: `Bearer ${sessionToken()}` }),
  identityScope: "user-42",
  tables: {
    items: {
      table: "items",
      uniqueKey: true,
      key: { column: "id", type: "integer" },
      columns: {
        title: { column: "title", nullable: false },
        rank: { column: "rank", nullable: true },
      },
    },
  },
});

const items = collection<Item>("items");
const metadata = await database.describe();
const page = await database.queryWithSignal(
  items.query().orderBy("rank").limit(20).build(),
  new AbortController().signal,
);
void metadata;
void page;

function sessionToken(): string { return "replace-with-a-short-lived-reader-token"; }
