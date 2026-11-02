import { Key, UnsupportedError } from "@dalgo/core";
import { QueryCancelledError as PublicCancellation } from "@dalgo/adapter-runtime";
import * as roots from "@dalgo/cloudflare-kv";
import * as browser from "@dalgo/cloudflare-kv/browser";
export async function verifyBrowserRoots() {
 let calls=0;
 const namespace={ getWithMetadata(){calls++;throw new Error("unexpected binding I/O");},list(){calls++;throw new Error("unexpected binding I/O");} };
 const native=new roots.WorkersKvDatabase(namespace,{allowedPrefixes:["tenant:"]});
 const http=new browser.CloudflareKvHttpDatabase({endpoint:"https://app.example.test/kv",headers(){calls++;throw new Error("unexpected application auth");}});
 if (roots.QueryCancelledError!==PublicCancellation || browser.QueryCancelledError!==PublicCancellation || "CloudflareKvRestDatabase" in roots || "CloudflareKvRestDatabase" in browser || "createCloudflareKvHttpHandler" in browser) throw new Error("public runtime boundary changed");
 const caller=new AbortController();caller.abort("private-browser-cause");
 for (const read of [()=>native.get("tenant:a",caller.signal),()=>native.getMany(["tenant:a"],caller.signal),()=>native.list({prefix:"tenant:",limit:1},caller.signal),()=>http.get("tenant:a",caller.signal),()=>http.list({prefix:"tenant:",limit:1},caller.signal),()=>native.asDatabase("items").getWithSignal(new Key("items","tenant:a"),caller.signal)]) {
  let rejected;
  try{await read();}catch(error){rejected=error;}
  if (!(rejected instanceof PublicCancellation)||rejected.reason!=="caller"||rejected.message.includes("private-browser-cause")||Object.hasOwn(rejected,"cause")) throw new Error("public cancellation identity changed");
 }
 let invoked=false,failure;
 try{await native.asDatabase("items").runReadwriteTransaction(async()=>{invoked=true;});}catch(error){failure=error;}
 if (!(failure instanceof UnsupportedError)||invoked||calls!==0) throw new Error("unsupported transaction or preabort performed work");
 native.close();http.close();return {coreAndPublicErrorIdentity:true,lazy:true};
}
