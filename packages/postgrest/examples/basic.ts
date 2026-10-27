import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { collection } from "@dalgo/core";
import { POSTGREST_READ_CAPABILITIES, PostgrestDatabase } from "@dal-go/dalgo2postgrest";

const db = new PostgrestDatabase({
  baseUrl: "https://api.example.com/rest/v1",
  // Retrieve a short-lived, API-audience token for every request. Do not persist it here.
  headers: async () => ({ authorization: `Bearer ${await fetch("/api/postgrest-token").then((response) => response.text())}` }),
});

const items = collection<{ title: string; done: boolean }>("items");
await db.insert(items.key("milk"), { title: "Buy milk", done: false });

// Admit the capability before building a query the adapter would refuse.
if (POSTGREST_READ_CAPABILITIES.query.sort.status === "native") {
  const controller = new AbortController();
  try {
    // The signal also covers a token refresh, fetch and response-body reads.
    const page = await db.queryWithSignal(items.query().orderBy("title").limit(10).build(), controller.signal);
    void page;
  } catch (error) {
    if (!(error instanceof QueryCancelledError)) throw error;
  }
}
