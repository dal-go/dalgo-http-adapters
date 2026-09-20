import { collection } from "@dal-go/dalgo";
import { CouchDbDatabase } from "@dal-go/dalgo2couchdb";

const db = new CouchDbDatabase({
  databaseUrl: "https://couch.example.com/app",
  // This callback can obtain a fresh, narrowly scoped token for every request.
  headers: async () => ({ authorization: `Bearer ${await fetch("/api/couchdb-token").then((response) => response.text())}` }),
});

const items = collection<{ title: string; done: boolean }>("items");
await db.insert(items.key("milk"), { title: "Buy milk", done: false });
