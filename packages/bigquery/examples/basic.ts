import { collection } from "@dal-go/dalgo";
import { BigQueryDatabase } from "../src/index.js";

interface Item {
  title: string;
  done: boolean;
  rank: string; // BigQuery INT64 is intentionally preserved as its JSON wire string.
}

const database = new BigQueryDatabase({
  projectId: "example-project",
  maximumBytesBilled: "10000000",
  accessToken: async () => {
    // Obtain a short-lived browser OAuth access token with an appropriate, narrow grant.
    return "replace-with-a-rotating-oauth-token";
  },
  tables: {
    items: {
      datasetId: "app_data",
      tableId: "items",
      keyColumn: { column: "id", type: "STRING", nullable: false },
      columns: {
        title: { column: "title", type: "STRING" },
        done: { column: "done", type: "BOOL" },
        rank: { column: "rank", type: "INT64", nullable: false },
      },
    },
  },
});

const items = collection<Item>("items");
const page = await database.query(
  items.query().where("done", "==", false).orderBy("rank").limit(25).build(),
);

console.log(page.records);
