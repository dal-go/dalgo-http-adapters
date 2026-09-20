import { collection } from "@dal-go/dalgo";
import { Neo4jDatabase } from "../src/index.js";

interface Item {
  id: string;
  title: string;
  done: boolean;
}

const db = new Neo4jDatabase({
  baseUrl: "https://example.databases.neo4j.io",
  database: "neo4j",
  collections: { items: { label: "Item", idProperty: "id" } },
  // Obtain this short-lived token from your own backend or identity provider.
  headers: () => ({ authorization: `Bearer ${window.sessionStorage.getItem("neo4j-token") ?? ""}` }),
});

const items = collection<Item>("items");
const page = await db.query(items.query().where("done", "==", false).orderBy("title").limit(20).build());
console.log(page.records);
