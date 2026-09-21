import { collection } from "@dal-go/dalgo";
import { AlgoliaDatabase } from "../src/index.js";

// Search keys are designed for browser exposure only after index and query restrictions are set in Algolia.
const database = new AlgoliaDatabase({
  applicationId: "YOUR_APP_ID",
  apiKey: "YOUR_RESTRICTED_SEARCH_KEY",
  indexes: { products: "products_public" },
});

const products = collection<{ name: string; category: string }>("products");
const result = await database.query(products.query().where("category", "==", "books").limit(20).build());
console.log(result.records);
