import { DynamoDBClient, type DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { collection } from "@dal-go/dalgo";

import { DynamoDbDatabase } from "../src/index.js";

const tasks = collection<{ done: boolean; title: string }>("tasks");

export async function listOpenTasks(credentials: NonNullable<DynamoDBClientConfig["credentials"]>) {
  const lowLevelClient = new DynamoDBClient({
    region: "eu-west-1",
    // Obtain this provider from Cognito or web-identity federation in the app.
    credentials,
  });
  const database = new DynamoDbDatabase(DynamoDBDocumentClient.from(lowLevelClient), {
    tableName: "app-dalgo",
  });
  return database.query(tasks.query().where("done", "==", false).limit(25).build());
}
