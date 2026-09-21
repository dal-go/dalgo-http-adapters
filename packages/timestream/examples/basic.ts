import { collection } from "@dal-go/dalgo";
import { TimestreamDatabase } from "../src/index.js";

interface Reading { readonly room: string; readonly temperature: number; readonly time: string; }

const database = new TimestreamDatabase({
  region: "eu-west-1", database: "sensors",
  // Supply refreshed IAM role credentials. Do not expose them in browser code or URLs.
  credentials: () => ({ accessKeyId: "replace-me", secretAccessKey: "replace-me", sessionToken: "optional-session-token" }),
  tables: { readings: { table: "readings", keyColumn: "reading_id", columns: { room: "room", temperature: "measure_value::double", time: "time" } } },
});

const readings = collection<Reading>("readings");
console.log((await database.query(readings.query().limit(25).build())).records);

// Append-oriented native write; it intentionally is not DALgo insert/set/update.
await database.writeRecords("readings", [{ Dimensions: [{ Name: "room", Value: "kitchen" }], MeasureName: "temperature", MeasureValue: "21.5", MeasureValueType: "DOUBLE", Time: "1700000000000", TimeUnit: "MILLISECONDS" }]);
