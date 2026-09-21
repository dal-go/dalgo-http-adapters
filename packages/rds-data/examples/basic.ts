import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { collection } from "@dal-go/dalgo";
import { RdsDataDatabase } from "@dal-go/dalgo2rds-data";

const database = new RdsDataDatabase({
  client: new RDSDataClient({ region: "eu-west-1" }), resourceArn: "arn:aws:rds:eu-west-1:123456789012:cluster:example", secretArn: "arn:aws:secretsmanager:eu-west-1:123456789012:secret:example",
  dialect: "postgresql", tables: { todos: { schema: "public", table: "todos", keyColumn: "id", keyType: "integer", uniqueKey: true, columns: { title: "title", done: "done" } } },
});
console.log(await database.query(collection("todos").query().limit(10).build()));
