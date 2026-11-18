// Canonical 0.1.0 local SOURCE pack; public core/runtime/Worker types, no release.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
const NAME="@dalgo/cloudflare-kv";
const RUNTIME_VERSION="0.1.2",RUNTIME_SPEC="@dalgo/adapter-runtime@0.1.2";
const RUNTIME_TARBALL="https://registry.npmjs.org/@dalgo/adapter-runtime/-/adapter-runtime-0.1.2.tgz";
const RUNTIME_INTEGRITY="sha512-dNX7DKuCrI4n7IXKfhWAglHNXwqHG0/f4oRveKw+CnG1jLS2KSyhAV+N6UeDmZoiNrAvOigUYVBzKaChYh+OSQ==";
// Root fetched ONLY this official registry metadata in the governed worker;
// normal install and exact archive SRI remain actual consumer checks below.
const WORKERS_VERSION="5.20261102.1";
const WORKERS_TARBALL="https://registry.npmjs.org/@cloudflare/workers-types/-/workers-types-5.20261102.1.tgz";
const WORKERS_INTEGRITY="sha512-rRNznLGla+8vRdToTN/5M+AzlopILSLLZ3qo2L5Ku/dY792iOlX/K9ZLkLnLYji1jycv7+FB12hiE+fFjVgMrw==";
const legacy=/@dal-go\/dalgo(?![\w-])/u;
export async function checkCloudflareKvPackedConsumer({repository,scratch,run,walk,sourceHashes,assertNoLegacyDependency,assertNoLegacyTree,core,typescript,nodeTypes,esbuild}) {
 const inputs=sourceHashes(),producer=join(repository,"packages","cloudflare-kv"),fixture=join(repository,".github","fixtures","cloudflare-kv-packed-consumer"),consumer=join(scratch,"consumer"),tarballs=join(scratch,"tarballs");
 const realSource={gitSHA:run("git",["rev-parse","HEAD"]).trim(),dirty:run("git",["status","--porcelain","--untracked-files=normal"]).trim()!=="",inputSHA256:createHash("sha256").update(JSON.stringify(inputs)).digest("hex")};let passed=false;
 try {
  const original=JSON.parse(readFileSync(join(producer,"package.json"),"utf8"));assert.equal(original.name,NAME);assert.equal(original.version,"0.1.0");assert.notEqual(original.private,true);assert.equal(original.engines.node,">=24");assert.equal(typeof original.scripts.prepack,"string");assertNoLegacyDependency(original,"KV sourceproducer");
  assert.equal(original.peerDependencies["@dalgo/core"],">=0.8.1 <0.9.0");assert.equal(original.peerDependencies["@dalgo/adapter-runtime"],">=0.1.2 <1.0.0");
  for(const dir of ["src","browser-src","worker-src"])mkdirSync(join(consumer,dir),{recursive:true});mkdirSync(tarballs);
  run("pnpm",["--filter","@dalgo/adapter-runtime","run","build"],{timeout:120000});run("npm",["pack","--ignore-scripts=false","--pack-destination",tarballs],{cwd:producer,timeout:120000});
  const packs=readdirSync(tarballs);assert.equal(packs.length,1);assert.ok(packs[0].endsWith(".tgz"));const archive=join(tarballs,packs[0]),archiveSHA=createHash("sha256").update(readFileSync(archive)).digest("hex"),archiveIntegrity="sha512-"+createHash("sha512").update(readFileSync(archive)).digest("base64");
  writeFileSync(join(consumer,"package.json"),JSON.stringify({name:"cloudflare-kv-source-packed-consumer",private:true,type:"module",devDependencies:{esbuild}},null,2)+"\n");
  for(const [from,to] of [["consumer.ts","src/consumer.ts"],["browser.ts","browser-src/consumer.ts"],["worker.ts","worker-src/consumer.ts"],["runtime.mjs","runtime.mjs"],["browser-entry.mjs","browser-entry.mjs"],["browser-roots.mjs","browser-roots.mjs"],["default-node-client.mjs","default-node-client.mjs"],["default-node-tls.mjs","default-node-tls.mjs"],["default-node-tls-fixture.go","default-node-tls-fixture.go"]])copyFileSync(join(fixture,from),join(consumer,to));
  copyFileSync(join(repository,".github","fixtures","native-packed-consumer","browser-guard-loader.mjs"),join(consumer,"browser-guard-loader.mjs"));
  const node={target:"ES2022",module:"NodeNext",moduleResolution:"NodeNext",lib:["ES2022","ESNext.Disposable"],types:["node"],strict:true,skipLibCheck:false,noUncheckedIndexedAccess:true,exactOptionalPropertyTypes:true,noEmit:true};
  const dom={...node,module:"ESNext",moduleResolution:"Bundler",lib:["ES2022","DOM"],types:[]};
  const worker={...node,module:"ESNext",moduleResolution:"Bundler",types:["@cloudflare/workers-types"]};
  for(const [file,options,path] of [["tsconfig.json",node,"src"],["tsconfig.browser.json",dom,"browser-src"],["tsconfig.worker.json",worker,"worker-src"]])writeFileSync(join(consumer,file),JSON.stringify({compilerOptions:options,include:[path+"/**/*.ts"]},null,2)+"\n");
  run("npm",["install","--engine-strict","--strict-peer-deps","--no-audit","--no-fund","--save-exact","--include=dev","--registry=https://registry.npmjs.org",archive,core.spec,RUNTIME_SPEC,"@cloudflare/workers-types@"+WORKERS_VERSION,typescript,nodeTypes],{cwd:consumer,timeout:180000});
  const lock=JSON.parse(readFileSync(join(consumer,"package-lock.json"),"utf8")),keys=Object.keys(lock.packages);
  for(const name of [NAME,"@dalgo/core","@dalgo/adapter-runtime","@cloudflare/workers-types"])assert.equal(keys.filter(key=>key.endsWith("node_modules/"+name)).length,1,"one installed identity for "+name);
  assert.ok(keys.every(key=>!key.endsWith("node_modules/@dal-go/dalgo")));assert.ok(!existsSync(join(consumer,"node_modules","@dal-go","dalgo")));
  const coreLock=lock.packages["node_modules/@dalgo/core"],runtimeLock=lock.packages["node_modules/@dalgo/adapter-runtime"],workerLock=lock.packages["node_modules/@cloudflare/workers-types"];
  for(const [entry,version,url,integrity] of [[coreLock,core.version,core.tarball,core.integrity],[runtimeLock,RUNTIME_VERSION,RUNTIME_TARBALL,RUNTIME_INTEGRITY],[workerLock,WORKERS_VERSION,WORKERS_TARBALL,WORKERS_INTEGRITY]]){assert.equal(entry?.version,version);assert.equal(entry.resolved,url);assert.equal(entry.integrity,integrity);}
  for(const [name,version] of [["@dalgo/core",core.version],["@dalgo/adapter-runtime",RUNTIME_VERSION],["@cloudflare/workers-types",WORKERS_VERSION]]){const manifest=JSON.parse(readFileSync(join(consumer,"node_modules",name,"package.json"),"utf8"));assert.equal(manifest.name,name);assert.equal(manifest.version,version);assertNoLegacyDependency(manifest,name);}
  const root=join(consumer,"node_modules","@dalgo","cloudflare-kv"),installed=JSON.parse(readFileSync(join(root,"package.json"),"utf8"));assert.ok(!lstatSync(root).isSymbolicLink());assert.equal(installed.name,NAME);assert.equal(installed.version,original.version);assert.equal(installed.private,original.private);assert.deepEqual(installed.peerDependencies,original.peerDependencies);assert.deepEqual(installed.engines,original.engines);assert.deepEqual(installed.exports,original.exports);assertNoLegacyDependency(installed,"KV artifact");
  for(const [entry,name] of [[".","index"],["./binding","index"],["./browser","browser"],["./node","node"]])assert.deepEqual(installed.exports[entry],{types:`./dist/${name}.d.ts`,import:`./dist/${name}.js`});
  for(const file of walk(root))if(/\.(?:js|mjs|d\.ts|json|map)$/u.test(file))assert.ok(!legacy.test(readFileSync(file,"utf8")),"no archived core in source artifact");
  const failures=[];for(const profile of ["tsconfig.json","tsconfig.browser.json","tsconfig.worker.json"]){try{run(join(consumer,"node_modules",".bin","tsc"),["-p",profile],{cwd:consumer,timeout:120000});}catch(error){process.stderr.write("KV strict declaration profile failed: "+profile+"\n");failures.push(error);}}
  if(failures.length)throw failures[0];
  // Official Workers types deliberately declare Buffer/process compatibility
  // globals. Prove the Worker program uses no @types/node or Node polyfill
  // declaration files, independently of the adapter-only DOM negative controls.
  const workerProgramFiles=run(join(consumer,"node_modules",".bin","tsc"),["-p","tsconfig.worker.json","--listFilesOnly"],{cwd:consumer,timeout:120000}).trim().split(/\r?\n/u).map(file=>file.replaceAll("\\","/"));
  assert.ok(workerProgramFiles.length>0);
  assert.ok(workerProgramFiles.some(file=>file.endsWith("/@cloudflare/workers-types/index.d.ts")),"official Worker declarations participate in the strict program");
  assert.ok(workerProgramFiles.some(file=>file.endsWith("/@dalgo/cloudflare-kv/dist/index.d.ts")),"real packed adapter declarations participate in the Worker program");
  for(const file of workerProgramFiles)assert.ok(!/(?:^|\/)@types\/node(?:\/|$)|(?:^|\/)node_modules\/(?:node-stdlib-browser|buffer|process|stream-browserify|crypto-browserify|path-browserify)(?:\/|$)/u.test(file),"Worker program must not load Node ambient types or polyfills");
  const workerAmbientScope={officialCompatibilityGlobals:["Buffer","process"],documentAndWindowAbsent:true,nodeTypesOrPolyfillsLoaded:false,programFiles:workerProgramFiles};
  const runtime=JSON.parse(run(process.execPath,["runtime.mjs"],{cwd:consumer,timeout:30000}).trim());assert.equal(runtime.cleanup,true);assert.equal(runtime.coreAndPublicErrorIdentity,true);assert.equal(runtime.mandatoryFixedAuthorityServedHTTP,true);assert.equal(runtime.actualCloudflare,false);assert.equal(runtime.actualWorkersEngine,false);
  const require=createRequire(join(consumer,"package.json"));assert.equal(require("esbuild/package.json").version,esbuild);const {build}=require("esbuild");
  const result=await build({absWorkingDir:consumer,entryPoints:["browser-entry.mjs"],outfile:"browser-bundle.mjs",platform:"browser",conditions:["browser"],bundle:true,format:"esm",target:"es2022",metafile:true});const browserInputs=Object.keys(result.metafile.inputs).sort();
  for(const [name,input] of Object.entries(result.metafile.inputs)){
   const path=relative(consumer,resolve(consumer,name));assert.ok(path!==".."&&!path.startsWith(".."+sep)&&!isAbsolute(path));
   assert.ok(!/(?:^|\/)(?:rest|node-fetch)\.[jt]s$/u.test(name));assert.ok(!/node_modules\/(?:@cloudflare|undici|mongodb|bson|redis|ioredis|@aws-sdk|@duckdb|node-stdlib-browser|buffer|process|stream-browserify|crypto-browserify|path-browserify)(?:\/|$)|\.node$/u.test(name),"no provider/Node addon/polyfill in browser graph");
   for(const imported of input.imports)assert.ok(!imported.external&&!isBuiltin(imported.path)&&!imported.path.startsWith("node:"));
  }
  for(const output of Object.values(result.metafile.outputs))for(const imported of output.imports)assert.ok(!imported.external&&!isBuiltin(imported.path)&&!imported.path.startsWith("node:"));
  const yamlInputs=browserInputs.filter(name=>/(?:^|\/)node_modules\/yaml\//u.test(name));assert.ok(yamlInputs.every(name=>/(?:^|\/)node_modules\/yaml\/browser\//u.test(name)));
  const browser=JSON.parse(run(process.execPath,["--experimental-vm-modules","--import","./browser-guard-loader.mjs","browser-roots.mjs"],{cwd:consumer,timeout:30000}).trim());assert.deepEqual(browser,{packageGraphGuard:true,guardNegativeControls:true,coreAndPublicErrorIdentity:true,lazy:true,fetches:0,workers:0,actualBrowserQuery:false});
  const tree=JSON.parse(run("npm",["ls","--all","--json",NAME,"@dalgo/core","@dalgo/adapter-runtime","@cloudflare/workers-types"],{cwd:consumer,timeout:30000}));assertNoLegacyTree(tree,"KV consumer");assert.deepEqual(sourceHashes(),inputs,"source pack changed inputs");assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"),archiveSHA);
  const receipt={mode:"cloudflare-kv",artifactKind:"canonical0.1.0 local SOURCE tarball; not registry release/version preview",producer:{name:NAME,version:original.version,prepack:original.scripts.prepack},realSource,sourceInputHashes:inputs,sourceUnchanged:true,archive:{filename:packs[0],sha256:archiveSHA,integrity:archiveIntegrity,lifecycleScripts:true},core:coreLock,publicRuntime:runtimeLock,officialWorkersTypes:workerLock,profiles:{node,dom,officialWorker:worker},workerAmbientScope,runtime,browser,browserInputs,yamlInputs,browserMetafile:result.metafile,browserBundleSHA256:createHash("sha256").update(readFileSync(join(consumer,"browser-bundle.mjs"))).digest("hex"),consumerDirectory:consumer,defaultOwnedNodeTLS:"NOT_RUN_BY_GENERIC_CI; separate root-owned namespace443/CA fixture",legacyReferences:0,actualCloudflare:false,actualWorkerEngine:false};
  if(process.env.DALGO_PACKED_CONSUMER_RECEIPT!==undefined){mkdirSync(dirname(process.env.DALGO_PACKED_CONSUMER_RECEIPT),{recursive:true});writeFileSync(process.env.DALGO_PACKED_CONSUMER_RECEIPT,JSON.stringify(receipt,null,2)+"\n");}passed=true;console.log(JSON.stringify(receipt,null,2));
 }finally{try{assert.deepEqual(sourceHashes(),inputs,"KV mode changed source inputs");}finally{if(process.env.KEEP_PACKED_CONSUMER!=="1")rmSync(scratch,{recursive:true,force:true});else process.stderr.write(`KV fixture ${passed?"passed":"failed"}; scratch retained at ${scratch}\n`);}}
}
