import { collection } from "@dalgo/core";

import { LibSQLDatabase } from "../src/index.js";

interface Item { readonly title: string; readonly rank: number; }

const database = new LibSQLDatabase({
  serverUrl: "https://your-libsql-http-server.example",
  headers: async () => ({ authorization: `Bearer ${await currentDatabaseToken()}` }),
  tables: {
    items: {
      table: "items",
      uniqueKey: true,
      keyColumn: { column: "id", nullable: false },
      columns: { title: { column: "title", nullable: false }, rank: { column: "rank", nullable: false } },
    },
  },
});

const items = collection<Item>("items");
const page = await database.queryWithSignal(items.query().orderBy("rank").limit(25).build(), new AbortController().signal);
await database.set(items.key("starter"), { title: "Starter", rank: page.records.length });

async function currentDatabaseToken(): Promise<string> { return "replace-with-a-short-lived-token"; }
