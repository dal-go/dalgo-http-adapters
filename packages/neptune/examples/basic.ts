import { collection } from "@dal-go/dalgo";
import { NeptuneDatabase } from "../src/index.js";

interface Item { title: string; done: boolean; }

const db = new NeptuneDatabase({
  baseUrl: "https://your-neptune-cluster:8182",
  collections: { items: { label: "Item" } },
  // Sign the final URL, headers, and form body in trusted code.
  fetch: signedFetch,
});

declare const signedFetch: typeof fetch;

const items = collection<Item>("items");
const page = await db.query(items.query().where("done", "==", false).orderBy("title").limit(20).build());
console.log(page.records);
