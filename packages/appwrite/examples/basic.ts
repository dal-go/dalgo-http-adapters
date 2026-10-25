import { collection } from "@dal-go/dalgo";
import { AppwriteDatabase } from "@dal-go/dalgo2appwrite";

const db = new AppwriteDatabase({
  endpoint: "https://cloud.appwrite.io/v1",
  projectId: "my-project",
  databaseId: "app-data",
  // Browser sessions are normally sent by Appwrite's web client/cookie policy.
  // Supply only a freshly obtained, narrowly scoped user JWT if your architecture needs it.
  headers: async () => ({ "x-appwrite-jwt": await getFreshUserJwt() }),
});

declare function getFreshUserJwt(): Promise<string>;

const items = collection<{ title: string; done: boolean }>("items");
await db.insert(items.key("milk"), { title: "Buy milk", done: false });
