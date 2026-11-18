import { encodeNativeCosmosJson, NativeCosmosNoSqlDatabase, nativeCosmosResourceToken } from "../src/index.js";

/** Broker is supplied by the trusted application; this example creates no account. */
export async function readExisting(broker: (signal: AbortSignal) => Promise<string>): Promise<string | undefined> {
  const database = new NativeCosmosNoSqlDatabase({
    endpoint: "https://your-account.documents.azure.com", databaseId: "app", containerId: "items",
    partitionKeyField: "tenant", authScopeId: "trusted-user-principal",
    authorization: async ({ signal }) => nativeCosmosResourceToken(await broker(signal)),
  });
  try {
    const result = await database.getNative({ id: "original-id", partition: "tenant:a" });
    return result.document === null ? undefined : encodeNativeCosmosJson(result.document.data);
  } finally { database.close(); }
}
