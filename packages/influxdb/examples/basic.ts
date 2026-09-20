import { collection } from "@dal-go/dalgo";
import { InfluxDB3Database } from "../src/index.js";

interface SensorReading { readonly room: string; readonly temperature: number; readonly time: string; }

const database = new InfluxDB3Database({
  database: "sensors",
  serverUrl: "https://influx.example.com",
  accessToken: () => "replace-with-a-short-lived-database-token",
  tables: {
    readings: {
      table: "readings",
      keyColumn: { column: "reading_id", nullable: false },
      columns: {
        room: { column: "room", nullable: false },
        temperature: { column: "temperature", nullable: false },
        time: { column: "time", nullable: false },
      },
    },
  },
});

const readings = collection<SensorReading>("readings");
const page = await database.query(readings.query().where("room", "==", "kitchen").orderBy("time", "desc").limit(25).build());
console.log(page.records);

// This appends a time-series point. It is intentionally not DALgo record CRUD.
await database.appendLineProtocol(["readings,room=kitchen temperature=21.5 1700000000"], "second");
