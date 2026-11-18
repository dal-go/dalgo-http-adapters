// Runs ONLY as the owned child with/without its synthetic Node EXTRA_CA_CERTS.
import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { CloudflareKvRestDatabase, QueryCancelledError } from "@dalgo/cloudflare-kv/node";
import { QueryCancelledError as PublicCancellation } from "@dalgo/adapter-runtime";
assert.equal(QueryCancelledError,PublicCancellation);
const [mode,directory]=process.argv.slice(2);assert.ok(mode==="trusted"||mode==="untrusted");assert.ok(directory?.startsWith("/"));
const token=process.env.KV_DEFAULT_FIXTURE_TOKEN;assert.ok(typeof token==="string"&&token.length>=24);
const config={accountId:"ownedaccount",namespaceId:"ownednamespace",allowedPrefixes:["tenant:"],maxConcurrent:1,maxValueBytes:1024,maxResponseBytes:4096,timeoutMs:2000,token(signal){signal.throwIfAborted();return token;}};
assert.ok(!Object.hasOwn(config,"fetch")&&!Object.hasOwn(config,"endpoint")&&!Object.hasOwn(config,"allowLoopbackHttpForTesting"),"must use actual default provider transport");
const database=new CloudflareKvRestDatabase(config),others=[];
async function stats(){const path=join(directory,"stats.json"),info=await lstat(path);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size<8192);return JSON.parse(await readFile(path,"utf8"));}
async function observe(predicate){const end=performance.now()+2500;while(performance.now()<end){const value=await stats();assert.equal(value.protocolFailures,0);if(predicate(value))return value;await delay(20);}throw new Error("owned server ACK missing");}
function safeFailure(error){assert.ok(!String(error).includes(token)&&!String(error).includes("PRIVATE_PROVIDER_DETAIL")&&!Object.hasOwn(error,"cause"));return true;}
try {
 const initial=await stats();assert.equal(initial.requests,0);
 if(mode==="untrusted"){
  assert.equal(process.env.NODE_EXTRA_CA_CERTS,undefined);
  await assert.rejects(database.get("tenant:a"),error=>safeFailure(error)&&error.code==="transport");
  const final=await observe(value=>value.liveConnections===0);assert.equal(final.requests,0);
  console.log(JSON.stringify({passed:true,mode,tlsNegative:true,requests:0,defaultAuthority:true}));
 }else{
  assert.equal(process.env.NODE_EXTRA_CA_CERTS,join(directory,"ca.pem"));
  assert.deepEqual((await database.get("tenant:a")).value,Uint8Array.of(0,255,128));assert.equal((await database.get("tenant:a")).expiration,123);
  const rows=await database.getMany(["tenant:a","tenant:empty","tenant:a","tenant:🌍"]);assert.deepEqual(rows[0].value,Uint8Array.of(0,255,128));assert.equal(rows[1].value.byteLength,0);assert.notEqual(rows[0].value,rows[2].value);assert.deepEqual(rows[3].value,Uint8Array.of(240,159,140,141));
  const first=await database.list({prefix:"tenant:",limit:10});assert.equal(first.complete,false);assert.deepEqual(first.keys,[]);assert.match(first.nextCursor,/^[a-f0-9]{48}$/u);assert.notEqual(first.nextCursor,"owned-provider-page");
  const last=await database.list({prefix:"tenant:",limit:10,cursor:first.nextCursor});assert.equal(last.complete,true);assert.equal(last.nextCursor,undefined);assert.deepEqual(last.keys.map(item=>item.name),["tenant:a","tenant:empty","tenant:🌍"]);assert.equal(last.keys[0].metadata,false);
  for(const [key,status] of [["tenant:missing",404],["tenant:denied",403]])await assert.rejects(database.get(key),error=>safeFailure(error)&&error.status===status);
  await assert.rejects(database.get("tenant:oversize"),error=>safeFailure(error)&&error.code==="bounds");
  const wrong=new CloudflareKvRestDatabase({...config,token:()=>"wrong-synthetic-owned-reader"});others.push(wrong);await assert.rejects(wrong.get("tenant:a"),error=>safeFailure(error)&&error.status===403);
  const before=await stats();await assert.rejects(database.get("foreign:a"),error=>error.code==="permission");await assert.rejects(database.list({prefix:"tenant:",limit:1}),error=>error.code==="bounds");assert.equal((await stats()).requests,before.requests);
  for(const deadline of [false,true]){
   const client=deadline?new CloudflareKvRestDatabase({...config,timeoutMs:500}):database;if(deadline)others.push(client);
   const caller=new AbortController(),beforeSlow=await stats();
   const read=client.get("tenant:slow",caller.signal),rejected=assert.rejects(read,error=>safeFailure(error)&&error instanceof PublicCancellation&&error.reason===(deadline?"deadline":"caller"));
   await observe(value=>value.slowStarted===beforeSlow.slowStarted+1);const started=performance.now();if(!deadline)caller.abort("PRIVATE_CALLER_REASON");await rejected;assert.ok(performance.now()-started<750);
   await observe(value=>value.slowDisconnected===beforeSlow.slowDisconnected+1&&value.liveConnections===0);await nextTurn();assert.deepEqual((await client.get("tenant:a")).value,Uint8Array.of(0,255,128));
  }
  const final=await observe(value=>value.liveConnections===0);assert.equal(final.slowStarted,2);assert.equal(final.slowDisconnected,2);assert.equal(final.protocolFailures,0);
  assert.equal(final.dataCount,initial.dataCount);assert.equal(final.dataSha256,initial.dataSha256);
  console.log(JSON.stringify({passed:true,mode,defaultAuthority:true,defaultOwnedNodeTransport:true,verifiedTLS:true,rawBytes:true,metadataAndOpaqueEOF:true,no404MissingGuess:true,noRetryOrRedirectFallback:true,noIORefusals:true,callerAfterObservedDispatch:true,deadlineAfterObservedDispatch:true,disconnects:2,reuse:true,requests:final.requests,liveConnections:0,dataCount:final.dataCount,dataSha256:final.dataSha256,actualCloudflare:false}));
 }
}finally{database.close();for(const client of others)client.close();}
