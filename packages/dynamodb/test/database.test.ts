import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  DOCUMENT_ID,
  NotFoundError,
  UnsupportedError,
  collection,
  key,
} from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";

import { DynamoDbDatabase } from "../src/index.js";

function testDatabase() {
  const send = vi.fn();
  const client = { send } as unknown as DynamoDBDocumentClient;
  return { database: new DynamoDbDatabase(client, { tableName: "dalgo" }), send };
}

function commandInput(command: unknown): unknown {
  return (command as { readonly input: unknown }).input;
}

describe("DynamoDbDatabase", () => {
  it("maps point reads and missing records using the configured key layout", async () => {
    const { database, send } = testDatabase();
    send.mockResolvedValueOnce({ Item: { pk: "items", sk: "items/milk", __dalgo_id: "milk", data: { done: false } } });
    send.mockResolvedValueOnce({});

    await expect(database.get<{ done: boolean }>(key("items", "milk"))).resolves.toEqual({
      key: key("items", "milk"),
      exists: true,
      data: { done: false },
    });
    await expect(database.get(key("items", "missing"))).resolves.toEqual({
      key: key("items", "missing"),
      exists: false,
    });
    expect(commandInput(send.mock.calls[0]?.[0] as GetCommand)).toEqual({
      TableName: "dalgo",
      Key: { pk: "items", sk: "items/milk" },
    });
  });

  it("uses one BatchGet request and restores input ordering", async () => {
    const { database, send } = testDatabase();
    send.mockResolvedValue({
      Responses: {
        dalgo: [
          { pk: "items", sk: "items/b", __dalgo_id: "b", data: { value: 2 } },
          { pk: "items", sk: "items/a", __dalgo_id: "a", data: { value: 1 } },
        ],
      },
    });

    await expect(database.getMany<{ value: number }>([key("items", "a"), key("items", "missing"), key("items", "a"), key("items", "b")]))
      .resolves.toEqual([
        { key: key("items", "a"), exists: true, data: { value: 1 } },
        { key: key("items", "missing"), exists: false },
        { key: key("items", "a"), exists: true, data: { value: 1 } },
        { key: key("items", "b"), exists: true, data: { value: 2 } },
      ]);
    expect(commandInput(send.mock.calls[0]?.[0] as BatchGetCommand)).toEqual({
      RequestItems: {
        dalgo: {
          Keys: [
            { pk: "items", sk: "items/a" },
            { pk: "items", sk: "items/missing" },
            { pk: "items", sk: "items/b" },
          ],
        },
      },
    });
  });

  it("applies DynamoDB's 100-key limit after deduplicating the caller input", async () => {
    const { database, send } = testDatabase();
    const repeated = Array.from({ length: 101 }, () => key("items", "a"));
    send.mockResolvedValue({ Responses: { dalgo: [{ pk: "items", sk: "items/a", __dalgo_id: "a", data: { value: 1 } }] } });
    await expect(database.getMany<{ value: number }>(repeated)).resolves.toHaveLength(101);
    expect(commandInput(send.mock.calls[0]?.[0] as BatchGetCommand)).toEqual({
      RequestItems: { dalgo: { Keys: [{ pk: "items", sk: "items/a" }] } },
    });

    const distinct = Array.from({ length: 101 }, (_, index) => key("items", `item-${String(index)}`));
    await expect(database.getMany(distinct)).rejects.toBeInstanceOf(UnsupportedError);
  });

  it("uses conditional insert and maps duplicate/update failures to DALgo errors", async () => {
    const { database, send } = testDatabase();
    send.mockResolvedValueOnce({});
    await database.insert(key("items", "milk"), { done: false });
    expect(commandInput(send.mock.calls[0]?.[0] as PutCommand)).toEqual({
      TableName: "dalgo",
      Item: { pk: "items", sk: "items/milk", __dalgo_id: "milk", data: { done: false } },
      ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    });

    send.mockRejectedValueOnce(Object.assign(new Error("duplicate"), { name: "ConditionalCheckFailedException" }));
    await expect(database.insert(key("items", "milk"), { done: false })).rejects.toMatchObject({
      name: "AlreadyExistsError",
      key: key("items", "milk"),
    });

    send.mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "ConditionalCheckFailedException" }));
    await expect(database.update(key("items", "milk"), { done: true })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("compiles set, top-level update, and delete without interpolating field names", async () => {
    const { database, send } = testDatabase();
    send.mockResolvedValue({});
    await database.set(key("items", "milk"), { done: false });
    await database.update(key("items", "milk"), { done: true, rank: 2 });
    await database.delete(key("items", "milk"));

    expect(commandInput(send.mock.calls[0]?.[0] as PutCommand)).toEqual({
      TableName: "dalgo",
      Item: { pk: "items", sk: "items/milk", __dalgo_id: "milk", data: { done: false } },
    });
    expect(commandInput(send.mock.calls[1]?.[0] as UpdateCommand)).toEqual({
      TableName: "dalgo",
      Key: { pk: "items", sk: "items/milk" },
      UpdateExpression: "SET #data.#field0 = :value0, #data.#field1 = :value1",
      ConditionExpression: "attribute_exists(#pk) AND attribute_exists(#sk)",
      ExpressionAttributeNames: {
        "#pk": "pk",
        "#sk": "sk",
        "#data": "data",
        "#field0": "done",
        "#field1": "rank",
      },
      ExpressionAttributeValues: { ":value0": true, ":value1": 2 },
    });
    expect(commandInput(send.mock.calls[2]?.[0] as DeleteCommand)).toEqual({
      TableName: "dalgo",
      Key: { pk: "items", sk: "items/milk" },
    });
  });

  it("queries a nested collection with filters, safe aliases, native ID ordering, and opaque pagination", async () => {
    const { database, send } = testDatabase();
    const user = key("users", "u1");
    const posts = collection<{ state: string }>("posts").in(user);
    send.mockResolvedValueOnce({
      Items: [{ pk: "users/u1/posts", sk: "users/u1/posts/p1", __dalgo_id: "p1", data: { state: "open" } }],
      LastEvaluatedKey: { pk: "users/u1/posts", sk: "users/u1/posts/p1" },
    });
    const firstPage = await database.query(posts.query().where("state", "==", "open").orderBy(DOCUMENT_ID, "desc").limit(1).build());
    expect(firstPage.records).toEqual([{ key: posts.key("p1"), exists: true, data: { state: "open" } }]);
    expect(commandInput(send.mock.calls[0]?.[0] as QueryCommand)).toEqual({
      TableName: "dalgo",
      KeyConditionExpression: "#pk = :collection",
      FilterExpression: "#data.#field0 = :value0",
      ExpressionAttributeNames: { "#pk": "pk", "#data": "data", "#field0": "state" },
      ExpressionAttributeValues: { ":collection": "users/u1/posts", ":value0": "open" },
      ScanIndexForward: false,
      Limit: 1,
    });

    send.mockResolvedValueOnce({ Items: [] });
    await database.query(posts.query().startAfter(...(firstPage.nextCursor?.values ?? [])).build());
    expect(commandInput(send.mock.calls[1]?.[0] as QueryCommand)).toMatchObject({
      ExclusiveStartKey: { pk: "users/u1/posts", sk: "users/u1/posts/p1" },
    });
  });

  it("continues a limited filtered query through empty DynamoDB pages", async () => {
    const { database, send } = testDatabase();
    const items = collection<{ done: boolean }>("items");
    send.mockResolvedValueOnce({ LastEvaluatedKey: { pk: "items", sk: "items/a" }, Items: [] });
    send.mockResolvedValueOnce({ Items: [{ pk: "items", sk: "items/b", __dalgo_id: "b", data: { done: false } }] });

    await expect(database.query(items.query().where("done", "==", false).limit(1).build())).resolves.toMatchObject({
      records: [{ key: key("items", "b"), exists: true, data: { done: false } }],
    });
    expect(commandInput(send.mock.calls[1]?.[0] as QueryCommand)).toMatchObject({
      Limit: 1,
      ExclusiveStartKey: { pk: "items", sk: "items/a" },
    });
  });

  it("does not send unused expression aliases for unfiltered or document-ID-only queries", async () => {
    const { database, send } = testDatabase();
    const items = collection<{ done: boolean }>("items");
    send.mockResolvedValue({ Items: [] });
    await database.query(items.query().build());
    expect(commandInput(send.mock.calls[0]?.[0] as QueryCommand)).toEqual({
      TableName: "dalgo",
      KeyConditionExpression: "#pk = :collection",
      ExpressionAttributeNames: { "#pk": "pk" },
      ExpressionAttributeValues: { ":collection": "items" },
      ScanIndexForward: true,
    });

    await database.query(items.query().where(DOCUMENT_ID, "==", "a").build());
    expect(commandInput(send.mock.calls[1]?.[0] as QueryCommand)).toEqual({
      TableName: "dalgo",
      KeyConditionExpression: "#pk = :collection AND #sk = :documentId",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: { ":collection": "items", ":documentId": "items/a" },
      ScanIndexForward: true,
    });
  });

  it("rejects semantic mismatches rather than performing an unsafe approximation", async () => {
    const { database } = testDatabase();
    const items = collection<{ rank: number }>("items");
    await expect(database.query(items.query().orderBy("rank").build())).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.runReadwriteTransaction(() => Promise.resolve("nope"))).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.set(key("items", "bad"), ["not", "a", "document"])).rejects.toThrow("must encode to a non-null object");
  });

  it("rejects hostile structured query objects and repeated native page keys", async () => {
    const { database, send } = testDatabase();
    const items = collection<{ done: boolean }>("items");
    const built = items.query().build();
    const invalidOperator = {
      ...built,
      filters: [{ field: "done", operator: "bad-operator", value: false }],
    } as unknown as typeof built;
    const invalidDirection = {
      ...built,
      orders: [{ field: DOCUMENT_ID, direction: "sideways" }],
    } as unknown as typeof built;
    await expect(database.query(invalidOperator)).rejects.toBeInstanceOf(UnsupportedError);
    await expect(database.query(invalidDirection)).rejects.toThrow("direction must be asc or desc");

    send.mockResolvedValue({ LastEvaluatedKey: { pk: "items", sk: "items/a" }, Items: [] });
    await expect(database.query(items.query().limit(1).build())).rejects.toThrow("repeated pagination key");
  });
});
