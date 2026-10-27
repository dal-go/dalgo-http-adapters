import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { collection } from "@dalgo/core";
import {
  POSTGREST_READ_CAPABILITIES,
  PostgrestDatabase,
  type PostgrestConnectionStatus,
  type PostgrestDiscovery,
} from "@dal-go/dalgo2postgrest";

const db = new PostgrestDatabase({
  baseUrl: "https://api.example.com/rest/v1",
  // Retrieve a short-lived, API-audience token for every request. Do not persist it here.
  headers: async () => ({ authorization: `Bearer ${await fetch("/api/postgrest-token").then((response) => response.text())}` }),
  // Optional stable, non-secret tenant/user/workspace binding for cursor reuse.
  identityScope: "workspace:demo",
});

const connection: PostgrestConnectionStatus = await db.testConnection();
if (connection.ok) {
  const discovery: PostgrestDiscovery = await db.discover();
  for (const relation of discovery.relations) {
    console.log(relation.name, relation.primaryKey, relation.adapterQueryable);
  }
}

const items = collection<{ title: string; done: boolean; priority: number }>("items");
await db.insert(items.key("milk"), { title: "Buy milk", done: false, priority: 1 });

// Admit the capability before building a query the adapter would refuse.
if (POSTGREST_READ_CAPABILITIES.query.sort.status === "native") {
  const controller = new AbortController();
  try {
    // The signal also covers a token refresh, fetch and response-body reads.
    const first = await db.queryWithSignal(
      items.query().where("done", "==", false).orderBy("priority").limit(10).build(),
      controller.signal,
    );
    const next = first.nextCursor?.values[0];
    if (next !== undefined) {
      const second = await db.queryWithSignal(
        items.query().where("done", "==", false).orderBy("priority").limit(10).startAfter(next).build(),
        controller.signal,
      );
      void second;
    }
  } catch (error) {
    if (!(error instanceof QueryCancelledError)) throw error;
  }
}
