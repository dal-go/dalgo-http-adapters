import { collection } from "@dal-go/dalgo";
import { AzureTableDatabase } from "@dal-go/dalgo2azure-table";

const database = new AzureTableDatabase({
  endpoint: "https://example.table.core.windows.net",
  tableName: () => "Records",
  authorization: async () => (await fetch("/api/azure-table-token")).text(),
});

const items = collection<{ done: boolean }>("items");
await database.insert(items.key("milk"), { done: false });
