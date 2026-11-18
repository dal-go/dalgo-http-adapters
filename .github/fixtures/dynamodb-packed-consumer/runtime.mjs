// Actual packed adapter + official SDK middleware and owned request handler.
// This performs no network/AWS/IAM call and is not DynamoDB Local/hosted proof.
import assert from "node:assert/strict";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, NumberValue } from "@aws-sdk/lib-dynamodb";
import { collection, key, Key, UnsupportedError } from "@dalgo/core";
import { QueryCancelledError, isCancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { DynamoDbDatabase, DynamoDbReadError } from "@dal-go/dalgo2dynamodb";

const secret="synthetic-private-sdk-detail";
const credentials={accessKeyId:"SYNTHETICFIXTUREKEY",secretAccessKey:"synthetic-fixture-signing-secret",sessionToken:"synthetic-fixture-session"};
let requests=0,destroys=0,dispatch,acknowledge;
const active=new Set(), controllers=new Set(), work=[];
function deferred(){ let resolve,reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }
async function bounded(promise,ms=3000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("owned SDK fixture deadline")),ms);})]);}finally{clearTimeout(timer);}}
function rawItem(id){return {pk:{S:"items"},sk:{S:`items/${id}`},__dalgo_id:{S:id},data:{M:{value:{S:id==="one"?"Milk":"Tea"},state:{S:"open"},exact:{N:"9007199254740993.0001"},bytes:{B:"AP+A"},flag:{BOOL:false},empty:{NULL:true},values:{SS:["x","y"]}}}};}
function response(value){return {response:{statusCode:200,headers:{"content-type":"application/x-amz-json-1.0","x-amzn-requestid":"owned-fixture"},body:new TextEncoder().encode(JSON.stringify(value))}};}
const handler={
  metadata:{handlerProtocol:"http/1.1"},
  destroy(){destroys++;throw new Error("borrowed SDK handler destroyed");},
  async handle(request,options){
    requests++;
    const headers=Object.fromEntries(Object.entries(request.headers).map(([name,value])=>[name.toLowerCase(),value]));
    assert.equal(Object.keys(headers).length,Object.keys(request.headers).length,"no ambiguous duplicate header casing");
    assert.equal(request.hostname,"owned-dynamodb.invalid"); assert.equal(request.protocol,"https:");
    assert.equal(request.method,"POST"); assert.equal(request.path,"/");
    assert.equal(headers["content-type"],"application/x-amz-json-1.0");
    assert.match(headers.authorization,/^AWS4-HMAC-SHA256 Credential=SYNTHETICFIXTUREKEY\/[0-9]{8}\/us-east-1\/dynamodb\/aws4_request,/u);
    assert.equal(headers["x-amz-security-token"],credentials.sessionToken);
    assert.equal(headers.cookie,undefined);
    const encoded=typeof request.body==="string"?request.body:new TextDecoder().decode(request.body);
    assert.ok(new TextEncoder().encode(encoded).length<=4096);
    const body=JSON.parse(encoded),target=headers["x-amz-target"];
    assert.equal(body.TableName??Object.keys(body.RequestItems??{})[0],"owned");
    if(target==="DynamoDB_20120810.GetItem"){
      const id=body.Key.sk.S.slice("items/".length);
      assert.deepEqual(body.Key,{pk:{S:"items"},sk:{S:`items/${id}`}});
      if(id.startsWith("slow-")){
        const pending=deferred(); let stopped=false;
        const entry={stop(){if(stopped)return;stopped=true;options.abortSignal.removeEventListener("abort",abort);active.delete(entry);pending.reject(new Error(secret));}};
        const abort=()=>{entry.stop();acknowledge?.();};
        active.add(entry); options.abortSignal.addEventListener("abort",abort,{once:true});
        assert.equal(options.abortSignal.aborted,false,"after-dispatch fixture starts with a live signal");
        dispatch?.(); return await pending.promise;
      }
      return response(id==="missing"?{}:{Item:rawItem(id)});
    }
    if(target==="DynamoDB_20120810.BatchGetItem"){
      const keys=body.RequestItems.owned.Keys;
      assert.equal(keys.length,3); assert.equal(new Set(keys.map(item=>item.sk.S)).size,3);
      assert.deepEqual(keys.map(item=>item.sk.S),["items/one","items/missing","items/two"]);
      return response({Responses:{owned:[rawItem("two"),rawItem("one")]}});
    }
    assert.equal(target,"DynamoDB_20120810.Query");
    assert.equal(body.KeyConditionExpression,"#pk = :collection");
    assert.deepEqual(body.ExpressionAttributeValues[":collection"],{S:"items"});
    assert.equal(body.Limit,1);
    if(body.ExclusiveStartKey?.sk.S==="items/one") return response({Items:[rawItem("two")]});
    if(body.ExclusiveStartKey?.sk.S==="items/empty") return response({Items:[rawItem("one")],LastEvaluatedKey:{pk:{S:"items"},sk:{S:"items/one"}}});
    assert.equal(body.FilterExpression,"#data.#field0 = :value0");
    assert.equal(body.ExpressionAttributeNames["#field0"],"state");
    assert.deepEqual(body.ExpressionAttributeValues[":value0"],{S:"open"});
    return response({Items:[],LastEvaluatedKey:{pk:{S:"items"},sk:{S:"items/empty"}}});
  },
};
const sdk=new DynamoDBClient({region:"us-east-1",endpoint:"https://owned-dynamodb.invalid",credentials,maxAttempts:1,requestHandler:handler});
const client=DynamoDBDocumentClient.from(sdk,{unmarshallOptions:{wrapNumbers:true}});
const options={tableName:"owned",timeoutMs:2000,maxReadRecords:1000,maxReadBytes:4000000};
const db=new DynamoDbDatabase(client,options);
const requested=key("items","one");
try{
  assert.ok(isCancellableQueryExecutor(db));
  let result=await bounded(db.get(requested));
  assert.equal(result.key,requested); assert.ok(result.key instanceof Key);
  assert.equal(result.data.value,"Milk"); assert.ok(result.data.exact instanceof NumberValue);
  assert.equal(result.data.exact.toString(),"9007199254740993.0001");
  assert.deepEqual([...result.data.bytes],[0,255,128]); assert.equal(result.data.flag,false); assert.equal(result.data.empty,null);
  assert.deepEqual([...result.data.values],["x","y"]);
  const many=await bounded(db.getMany([requested,key("items","missing"),requested,key("items","two")]));
  assert.deepEqual(many.map(item=>[item.key.id,item.exists?item.data.value:null]),[["one","Milk"],["missing",null],["one","Milk"],["two","Tea"]]);
  const query=collection("items").query().where("state","==","open").limit(1);
  const page=await bounded(db.query(query.build()));
  assert.equal(page.records[0].key.id,"one"); assert.ok(page.records[0].key instanceof Key); assert.ok(page.nextCursor);
  const next=await bounded(db.query(query.startAfter(...page.nextCursor.values).build()));
  assert.equal(next.records[0].key.id,"two"); assert.equal(next.nextCursor,undefined);
  const before=requests; let callback=false;
  await assert.rejects(db.runReadwriteTransaction(async()=>{callback=true;}),UnsupportedError);
  await assert.rejects(db.query(collection("items").query().orderBy("value").build()),UnsupportedError);
  assert.equal(callback,false); assert.equal(requests,before);
  for(const deadline of [false,true]){
    const abort=new AbortController();controllers.add(abort);
    const dispatched=deferred(),disconnected=deferred();dispatch=dispatched.resolve;acknowledge=disconnected.resolve;
    const target=new DynamoDbDatabase(client,{...options,timeoutMs:deadline?400:2000});
    const pending=target.getWithSignal(key("items",deadline?"slow-deadline":"slow-caller"),abort.signal);work.push(pending);
    const rejected=assert.rejects(pending,error=>error instanceof QueryCancelledError&&error.reason===(deadline?"deadline":"caller")&&!error.message.includes(secret));
    await bounded(dispatched.promise);if(!deadline)abort.abort(new Error(secret));
    await bounded(rejected);await bounded(disconnected.promise);controllers.delete(abort);
    assert.equal(active.size,0);assert.equal((await bounded(db.get(requested))).data.value,"Milk");
  }
  const credentialsEntered=deferred(),pendingCredentials=deferred();
  const blockedSDK=new DynamoDBClient({region:"us-east-1",endpoint:"https://owned-dynamodb.invalid",maxAttempts:1,requestHandler:handler,credentials:()=>{credentialsEntered.resolve();return pendingCredentials.promise;}});
  const blockedClient=DynamoDBDocumentClient.from(blockedSDK);
  const blocked=new DynamoDbDatabase(blockedClient,options),abort=new AbortController();controllers.add(abort);
  const count=requests,pending=blocked.getWithSignal(requested,abort.signal);work.push(pending);
  const rejected=assert.rejects(pending,error=>error instanceof QueryCancelledError&&error.reason==="caller");
  try{await bounded(credentialsEntered.promise);abort.abort(new Error(secret));await bounded(rejected);assert.equal(requests,count);}
  finally{pendingCredentials.reject(new Error(secret));controllers.delete(abort);}
  const boundedResult=new DynamoDbDatabase(client,{...options,maxReadBytes:32});
  await assert.rejects(boundedResult.get(requested),error=>error instanceof DynamoDbReadError&&error.code==="limit");
  const boundedRecords=new DynamoDbDatabase(client,{...options,maxReadRecords:2});
  const countBefore=requests;
  await assert.rejects(boundedRecords.getMany([requested,requested,requested]),error=>error instanceof DynamoDbReadError&&error.code==="limit");
  assert.equal(requests,countBefore);
  result=await bounded(db.get(requested)); assert.equal(result.data.value,"Milk");
  assert.equal(destroys,0);
}finally{
  dispatch=undefined;acknowledge=undefined;
  for(const abort of controllers)abort.abort();controllers.clear();
  for(const entry of [...active])entry.stop();
  await bounded(Promise.allSettled(work));assert.equal(active.size,0);assert.equal(destroys,0);
}
console.log(JSON.stringify({coreAndErrorIdentity:true,actualSdkHandlerProtocol:true,typedValues:true,paging:true,batchOrderDuplicates:true,callerAfterDispatch:true,deadlineAfterDispatch:true,credentialWaiting:true,parsedBudgets:true,clientNeverDestroyed:true,reopen:true,cleanup:true,actualDynamoDBOrHostedIAM:false}));
