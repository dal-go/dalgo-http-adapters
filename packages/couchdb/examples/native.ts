import { collection } from "@dalgo/core";
import {
  NATIVE_COUCHDB_READ_CAPABILITIES,
  NativeCouchDbDatabase,
  type NativeCouchDbQuery,
} from "@dal-go/dalgo2couchdb";

const db = new NativeCouchDbDatabase({
  // One existing CouchDB database maps to one logical DALgo collection.
  databaseUrl: "https://couch.example.com/app",
  collection: "items",
  headers: async () => ({ authorization: `Bearer ${await getFreshCouchToken()}` }),
  // Ordered queries are admitted only through an explicit index ending in _id.
  permittedIndexes: [{
    ddoc: "_design/status-id",
    name: "status-id-index",
    fields: [
      { field: "status", direction: "asc" },
      { field: "_id", direction: "asc" },
    ],
  }],
});

const items = collection<{ title: string; status: string; nullable: string | null }>("items");
const existing = await db.get(items.key("milk"));
void existing;

// A projection is an additive native option; _id is required and preserved.
const projected: NativeCouchDbQuery<{ title: string }> = {
  ...items.query().where("status", "==", "open").limit(25).build(),
  projection: ["_id", "title"],
};
const controller = new AbortController();
const page = await db.queryWithSignal(projected, controller.signal);
void page;

const description = await db.describe(controller.signal);
if (description.indexes.status === "available") {
  void description.indexes.indexes;
}
void NATIVE_COUCHDB_READ_CAPABILITIES;

declare function getFreshCouchToken(): Promise<string>;
