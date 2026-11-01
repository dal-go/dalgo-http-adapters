import { key, collection, Key, UnsupportedError } from "@dalgo/core";
import { NumberValue } from "@aws-sdk/lib-dynamodb";
import { QueryCancelledError, isCancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { DynamoDbDatabase } from "@dal-go/dalgo2dynamodb";

export async function verifyBrowserRoots() {
  let calls = 0, destroys = 0;
  const exact = NumberValue.from("9007199254740993.0001");
  const data = { exact, big: 9007199254740993n, bytes: new Uint8Array([0,255]), values: new Set(["x","y"]) };
  const borrowed = {
    send(command) {
      calls++;
      if (command.input.Key?.sk !== "items/one") throw new Error("unexpected selected browser command");
      return Promise.resolve({ Item: { pk:"items",sk:"items/one",__dalgo_id:"one",data } });
    },
    destroy() { destroys++; throw new Error("borrowed client destroyed"); },
  };
  const db = new DynamoDbDatabase(borrowed,{tableName:"owned"});
  if (!isCancellableQueryExecutor(db) || calls!==0) throw new Error("root import or constructor invoked SDK");
  let callback = false, failure;
  try { await db.runReadwriteTransaction(async () => { callback=true; }); } catch(error) { failure=error; }
  if (!(failure instanceof UnsupportedError) || callback) throw new Error("core callback refusal identity changed");
  const abort = new AbortController(); abort.abort("synthetic-secret-caller-reason");
  for(const read of [
    () => db.getWithSignal(key("items","one"),abort.signal),
    () => db.getManyWithSignal([key("items","one")],abort.signal),
    () => db.queryWithSignal(collection("items").query().limit(1).build(),abort.signal),
  ]) {
    failure=undefined;
    try { await read(); } catch(error) { failure=error; }
    if (!(failure instanceof QueryCancelledError) || failure.reason!=="caller" || failure.message.includes("synthetic-secret")) throw new Error("public cancellation identity changed");
  }
  if(calls!==0) throw new Error("preabort invoked SDK");
  const result = await db.get(key("items","one"));
  if(!result.exists || !(result.key instanceof Key) || result.data.exact!==exact || exact.toString()!=="9007199254740993.0001" || result.data.big!==9007199254740993n || result.data.bytes[1]!==255 || result.data.values.size!==2 || calls!==1 || destroys!==0) throw new Error("browser parsed native values changed");
  return {coreAndErrorIdentity:true,lazy:true,parsedNativeValues:true};
}
