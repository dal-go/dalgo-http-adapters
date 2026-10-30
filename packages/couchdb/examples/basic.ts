import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { collection } from "@dalgo/core";
import { COUCHDB_READ_CAPABILITIES, CouchDbDatabase } from "@dalgo/dalgo2couchdb";

const db = new CouchDbDatabase({
  databaseUrl: "https://couch.example.com/app",
  // This callback can obtain a fresh, narrowly scoped token for every request.
  headers: async () => ({ authorization: `Bearer ${await fetch("/api/couchdb-token").then((response) => response.text())}` }),
});

const items = collection<{ title: string; done: boolean }>("items");
await db.insert(items.key("milk"), { title: "Buy milk", done: false });

// Admit the capability before building a query the adapter would refuse.
if (COUCHDB_READ_CAPABILITIES.query.pagination.status === "native") {
  const controller = new AbortController();
  try {
    // The signal also covers a token refresh, fetch and response-body reads.
    const page = await db.queryWithSignal(items.query().limit(10).build(), controller.signal);
    void page;
  } catch (error) {
    if (!(error instanceof QueryCancelledError)) throw error;
  }
}
