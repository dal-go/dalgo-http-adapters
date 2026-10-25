import { collection } from "@dal-go/dalgo";
import { QdrantDatabase } from "../src/index.js";

interface Product { readonly title: string; readonly price: number }

const database = new QdrantDatabase({
  baseUrl: "https://qdrant.example",
  collections: {
    products: {
      collection: "product-embeddings-v1",
      vectorForWrite: (payload) => [Number(payload.price), 1],
    },
  },
  // Resolve api-key in a server-side broker; never put it in baseUrl or browser source.
  headers: () => ({ "api-key": "server-provided-token" }),
});

const products = collection<Product>("products");
await database.set(products.key("123e4567-e89b-12d3-a456-426614174000"), { title: "Example", price: 12 });
const filtered = await database.query(products.query().where("price", ">=", 10).limit(10).build());
const similar = await database.vectorSearch(products.query().limit(10).build(), [0.2, 0.8]);
console.log({ filtered, similar });
