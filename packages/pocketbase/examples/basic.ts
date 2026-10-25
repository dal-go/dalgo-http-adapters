import { collection } from "@dal-go/dalgo";
import { PocketBaseDatabase } from "@dal-go/dalgo2pocketbase";

const db = new PocketBaseDatabase({
  baseUrl: "https://db.example.com",
  // Return a freshly obtained auth-record token. Do not put superuser tokens in browser code.
  headers: async () => ({ authorization: `Bearer ${await getFreshUserToken()}` }),
});

declare function getFreshUserToken(): Promise<string>;

const items = collection<{ title: string; done: boolean }>("items");
await db.insert(items.key("a1b2c3d4e5f6g7h"), { title: "Buy milk", done: false });
