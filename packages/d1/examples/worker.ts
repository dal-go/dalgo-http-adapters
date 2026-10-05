import { createD1ReadHandler, D1QueryDatabase, type D1Binding } from "../src/index.js";

interface Env { readonly NORTHWIND: D1Binding; }

const tables = {
  Customers: {
    table: "Customers",
    primaryKey: ["CustomerID"],
    columns: {
      CustomerID: { column: "CustomerID" },
      CompanyName: { column: "CompanyName" },
      Country: { column: "Country" },
    },
  },
} as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const handle = createD1ReadHandler(env.NORTHWIND, {
      tables,
      schemaVersion: "northwind-v1",
      seedVersion: "northwind-2026-10-05",
      allowedOrigins: ["https://example.com"],
    });
    return handle(request);
  },
};

export function createLocalReader(binding: D1Binding): D1QueryDatabase {
  return new D1QueryDatabase(binding, { tables });
}
