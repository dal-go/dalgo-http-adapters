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
  AlreadyExistsError,
  DOCUMENT_ID,
  Key,
  NotFoundError,
  UnsupportedError,
  identityCodec,
  type Codec,
  type Database,
  type ExistingRecord,
  type QueryCursor,
  type QueryFilter,
  type QueryPage,
  type StructuredQuery,
  type UpdateData,
  type RecordSnapshot,
  type ReadwriteTransaction,
} from "@dal-go/dalgo";

export interface DynamoDbTableOptions {
  /** DynamoDB table name. */
  readonly tableName: string;
  /** Partition-key attribute. Defaults to `pk`. */
  readonly partitionKey?: string;
  /** Sort-key attribute. Defaults to `sk`. A sort key is required by this layout. */
  readonly sortKey?: string;
  /** Attribute containing the encoded DALgo document. Defaults to `data`. */
  readonly dataAttribute?: string;
  /** Private attribute containing the original DALgo key ID. Defaults to `__dalgo_id`. */
  readonly idAttribute?: string;
  /** Maximum native Query requests for one DALgo query. Defaults to 100. */
  readonly maxQueryPages?: number;
}

interface ResolvedTableOptions {
  readonly tableName: string;
  readonly partitionKey: string;
  readonly sortKey: string;
  readonly dataAttribute: string;
  readonly idAttribute: string;
  readonly maxQueryPages: number;
}

type DynamoItem = Record<string, unknown>;

interface DynamoCursor {
  readonly adapter: "@dal-go/dalgo2dynamodb";
  readonly version: 1;
  readonly tableName: string;
  readonly collectionPath: string;
  readonly partitionValue: string;
  readonly sortValue: string;
}

interface CompiledFilter {
  readonly expression?: string;
  readonly names: Record<string, string>;
  readonly values: Record<string, unknown>;
  readonly documentId?: string;
}

function resolveTable(options: DynamoDbTableOptions): ResolvedTableOptions {
  const tableName = requireName(options.tableName, "tableName");
  const partitionKey = requireName(options.partitionKey ?? "pk", "partitionKey");
  const sortKey = requireName(options.sortKey ?? "sk", "sortKey");
  const dataAttribute = requireName(options.dataAttribute ?? "data", "dataAttribute");
  const idAttribute = requireName(options.idAttribute ?? "__dalgo_id", "idAttribute");
  const maxQueryPages = options.maxQueryPages ?? 100;
  if (!Number.isSafeInteger(maxQueryPages) || maxQueryPages < 1) {
    throw new TypeError("maxQueryPages must be a positive safe integer");
  }
  const attributes = new Set([partitionKey, sortKey, dataAttribute, idAttribute]);
  if (attributes.size !== 4) {
    throw new TypeError("DynamoDB key, data, and ID attribute names must be distinct");
  }
  return { tableName, partitionKey, sortKey, dataAttribute, idAttribute, maxQueryPages };
}

function requireName(value: string, option: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${option} must not be empty`);
  }
  return value;
}

function codecOrIdentity<T>(codec: Codec<T> | undefined): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function isPlainDocument(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDocument(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainDocument(value)) {
    throw new TypeError("DynamoDB DALgo records must encode to a non-null object");
  }
  assertNoUndefined(value);
}

function assertNoUndefined(value: unknown): void {
  if (value === undefined) {
    throw new TypeError("DynamoDB documents must not contain undefined values");
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoUndefined(entry);
    }
  } else if (isPlainDocument(value)) {
    for (const entry of Object.values(value)) {
      assertNoUndefined(entry);
    }
  }
}

function isConditionalFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "name" in error && error.name === "ConditionalCheckFailedException";
}

function isKeyId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function requiredItem(value: unknown, context: string): DynamoItem {
  if (!isPlainDocument(value)) {
    throw new Error(`DynamoDB ${context} did not contain an object item`);
  }
  return value;
}

function storageFingerprint(item: DynamoItem, partitionKey: string, sortKey: string): string {
  const partitionValue = item[partitionKey];
  const sortValue = item[sortKey];
  if (typeof partitionValue !== "string" || typeof sortValue !== "string") {
    throw new Error("DynamoDB item is missing configured string key attributes");
  }
  return JSON.stringify([partitionValue, sortValue]);
}

/**
 * DALgo adapter for the DynamoDB document client.
 *
 * The table must use a string partition key and string sort key. The adapter
 * writes `collectionPath` to the partition key and `key.path` to the sort key.
 */
export class DynamoDbDatabase implements Database {
  readonly #client: DynamoDBDocumentClient;
  readonly #table: ResolvedTableOptions;

  public constructor(client: DynamoDBDocumentClient, options: DynamoDbTableOptions) {
    this.#client = client;
    this.#table = resolveTable(options);
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    const output = await this.#client.send(new GetCommand({
      TableName: this.#table.tableName,
      Key: this.storageKey(key),
    }));
    if (output.Item === undefined) {
      return { key, exists: false };
    }
    return this.recordFromItem(key, requiredItem(output.Item, "Get"), codec);
  }

  public async getMany<T>(
    keys: readonly Key[],
    codec?: Codec<T>,
  ): Promise<readonly RecordSnapshot<T>[]> {
    if (keys.length === 0) {
      return [];
    }
    const requestedByStorageKey = new Map<string, DynamoItem>();
    for (const key of keys) {
      const stored = this.storageKey(key);
      requestedByStorageKey.set(storageFingerprint(stored, this.#table.partitionKey, this.#table.sortKey), stored);
    }
    if (requestedByStorageKey.size > 100) {
      throw new UnsupportedError("DynamoDB getMany calls with more than 100 distinct keys");
    }
    const output = await this.#client.send(new BatchGetCommand({
      RequestItems: { [this.#table.tableName]: { Keys: [...requestedByStorageKey.values()] } },
    }));
    const unprocessed = output.UnprocessedKeys?.[this.#table.tableName]?.Keys ?? [];
    if (unprocessed.length > 0) {
      throw new Error("DynamoDB BatchGet returned unprocessed keys; retry the operation");
    }
    const items = output.Responses?.[this.#table.tableName] ?? [];
    const byStorageKey = new Map<string, DynamoItem>();
    for (const item of items) {
      const storedItem = requiredItem(item, "BatchGet");
      byStorageKey.set(storageFingerprint(storedItem, this.#table.partitionKey, this.#table.sortKey), storedItem);
    }
    return keys.map((key) => {
      const stored = this.storageKey(key);
      const item = byStorageKey.get(storageFingerprint(stored, this.#table.partitionKey, this.#table.sortKey));
      return item === undefined ? { key, exists: false } : this.recordFromItem(key, item, codec);
    });
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const document = codecOrIdentity(codec).encode(data);
    assertDocument(document);
    try {
      await this.#client.send(new PutCommand({
        TableName: this.#table.tableName,
        Item: this.itemFor(key, document),
        ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
        ExpressionAttributeNames: {
          "#pk": this.#table.partitionKey,
          "#sk": this.#table.sortKey,
        },
      }));
    } catch (error: unknown) {
      if (isConditionalFailure(error)) {
        throw new AlreadyExistsError(key, { cause: error });
      }
      throw error;
    }
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const document = codecOrIdentity(codec).encode(data);
    assertDocument(document);
    await this.#client.send(new PutCommand({
      TableName: this.#table.tableName,
      Item: this.itemFor(key, document),
    }));
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      throw new TypeError("DynamoDB update data must contain at least one field");
    }
    assertNoUndefined(data);
    const names: Record<string, string> = {
      "#pk": this.#table.partitionKey,
      "#sk": this.#table.sortKey,
      "#data": this.#table.dataAttribute,
    };
    const values: Record<string, unknown> = {};
    const assignments: string[] = [];
    for (const [index, [field, value]] of entries.entries()) {
      if (field.length === 0) {
        throw new TypeError("DynamoDB update field names must not be empty");
      }
      const fieldAlias = `#field${String(index)}`;
      const valueAlias = `:value${String(index)}`;
      names[fieldAlias] = field;
      values[valueAlias] = value;
      assignments.push(`#data.${fieldAlias} = ${valueAlias}`);
    }
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#table.tableName,
        Key: this.storageKey(key),
        UpdateExpression: `SET ${assignments.join(", ")}`,
        ConditionExpression: "attribute_exists(#pk) AND attribute_exists(#sk)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }));
    } catch (error: unknown) {
      if (isConditionalFailure(error)) {
        throw new NotFoundError(key, { cause: error });
      }
      throw error;
    }
  }

  public async delete(key: Key): Promise<void> {
    await this.#client.send(new DeleteCommand({
      TableName: this.#table.tableName,
      Key: this.storageKey(key),
    }));
  }

  public async query<T>(dalQuery: StructuredQuery<T>): Promise<QueryPage<T>> {
    if (dalQuery.source.kind !== "collection") {
      throw new UnsupportedError("DynamoDB collection-group queries");
    }
    if ((dalQuery.offset ?? 0) !== 0) {
      throw new UnsupportedError("DynamoDB query offsets");
    }
    if (dalQuery.startAt !== undefined || dalQuery.endAt !== undefined || dalQuery.endBefore !== undefined) {
      throw new UnsupportedError("DynamoDB inclusive and end query cursors");
    }
    const order = this.queryOrder(dalQuery);
    const collectionPath = dalQuery.source.parent === undefined
      ? dalQuery.source.name
      : dalQuery.source.parent.path + "/" + dalQuery.source.name;
    const filter = this.compileFilters(dalQuery.filters, dalQuery.source.name, dalQuery.source.parent);
    const cursor = this.cursorFromQuery(dalQuery.startAfter, collectionPath);
    const keyConditionNames: Record<string, string> = { "#pk": this.#table.partitionKey };
    const keyConditionValues: Record<string, unknown> = { ":collection": collectionPath };
    const keyConditionParts = ["#pk = :collection"];
    if (filter.documentId !== undefined) {
      keyConditionNames["#sk"] = this.#table.sortKey;
      keyConditionValues[":documentId"] = filter.documentId;
      keyConditionParts.push("#sk = :documentId");
    }
    const names = { ...keyConditionNames, ...filter.names };
    const values = { ...keyConditionValues, ...filter.values };
    const records: ExistingRecord<T>[] = [];
    let exclusiveStartKey = cursor === undefined ? undefined : this.cursorKey(cursor);
    const seenCursorKeys = new Set<string>();
    if (exclusiveStartKey !== undefined) {
      seenCursorKeys.add(storageFingerprint(exclusiveStartKey, this.#table.partitionKey, this.#table.sortKey));
    }
    let lastEvaluatedKey: DynamoItem | undefined;
    let remaining = dalQuery.limit;
    let pageCount = 0;
    do {
      if (pageCount >= this.#table.maxQueryPages) {
        throw new Error(`DynamoDB query exceeded the configured ${String(this.#table.maxQueryPages)}-page safety limit`);
      }
      pageCount += 1;
      const output = await this.#client.send(new QueryCommand({
        TableName: this.#table.tableName,
        KeyConditionExpression: keyConditionParts.join(" AND "),
        ...(filter.expression === undefined ? {} : { FilterExpression: filter.expression }),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ScanIndexForward: order === "asc",
        ...(remaining === undefined ? {} : { Limit: remaining }),
        ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
      }));
      for (const item of output.Items ?? []) {
        records.push(this.recordFromQueryItem(requiredItem(item, "Query"), dalQuery.source.name, dalQuery.source.parent, dalQuery.source.codec));
      }
      lastEvaluatedKey = output.LastEvaluatedKey === undefined
        ? undefined
        : requiredItem(output.LastEvaluatedKey, "Query cursor");
      if (lastEvaluatedKey !== undefined) {
        const fingerprint = storageFingerprint(lastEvaluatedKey, this.#table.partitionKey, this.#table.sortKey);
        if (seenCursorKeys.has(fingerprint)) {
          throw new Error("DynamoDB query returned a repeated pagination key");
        }
        seenCursorKeys.add(fingerprint);
      }
      exclusiveStartKey = lastEvaluatedKey;
      if (remaining !== undefined) {
        remaining -= output.Items?.length ?? 0;
      }
    } while (lastEvaluatedKey !== undefined && remaining !== 0);
    const nextCursor = lastEvaluatedKey === undefined
      ? undefined
      : this.cursorFor(lastEvaluatedKey, collectionPath);
    return { records, ...(nextCursor === undefined ? {} : { nextCursor }) };
  }

  public runReadwriteTransaction<Result>(
    callback: (transaction: ReadwriteTransaction) => Promise<Result>,
  ): Promise<Result> {
    if (typeof callback !== "function") {
      return Promise.reject(new TypeError("DynamoDB transaction callback must be a function"));
    }
    return Promise.reject(new UnsupportedError("DynamoDB DALgo callback transactions"));
  }

  private storageKey(key: Key): DynamoItem {
    return {
      [this.#table.partitionKey]: key.collectionPath,
      [this.#table.sortKey]: key.path,
    };
  }

  private itemFor(key: Key, data: Record<string, unknown>): DynamoItem {
    return {
      ...this.storageKey(key),
      [this.#table.idAttribute]: key.id,
      [this.#table.dataAttribute]: data,
    };
  }

  private recordFromItem<T>(key: Key, item: DynamoItem, codec?: Codec<T>): ExistingRecord<T> {
    if (!(this.#table.dataAttribute in item)) {
      throw new Error("DynamoDB item is missing the configured DALgo data attribute");
    }
    return { key, exists: true, data: codecOrIdentity(codec).decode(item[this.#table.dataAttribute]) };
  }

  private recordFromQueryItem<T>(
    item: DynamoItem,
    collection: string,
    parent: Key | undefined,
    codec: Codec<T> | undefined,
  ): ExistingRecord<T> {
    const id = item[this.#table.idAttribute];
    if (!isKeyId(id)) {
      throw new Error("DynamoDB query item is missing the configured DALgo key ID attribute");
    }
    return this.recordFromItem(new Key(collection, id, parent), item, codec);
  }

  private queryOrder<T>(query: StructuredQuery<T>): "asc" | "desc" {
    if (query.orders.length === 0) {
      return "asc";
    }
    if (query.orders.length === 1 && query.orders[0]?.field === DOCUMENT_ID) {
      const direction: unknown = query.orders[0].direction;
      if (direction === "asc" || direction === "desc") {
        return direction;
      }
      throw new TypeError("DynamoDB document ID order direction must be asc or desc");
    }
    throw new UnsupportedError("DynamoDB ordering other than document ID");
  }

  private compileFilters<T>(filters: readonly QueryFilter<T>[], collection: string, parent: Key | undefined): CompiledFilter {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const expressions: string[] = [];
    let documentId: string | undefined;
    for (const [index, filter] of filters.entries()) {
      if (filter.field === DOCUMENT_ID) {
        if (filter.operator !== "==" || !isKeyId(filter.value) || documentId !== undefined) {
          throw new UnsupportedError("DynamoDB document ID filters other than one equality filter");
        }
        documentId = new Key(collection, filter.value, parent).path;
        continue;
      }
      if (typeof filter.field !== "string" || filter.field.length === 0) {
        throw new TypeError("DynamoDB query filter fields must be non-empty strings");
      }
      names["#data"] = this.#table.dataAttribute;
      const nameAlias = `#field${String(index)}`;
      const valueAlias = `:value${String(index)}`;
      names[nameAlias] = filter.field;
      expressions.push(this.filterExpression(filter, `#data.${nameAlias}`, valueAlias, values));
    }
    return {
      ...(expressions.length === 0 ? {} : { expression: expressions.join(" AND ") }),
      names,
      values,
      ...(documentId === undefined ? {} : { documentId }),
    };
  }

  private filterExpression<T>(
    filter: QueryFilter<T>,
    path: string,
    valueAlias: string,
    values: Record<string, unknown>,
  ): string {
    assertNoUndefined(filter.value);
    const addValue = (value: unknown, suffix = ""): string => {
      const alias = valueAlias + suffix;
      values[alias] = value;
      return alias;
    };
    switch (filter.operator) {
      case "==": return `${path} = ${addValue(filter.value)}`;
      case "!=": return `attribute_exists(${path}) AND ${path} <> ${addValue(filter.value)}`;
      case "<": return `${path} < ${addValue(filter.value)}`;
      case "<=": return `${path} <= ${addValue(filter.value)}`;
      case ">": return `${path} > ${addValue(filter.value)}`;
      case ">=": return `${path} >= ${addValue(filter.value)}`;
      case "array-contains": return `contains(${path}, ${addValue(filter.value)})`;
      case "in": return this.membershipExpression(path, filter.value, addValue, false);
      case "not-in": return this.membershipExpression(path, filter.value, addValue, true);
      case "array-contains-any": return this.arrayContainsAnyExpression(path, filter.value, addValue);
      default: throw new UnsupportedError("DynamoDB query operator");
    }
  }

  private membershipExpression(
    path: string,
    value: unknown,
    addValue: (value: unknown, suffix?: string) => string,
    negated: boolean,
  ): string {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
      throw new TypeError("DynamoDB membership filters require an array of 1 to 100 values");
    }
    const aliases = value.map((entry, index) => addValue(entry, String(index)));
    const expression = `${path} IN (${aliases.join(", ")})`;
    return negated ? `attribute_exists(${path}) AND NOT (${expression})` : expression;
  }

  private arrayContainsAnyExpression(
    path: string,
    value: unknown,
    addValue: (value: unknown, suffix?: string) => string,
  ): string {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
      throw new TypeError("DynamoDB array-contains-any filters require an array of 1 to 100 values");
    }
    return "(" + value.map((entry, index) => `contains(${path}, ${addValue(entry, String(index))})`).join(" OR ") + ")";
  }

  private cursorFor(key: DynamoItem, collectionPath: string): QueryCursor {
    const partitionValue = key[this.#table.partitionKey];
    const sortValue = key[this.#table.sortKey];
    if (typeof partitionValue !== "string" || typeof sortValue !== "string") {
      throw new Error("DynamoDB query response is missing configured string key attributes");
    }
    return {
      values: [{
        adapter: "@dal-go/dalgo2dynamodb",
        version: 1,
        tableName: this.#table.tableName,
        collectionPath,
        partitionValue,
        sortValue,
      } satisfies DynamoCursor],
    };
  }

  private cursorFromQuery(cursor: QueryCursor | undefined, collectionPath: string): DynamoCursor | undefined {
    if (cursor === undefined) {
      return undefined;
    }
    if (cursor.values.length !== 1 || !isPlainDocument(cursor.values[0])) {
      throw new TypeError("DynamoDB startAfter must be a cursor returned by this adapter");
    }
    const value = requiredItem(cursor.values[0], "cursor");
    if (
      value.adapter !== "@dal-go/dalgo2dynamodb"
      || value.version !== 1
      || value.tableName !== this.#table.tableName
      || value.collectionPath !== collectionPath
      || typeof value.partitionValue !== "string"
      || typeof value.sortValue !== "string"
    ) {
      throw new TypeError("DynamoDB startAfter does not belong to this table and collection");
    }
    return {
      adapter: "@dal-go/dalgo2dynamodb",
      version: 1,
      tableName: value.tableName,
      collectionPath: value.collectionPath,
      partitionValue: value.partitionValue,
      sortValue: value.sortValue,
    };
  }

  private cursorKey(cursor: DynamoCursor): DynamoItem {
    return {
      [this.#table.partitionKey]: cursor.partitionValue,
      [this.#table.sortKey]: cursor.sortValue,
    };
  }
}
