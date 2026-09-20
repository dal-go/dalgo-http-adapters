import { collection } from "@dal-go/dalgo";
import { PostgrestDatabase } from "@dal-go/dalgo2postgrest";

const db = new PostgrestDatabase({
  baseUrl: "https://api.example.com/rest/v1",
  // Retrieve a short-lived, API-audience token for every request. Do not persist it here.
  headers: async () => ({ authorization: `Bearer ${await fetch("/api/postgrest-token").then((response) => response.text())}` }),
});

const items = collection<{ title: string; done: boolean }>("items");
await db.insert(items.key("milk"), { title: "Buy milk", done: false });
