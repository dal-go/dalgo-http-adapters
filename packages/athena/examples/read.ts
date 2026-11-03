import { AthenaNativeClient, AthenaDatabase, type AthenaTransport, type AthenaSource } from "../src/index.js";
import { createAthenaNodeClient, type AthenaNodeCredential } from "../src/node.js";
import { createAthenaHttpHandler } from "../src/http.js";
export async function nativePages(source: AthenaSource, transport: AthenaTransport, signal: AbortSignal): Promise<void> {
  const client = new AthenaNativeClient({ source, transport });
  try {
    let page = await client.queryPage({ source: { kind: "collection", name: "items" }, filters: [], orders: [{ field: "id", direction: "asc" }], offset: 0 }, { signal, pageSize: 100 });
    for (;;) { for (const row of page.rows) { void row; /* Original string|null cells; keep page.columns. */ } if (page.nextCursor === undefined) break; page = await client.nextPage(page.nextCursor, signal); }
  } finally { client.close(); }
}
export function serverOnly(source: AthenaSource, credentials: (signal: AbortSignal) => Promise<AthenaNodeCredential>) {
  const native = createAthenaNodeClient({ source, credentials }); const db = new AthenaDatabase(native);
  const handler = createAthenaHttpHandler({ allowedOrigins: ["https://your-app.example"],
    authorize: async () => {
      // Replace this refusal with real session, CSRF, source/policy and principal
      // authorization. Never select AWS credentials from a request descriptor.
      return undefined;
    } });
  return { db, handler, close: () => { native.close(); } };
}
