import { collection } from "@dal-go/dalgo";
import { OpenSearchDatabase } from "../src/index.js";

interface Product {
  readonly name: string;
  readonly price: number;
}

const products = collection<Product>("products");
const accessToken = "<short-lived-token-from-your-trusted-broker>";
const database = new OpenSearchDatabase({
  baseUrl: "https://search.example.com",
  headers: () => ({ Authorization: `Bearer ${accessToken}` }),
});

const page = await database.query(products.query().where("price", ">=", 10).orderBy("price").limit(20).build());
console.log(page.records.map((record) => record.data));
