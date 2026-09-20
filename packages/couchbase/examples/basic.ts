import { collection } from "@dal-go/dalgo";
import { CouchbaseDataApiDatabase } from "../src/index.js";
const db = new CouchbaseDataApiDatabase({ endpoint: "https://cluster.data.cloud.couchbase.com", authorization: async () => (await fetch("/api/couchbase-authorization")).text(), collections: { items: { bucket: "app", scope: "_default", collection: "items" } } });
const items = collection<{ title: string }>("items");
await db.insert(items.key("milk"), { title: "Buy milk" });
