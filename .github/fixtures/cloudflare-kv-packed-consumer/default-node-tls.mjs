// ROOT-ONLY OFFLINE default-name KV TLS proof. No actual Cloudflare claim.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

let phase = "preflight", interrupted = false, missingGate;
const active = new Set();
function interrupt() {
  interrupted = true;
  for (const child of active) child.stop("interrupted");
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function startChild(binary, args, env, timeout, stdin = "") {
  const child = spawn(binary, args, { env, cwd: "/proof", stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [], stderr = [];
  let reason, timer, killTimer, finalTimer, finished = false, bytes = 0, finish;
  const result = new Promise(resolve => {
    finish = (code, signal, closed) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(finalTimer);
      active.delete(handle);
      resolve({ code, signal, closed, reason, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
  });
  const handle = {
    child, result,
    stop(why) {
      if (finished || reason) return;
      reason = why;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      finalTimer = setTimeout(() => finish(1, null, false), 5000);
    },
    closed() { return finished; },
  };
  active.add(handle);
  child.once("error", () => handle.stop("spawn-error"));
  child.once("close", (code, signal) => finish(code, signal, true));
  child.stdin.on("error", () => handle.stop("stdin-error"));
  for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
    stream.on("error", () => handle.stop("output-error"));
    stream.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 1_048_576) { handle.stop("output-budget"); return; }
      chunks.push(chunk);
    });
  }
  timer = setTimeout(() => handle.stop("child-deadline"), timeout);
  child.stdin.end(stdin);
  if (interrupted) handle.stop("interrupted");
  return handle;
}
function normal(result) {
  assert.ok(result.closed && result.signal === null && !result.reason && !interrupted, "child must finish without forced stop or default signal termination");
  assert.ok(Number.isInteger(result.code));
}
async function privateJSON(path, maximum = 8192) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600 && info.size <= maximum);
  return JSON.parse(await readFile(path, "utf8"));
}

async function main(){
 assert.equal(process.argv.length,2);assert.match(process.version,/^v24\./u);
 const binary=process.env.KV_DEFAULT_TLS_FIXTURE_BIN,proofPath=process.env.KV_DEFAULT_TLS_PROOF_FILE;
 assert.ok(binary?.startsWith("/"));assert.ok(proofPath?.startsWith("/"));
 phase="owned-namespace-prerequisites";
 const threshold=Number((await readFile("/proc/sys/net/ipv4/ip_unprivileged_port_start","utf8")).trim());
 if(!Number.isSafeInteger(threshold)||threshold>443){missingGate="unprivileged_port_start_for_uid1000_443";throw new Error("missing owned prerequisite");}if(process.getuid()!==1000){missingGate="expected_uid1000";throw new Error("missing owned prerequisite");}
 const hosts=await readFile("/etc/hosts","utf8");if(!hosts.split("\n").some(line=>{const fields=line.trim().split(/\s+/u);return fields[0]==="127.0.0.1"&&fields.includes("api.cloudflare.com");})){missingGate="owned_Docker_add_host_api_cloudflare_com";throw new Error("missing owned prerequisite");}
 const info=await lstat(binary);assert.ok(info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o111)!==0);const binaryHash=await hashFile(binary);
 const directory=await mkdtemp("/proof/cloudflare-kv-default-tls-");const token=randomBytes(32).toString("base64url");
 const env={PATH:process.env.PATH??"/usr/local/bin:/usr/bin:/bin",HOME:directory,TMPDIR:directory,LANG:"C.UTF-8",KV_DEFAULT_FIXTURE_TOKEN:token,HTTPS_PROXY:"http://127.0.0.1:1",HTTP_PROXY:"http://127.0.0.1:1",ALL_PROXY:"http://127.0.0.1:1",NO_PROXY:"",NODE_USE_ENV_PROXY:"1"};
 let server,initial,proof;
 try{
  phase="owned443-tls-start";server=startChild(binary,[directory],env,120000);
  let ready;for(let i=0;i<100;i++){if(server.closed()){const failure=await server.result;if(failure.stderr.includes("MISSING_GATE:port443_permission"))missingGate="port443_permission";if(failure.stderr.includes("MISSING_GATE:port443_in_use"))missingGate="port443_in_use";throw new Error("owned fixture unavailable");}assert.ok(!interrupted);try{ready=await privateJSON(join(directory,"ready.json"));break;}catch(error){if(error?.code!=="ENOENT")throw error;}await delay(25);}
  assert.ok(ready);assert.equal(ready.pid,server.child.pid);assert.equal(ready.endpoint,"https://api.cloudflare.com/client/v4");assert.equal(ready.ca,join(directory,"ca.pem"));const caInfo=await lstat(ready.ca);assert.ok(caInfo.isFile()&&!caInfo.isSymbolicLink()&&(caInfo.mode&0o777)===0o600);const caHash=await hashFile(ready.ca);
  initial=await privateJSON(join(directory,"stats.json"));assert.equal(initial.requests,0);assert.equal(initial.dataCount,3);
  const client=new URL("./default-node-client.mjs",import.meta.url).pathname;
  phase="untrusted-default-tls-negative";const negative=await startChild(process.execPath,[client,"untrusted",directory],env,20000).result;normal(negative);assert.equal(negative.code,0);assert.ok(!negative.stdout.includes(token)&&!negative.stderr.includes(token));assert.deepEqual(JSON.parse(negative.stdout),{passed:true,mode:"untrusted",tlsNegative:true,requests:0,defaultAuthority:true});
  phase="trusted-default-api-transport-native-cancel-disconnect";const positive=await startChild(process.execPath,[client,"trusted",directory],{...env,NODE_EXTRA_CA_CERTS:ready.ca},45000).result;normal(positive);assert.equal(positive.code,0);assert.ok(!positive.stdout.includes(token)&&!positive.stderr.includes(token)&&!positive.stderr.includes("PRIVATE_PROVIDER_DETAIL"));const outcome=JSON.parse(positive.stdout);assert.equal(outcome.passed,true);assert.equal(outcome.defaultOwnedNodeTransport,true);assert.equal(outcome.defaultAuthority,true);assert.equal(outcome.disconnects,2);assert.equal(outcome.liveConnections,0);
  const final=await privateJSON(join(directory,"stats.json"));assert.equal(final.protocolFailures,0);assert.equal(final.liveConnections,0);assert.equal(final.slowDisconnected,2);assert.equal(final.dataCount,initial.dataCount);assert.equal(final.dataSha256,initial.dataSha256);assert.equal(await hashFile(binary),binaryHash);assert.equal(await hashFile(ready.ca),caHash);
  proof={...outcome,tlsNegative:true,fixtureBinarySHA256:binaryHash,ownedDefaultDNSOnly:true,rootContainerNetworkNoneGateRequired:true,noHostHostsChanges:true,noNewCapabilitiesOrSysctls:true,nodeExtraCAOnlyOwnedChild:true,apiCredentialsNeverInBrowser:true,actualCloudflare:false,actualWorkersEngine:false};
 }finally{
  phase="owned-process-and-file-cleanup";
  try{
   for(const child of [...active].filter(item=>item!==server)){child.stop("owned-cleanup");assert.ok((await child.result).closed);}
   if(server){server.stop("owned-shutdown");const result=await server.result;assert.ok(result.closed&&result.code===0&&result.signal===null&&result.reason==="owned-shutdown");assert.equal(result.stdout,"");assert.equal(result.stderr,"");const closed=await privateJSON(join(directory,"closed.json"));assert.equal(closed.closed,true);assert.equal(closed.liveConnections,0);if(initial){assert.equal(closed.dataCount,initial.dataCount);assert.equal(closed.dataSha256,initial.dataSha256);}}
   if(proof)proof.ownedProcessesClosed=true;
  }finally{await rm(directory,{recursive:true,force:true});await assert.rejects(lstat(directory),{code:"ENOENT"});if(proof)proof.ownedFilesRemoved=true;}
 }
 assert.ok(proof&&!interrupted);await writeFile(proofPath,JSON.stringify(proof,null,2)+"\n",{mode:0o600});console.log(JSON.stringify(proof));
}
main().catch(()=>{console.error("Owned default Cloudflare KV TLS fixture failed at safe phase: "+phase+(missingGate?"; MISSING_GATE:"+missingGate:""));process.exitCode=1;}).finally(()=>{process.removeListener("SIGINT",interrupt);process.removeListener("SIGTERM",interrupt);});
