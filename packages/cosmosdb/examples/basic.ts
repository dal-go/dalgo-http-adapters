import { collection } from "@dal-go/dalgo";
import { CosmosNoSqlDatabase } from "../src/index.js";

const db = new CosmosNoSqlDatabase({
  endpoint: "https://example.documents.azure.com",
  databaseId: "app",
  containerId: "records",
  // Get this short-lived, narrow resource token from your trusted backend.
  authorization: async () => (await fetch("/api/cosmos-resource-token")).text(),
});

const items = collection<{ title: string; done: boolean }>("items");
await db.insert(items.key("milk"), { title: "Buy milk", done: false });
