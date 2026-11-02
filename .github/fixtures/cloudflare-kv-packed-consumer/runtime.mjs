// Actual clean installed SOURCE artifact, owned Node HTTP bridge/fake binding.
// No workerd, hosted KV, Cloudflare account, cache consistency or browser claim.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Key, UnsupportedError } from "@dalgo/core";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { WorkersKvDatabase, CloudflareKvError, QueryCancelledError as AdapterCancellation } from "@dalgo/cloudflare-kv";
import { CloudflareKvHttpDatabase } from "@dalgo/cloudflare-kv/browser";
import { createCloudflareKvHttpHandler, CloudflareKvRestDatabase } from "@dalgo/cloudflare-kv/node";

assert.equal(AdapterCancellation, QueryCancelledError);
const options={allowedPrefixes:["tenant:"]};
function gate(){let resolve;const promise=new Promise(accept=>{resolve=accept;});return{promise,resolve};}
async function bounded(promise,ms=2500){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("owned ACK missing")),ms);})]);}finally{clearTimeout(timer);}}
const bytes=(value=[0,255,128])=>new ReadableStream({start(controller){controller.enqueue(Uint8Array.from(value));controller.close();}});
let calls=0;
const namespace={
 getWithMetadata(key){assert.equal(this,namespace);calls++;return Promise.resolve(key.endsWith("missing")?{value:null,metadata:null}:{value:bytes(key.endsWith("empty")?[]:undefined),metadata:{nested:[false,null,3]}});},
 list(){return Promise.resolve({keys:[{name:"tenant:a",metadata:false,expiration:123}],list_complete:true});},
};
const database=new WorkersKvDatabase(namespace,options);
try {
 const rows=await database.getMany(["tenant:a","tenant:missing","tenant:a","tenant:empty"]);
 assert.deepEqual(rows[0].value,Uint8Array.of(0,255,128));assert.equal(rows[1],null);assert.equal(rows[3].value.byteLength,0);
 assert.deepEqual(JSON.parse(JSON.stringify(rows[0].metadata)),{nested:[false,null,3]});assert.notEqual(rows[0],rows[2]);assert.notEqual(rows[0].value,rows[2].value);rows[0].value.fill(7);assert.deepEqual(rows[2].value,Uint8Array.of(0,255,128));
 assert.equal(await database.exists("tenant:missing"),false);await database.testConnection("tenant:a");
 const row=await database.asDatabase("items").get(new Key("items","tenant:a"));assert.equal(row.exists,true);assert.deepEqual(row.data,Uint8Array.of(0,255,128));
 let callback=false;await assert.rejects(database.asDatabase("items").runReadwriteTransaction(async()=>{callback=true;}),UnsupportedError);assert.equal(callback,false);
 const before=calls;const aborted=new AbortController();aborted.abort("PRIVATE_CALLER");
 await assert.rejects(database.get("tenant:a",aborted.signal),error=>error instanceof QueryCancelledError&&error.reason==="caller"&&!error.message.includes("PRIVATE_CALLER"));
 await assert.rejects(database.get("foreign:a"),error=>error instanceof CloudflareKvError&&error.code==="permission");assert.equal(calls,before);
}finally{database.close();}

// Native EOF, original UTF8 byte ordering, cursor scope and failed delivery ACK.
let listCalls=0;
const listing={getWithMetadata:namespace.getWithMetadata,list(input){listCalls++;return Promise.resolve(input.cursor===undefined?{keys:[],list_complete:false,cursor:"opaque-one"}:{keys:[{name:"tenant:\ue000"},{name:"tenant:𐀀",metadata:null}],list_complete:true});}};
const pages=new WorkersKvDatabase(listing,options);
try {
 const first=await pages.list({prefix:"tenant:",limit:2});assert.deepEqual(first.keys,[]);assert.equal(first.complete,false);assert.match(first.nextCursor,/^[a-f0-9]{48}$/u);
 await assert.rejects(pages.list({prefix:"tenant:x",limit:2,cursor:first.nextCursor}),error=>error.code==="input");assert.equal(listCalls,1);
 const abort=new AbortController();await assert.rejects(pages.mapList({prefix:"tenant:",limit:2,cursor:first.nextCursor},()=>{abort.abort();return true;},abort.signal),error=>error instanceof QueryCancelledError&&error.reason==="caller");
 const last=await pages.list({prefix:"tenant:",limit:2,cursor:first.nextCursor});assert.equal(last.complete,true);assert.equal(last.nextCursor,undefined);assert.deepEqual(last.keys.map(key=>key.name),["tenant:\ue000","tenant:𐀀"]);
 await assert.rejects(pages.list({prefix:"tenant:",limit:2,cursor:first.nextCursor}),error=>error.code==="input");
}finally{pages.close();}
let quotaCalls=0;
const quotaBinding={getWithMetadata:namespace.getWithMetadata,list(){const n=++quotaCalls;return Promise.resolve(n===1?{keys:[{name:"tenant:a"}],list_complete:false,cursor:"one"}:n===2?{keys:[{name:"tenant:b"}],list_complete:false,cursor:"two"}:{keys:[{name:"tenant:b"}],list_complete:true});}};
const quota=new WorkersKvDatabase(quotaBinding,{...options,maxCursorNodes:8,maxPages:3});
try {const first=await quota.list({prefix:"tenant:",limit:1});await assert.rejects(quota.list({prefix:"tenant:",limit:1,cursor:first.nextCursor}),error=>error.code==="bounds");assert.equal((await quota.list({prefix:"tenant:",limit:1,cursor:first.nextCursor})).complete,true);assert.equal(quotaCalls,3);}finally{quota.close();}

// Ignored real foreign promise/hostile cancel remains physically admitted.
const started=gate(),late=gate(),cleanupEntered=gate(),cleanupRelease=gate();let bindingCalls=0;
const borrowed={getWithMetadata(){if(++bindingCalls===1){started.resolve();return late.promise;}return Promise.resolve({value:bytes(),metadata:null});},list:namespace.list};
const retained=new WorkersKvDatabase(borrowed,{...options,maxConcurrent:1});
try {
 const caller=new AbortController(),pending=retained.get("tenant:a",caller.signal);const rejection=assert.rejects(pending,error=>error instanceof QueryCancelledError&&error.reason==="caller");await bounded(started.promise);caller.abort();await bounded(rejection);
 await assert.rejects(retained.get("tenant:b"),error=>error.code==="busy");assert.equal(bindingCalls,1);
 late.resolve({value:new ReadableStream({cancel(){cleanupEntered.resolve();return cleanupRelease.promise;}}),metadata:null});await bounded(cleanupEntered.promise);
 await assert.rejects(retained.get("tenant:b"),error=>error.code==="busy");cleanupRelease.resolve();await nextTurn();assert.deepEqual((await retained.get("tenant:b")).value,Uint8Array.of(0,255,128));
}finally{cleanupRelease.resolve();retained.close();}
// The installed Node API also retains a token callback that ignores its signal.
const tokenStarted=gate(),tokenPending=gate();let tokenCalls=0,tokenFetches=0;
const credentials=new CloudflareKvRestDatabase({...options,accountId:"account",namespaceId:"namespace",maxConcurrent:1,token(){if(++tokenCalls===1){tokenStarted.resolve();return tokenPending.promise;}return "synthetic-private-reader";},fetch(){tokenFetches++;return Promise.resolve(new Response(Uint8Array.of(0,255,128)));}});
try {
 const caller=new AbortController(),pending=credentials.get("tenant:a",caller.signal),rejection=assert.rejects(pending,error=>error instanceof QueryCancelledError&&error.reason==="caller");
 await bounded(tokenStarted.promise);caller.abort();await bounded(rejection);await assert.rejects(credentials.get("tenant:b"),error=>error.code==="busy");assert.equal(tokenFetches,0);
 tokenPending.resolve("synthetic-late-private-reader");await nextTurn();assert.equal(tokenFetches,0);assert.deepEqual((await credentials.get("tenant:b")).value,Uint8Array.of(0,255,128));assert.equal(tokenFetches,1);
}finally{tokenPending.resolve("synthetic-release");credentials.close();}
// A synchronous provider crossing elapsed deadline cannot dispatch/deliver,
// independent of a timer callback being serviced. Restore the real clock.
const previousNow=Object.getOwnPropertyDescriptor(performance,"now");let now=0,deadlineCalls=0;
Object.defineProperty(performance,"now",{configurable:true,value:()=>now});
const expired=new WorkersKvDatabase({getWithMetadata(){deadlineCalls++;now=11;return Promise.resolve({value:bytes(),metadata:null});},list:namespace.list},{...options,timeoutMs:10});
try{await assert.rejects(expired.get("tenant:a"),error=>error instanceof QueryCancelledError&&error.reason==="deadline");assert.equal(deadlineCalls,1);}finally{expired.close();if(previousNow)Object.defineProperty(performance,"now",previousNow);else delete performance.now;}

// A real owned loopback HTTP server hosts only a fixed-authority bridge.
// No account/token/endpoint/prefix grant is accepted from client descriptors.
const bridgeNative=new WorkersKvDatabase(namespace,options);let authorized=0,serverFailure=false;
const handler=createCloudflareKvHttpHandler({authorize(request){authorized++;return request.headers.get("authorization")==="Bearer application-session"?bridgeNative:undefined;}});
const sockets=new Set(),socketCloseAcks=new Set();let shuttingDown=false;
const server=createServer((incoming,outgoing)=>{
 const controller=new AbortController();incoming.once("aborted",()=>controller.abort());outgoing.once("close",()=>{if(!outgoing.writableFinished)controller.abort();});
 void (async()=>{
  const request=new Request("http://127.0.0.1/kv",{method:incoming.method,headers:incoming.headers,body:Readable.toWeb(incoming),duplex:"half",signal:controller.signal});
  const result=await handler(request);if(outgoing.destroyed)return;outgoing.writeHead(result.status,Object.fromEntries(result.headers));
  if(result.body===null)outgoing.end();else Readable.fromWeb(result.body).on("error",()=>{serverFailure=true;outgoing.destroy();}).pipe(outgoing);
 })().catch(()=>{serverFailure=true;outgoing.destroy();});
});
server.on("connection",socket=>{
 sockets.add(socket);
 // Register the acknowledgement before a shutdown flag can destroy a late
 // accepted socket; server.close's callback alone is not a close-event ACK.
 socketCloseAcks.add(new Promise(resolve=>{socket.once("close",()=>{sockets.delete(socket);resolve();});}));
 if(shuttingDown)socket.destroy();
});
await bounded(new Promise(resolve=>server.listen(0,"127.0.0.1",resolve)));const address=server.address();assert.ok(address&&typeof address==="object");
const endpoint=`http://127.0.0.1:${address.port}/kv`;
const client=new CloudflareKvHttpDatabase({endpoint,allowLoopbackHttpForTesting:true,headers:()=>({authorization:"Bearer application-session"})});
const anonymous=new CloudflareKvHttpDatabase({endpoint,allowLoopbackHttpForTesting:true});
try {
 const beforeAuth=authorized;const malformed=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"getMany",keys:["tenant:a"],accountId:"other",token:"PRIVATE_CF_API_TOKEN"})});assert.equal(malformed.status,400);await malformed.arrayBuffer();assert.equal(authorized,beforeAuth);
 await assert.rejects(anonymous.get("tenant:a"),error=>error.code==="permission");
 const rows=await client.getMany(["tenant:a","tenant:missing","tenant:a","tenant:empty"]);assert.deepEqual(rows[0].value,Uint8Array.of(0,255,128));assert.equal(rows[1],null);assert.equal(rows[3].value.byteLength,0);assert.notEqual(rows[0].value,rows[2].value);
 assert.deepEqual(JSON.parse(JSON.stringify(rows[0].metadata)),{nested:[false,null,3]});assert.equal((await client.list({prefix:"tenant:",limit:1})).keys[0].metadata,false);
 await assert.rejects(client.get("foreign:a"),error=>error.code==="permission");
}finally{
 client.close();anonymous.close();bridgeNative.close();shuttingDown=true;
 const serverClosed=new Promise(resolve=>server.close(resolve));
 server.closeAllConnections();
 await bounded((async()=>{
  await serverClosed;
  // A connection accepted during shutdown is also registered above and
  // destroyed. Wait for every positive socket close ACK before asserting0.
  let acknowledged=-1;
  while(acknowledged!==socketCloseAcks.size){acknowledged=socketCloseAcks.size;await Promise.all([...socketCloseAcks]);}
 })());
}
assert.equal(serverFailure,false);assert.equal(sockets.size,0);
console.log(JSON.stringify({coreAndPublicErrorIdentity:true,nativeBytesMissingMetadataDuplicates:true,nativeOpaqueEOFAndUtf8:true,preAckFailureAndQuotaRecovery:true,wholeOperationCancellation:true,retainedPhysicalLeases:true,monotonicDeadline:true,mandatoryFixedAuthorityServedHTTP:true,browserByteRoundTrip:true,cleanup:true,actualWorkersEngine:false,actualCloudflare:false,defaultOwnedNodeTLS:"SEPARATE_ROOT_GATE"}));
