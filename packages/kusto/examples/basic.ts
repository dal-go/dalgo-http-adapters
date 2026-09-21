import { collection } from "@dal-go/dalgo";
import { KustoDatabase } from "../src/index.js";
const database = new KustoDatabase({ clusterUrl: "https://example.eastus.kusto.windows.net", database: "Logs", accessToken: async () => getFreshEntraToken(), tables: { events: { table: "Events", keyColumn: "EventId", columns: { message: "Message", level: "Level" } } } });
declare function getFreshEntraToken(): Promise<string>;
const events = collection<{ message: string; level: string }>("events");
console.log(await database.query(events.query().limit(25).build()));
console.log(await database.queryKql("Events | where Level == level | take count", { level: { type: "string", value: "Warning" }, count: { type: "long", value: 10 } }));
