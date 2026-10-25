import { collection } from "@dal-go/dalgo";
import { DatastoreDatabase } from "@dal-go/dalgo2datastore";

const db = new DatastoreDatabase({
  projectId: "example-project",
  // Return a fresh, least-privilege OAuth token from your own authenticated broker.
  accessToken: async () => fetch("/api/google-datastore-token").then((response) => response.text()),
});

const items = collection<{ title: string; done: boolean }>("items");
await db.insert(items.key("milk"), { title: "Buy milk", done: false });
