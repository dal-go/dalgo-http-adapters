import { UnsupportedError, collection, key } from "@dalgo/core";

import { CouchDbHttpError, NativeCouchDbDatabase } from "../src/index.js";

export interface NativeBrowserConfig {
  readonly url: string;
  readonly user: string;
  readonly password: string;
  readonly indexDdoc: string;
  readonly indexName: string;
}

function authorization(config: NativeBrowserConfig, password = config.password): string {
  return `Basic ${btoa(`${config.user}:${password}`)}`;
}

function database(config: NativeBrowserConfig, password = config.password): NativeCouchDbDatabase {
  return new NativeCouchDbDatabase({
    databaseUrl: config.url,
    collection: "items",
    headers: () => ({ authorization: authorization(config, password) }),
    timeoutMs: 10_000,
    permittedIndexes: [{
      ddoc: config.indexDdoc,
      name: config.indexName,
      fields: [
        { field: "status", direction: "asc" },
        { field: "_id", direction: "asc" },
      ],
    }],
  });
}

/** The proof deliberately uses the real browser `fetch`, not an injected transport. */
export async function runNativeBrowserProof(config: NativeBrowserConfig) {
  const db = database(config);
  const items = collection<{ title: string; status?: string; nullable?: string | null }>("items");
  const milk = await db.get(key("items", "milk"));
  const space = await db.get(key("items", "id with space"));
  const slash = await db.get(key("items", "id/slash"));
  const many = await db.getMany([key("items", "milk"), key("items", "does-not-exist"), key("items", "eggs")]);

  const nulls = await db.query({ ...items.query().where("nullable", "==", null).limit(10).build() });
  const nonNulls = await db.query({ ...items.query().where("nullable", "!=", null).limit(10).build() });
  const projected = await db.query({ ...items.query().where("status", "==", "open").limit(2).build(), projection: ["_id", "title"] });

  const first = await db.query(items.query().where("status", "==", "open").orderBy("status").limit(2).build());
  const cursor = first.nextCursor?.values[0];
  if (typeof cursor !== "string") throw new Error("browser native query returned no cursor");
  const second = await db.query(items.query().where("status", "==", "open").orderBy("status").limit(2).startAfter(cursor).build());
  let repeatedRejected = false;
  try {
    await db.query(items.query().where("status", "==", "open").orderBy("status").limit(2).startAfter(cursor).build());
  } catch (error) {
    repeatedRejected = error instanceof TypeError;
  }

  const connection = await db.testConnection();
  const indexes = await db.listIndexes();
  const fields = await db.sampleFields();
  const described = await db.describe();

  const mutationRefusals = [
    await db.insert(key("items", "browser-write-probe"), { title: "no" }).then(() => false, (error: unknown) => error instanceof UnsupportedError),
    await db.set(key("items", "browser-write-probe"), { title: "no" }).then(() => false, (error: unknown) => error instanceof UnsupportedError),
    await db.update(key("items", "browser-write-probe"), { title: "no" }).then(() => false, (error: unknown) => error instanceof UnsupportedError),
    await db.delete(key("items", "browser-write-probe")).then(() => false, (error: unknown) => error instanceof UnsupportedError),
  ];

  const bad = database({ ...config, user: "browser-no-such-user", password: "wrong-browser-password" });
  let badAuthStatus: number | undefined;
  try { await bad.get(key("items", "milk")); } catch (error) {
    if (error instanceof CouchDbHttpError) badAuthStatus = error.status;
  }
  const badConnection = await bad.testConnection();
  const writeProbe = await db.get(key("items", "browser-write-probe"));

  return {
    origin: location.origin,
    couch: config.url,
    read: {
      milk: milk.exists && milk.key.id === "milk" && milk.data._id === "milk" && typeof milk.data._rev === "string",
      space: space.exists && space.key.id === "id with space" && space.data._id === "id with space",
      slash: slash.exists && slash.key.id === "id/slash" && slash.data._id === "id/slash",
      getMany: many.length === 3 && many[0]?.exists === true && many[1]?.exists === false && many[2]?.exists === true,
    },
    query: {
      explicitNull: nulls.records.map((record) => record.key.id),
      presentNotNull: nonNulls.records.map((record) => record.key.id),
      projection: projected.records.map((record) => record.data),
      firstPage: first.records.map((record) => record.key.id),
      secondPage: second.records.map((record) => record.key.id),
      repeatedRejected,
    },
    metadata: {
      connection: connection.ok && connection.database.database === "app",
      indexes: indexes.status === "available" ? indexes.indexes.map((index) => index.name) : indexes.status,
      fields: fields.status === "sampled" ? fields.fields : fields.status,
      described: described.storage === "native-rows" && described.readOnly === true,
    },
    readOnly: {
      mutationRefusals,
      writeProbeExists: writeProbe.exists,
      badAuthStatus,
      badConnection: badConnection.ok === false ? badConnection.reason : "unexpected-ok",
    },
  };
}
