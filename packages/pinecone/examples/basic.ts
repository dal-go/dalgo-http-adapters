import { collection } from "@dal-go/dalgo";
import { PineconeDatabase } from "../src/index.js";

interface Product { readonly title: string; readonly price: number }
declare function embedForIndex(value: unknown): readonly number[];

const database = new PineconeDatabase({
  baseUrl: "https://your-index-host",
  namespace: "products",
  vectorForWrite: (metadata) => embedForIndex(metadata.title),
  // Obtain this only in a trusted server/worker-side credential broker.
  headers: () => ({ "Api-Key": "server-provided-token" }),
});
const products = collection<Product>("products");
await database.set(products.key("product-1"), { title: "Example", price: 12 });
const similar = await database.vectorSearch(products.query().where("price", ">=", 10).limit(10).build(), [0.2, 0.8]);
console.log(similar);
