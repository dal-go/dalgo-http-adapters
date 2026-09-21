import { collection } from "@dal-go/dalgo";
import { SpannerDatabase } from "@dal-go/dalgo2spanner";

const db = new SpannerDatabase({
  projectId: "exampleproject", instanceId: "appinstance", databaseId: "appdb",
  accessToken: () => "obtain-an-expiring-oauth-token-at-runtime",
  tables: { items: { table: "Items", keyColumn: { column: "ItemId", type: "STRING", nullable: false }, columns: { title: { column: "Title", type: "STRING" } } } },
});
const items = collection<{ title: string }>("items");
void db.get(items.key("example"));
