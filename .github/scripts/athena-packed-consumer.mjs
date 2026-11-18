// Private Athena source artifact qualification only. Keep the producer's name,
// private flag and version; install actual released core/runtime into scratch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const NAME = "@dalgo/dalgo2athena";
const RUNTIME_VERSION = "0.1.2";
const RUNTIME_SPEC = `@dalgo/adapter-runtime@${RUNTIME_VERSION}`;
const RUNTIME_TARBALL = "https://registry.npmjs.org/@dalgo/adapter-runtime/-/adapter-runtime-0.1.2.tgz";
const RUNTIME_INTEGRITY = "sha512-dNX7DKuCrI4n7IXKfhWAglHNXwqHG0/f4oRveKw+CnG1jLS2KSyhAV+N6UeDmZoiNrAvOigUYVBzKaChYh+OSQ==";
const SIGNER_VERSION = "5.7.3";
const SIGNER_TARBALL = `https://registry.npmjs.org/@smithy/signature-v4/-/signature-v4-${SIGNER_VERSION}.tgz`;
const SIGNER_INTEGRITY = "sha512-7ImGm+FkHRLcBaRttIAMZ6bzJZWb2cJGoYjq46F2UjycujWzrL9GEN9h4w7eQyXJYnltrUhxbbieBAIRrdqpow==";
const legacyCore = /@dal-go\/dalgo(?![\w-])/u;
const EXPECTED_RUNTIME = {
  publicCoreIdentity: { core: true, typedNativeValues: true },
  signedOwnedHttpFixture: true,
  sameQueryPages: { header: true, empty: true, duplicate: true, pendingFactoryRetry: true, localAck: true },
  compilerMetadata: { exact: true, native: true, unsafeNumericStatistics: true },
  codecFinalAbort: true,
  trustedHttpBridge: { preAckResponseAbortRetry: true },
  dispatchedCallerDeadline: { caller: true, deadline: true, capturedStop: true, originalTypedErrors: true },
  lateCredentialsBody: { credentialsCancelPhysicalLease: true, bodyCancelPhysicalLease: true, realQuotaRejection: true },
  cleanup: { socket: true, handler: true, process: true, data: true },
};

export async function checkAthenaPackedConsumer({ repository, scratch, run, walk, sourceHashes, assertNoLegacyDependency, assertNoLegacyTree, core, typescript, nodeTypes, esbuild }) {
  const inputHashes = sourceHashes();
  const realSource = { gitSHA: run("git", ["rev-parse", "HEAD"]).trim(), dirty: run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim() !== "", inputSHA256: createHash("sha256").update(JSON.stringify(inputHashes)).digest("hex") };
  const producer = join(repository, "packages", "athena");
  const fixture = join(repository, ".github", "fixtures", "athena-packed-consumer");
  const consumer = join(scratch, "consumer");
  const tarballs = join(scratch, "tarballs");
  let passed = false;
  try {
    const original = JSON.parse(readFileSync(join(producer, "package.json"), "utf8"));
    assert.equal(original.name, NAME); assert.equal(original.private, true); assert.equal(original.version, "0.1.0");
    assert.equal(typeof original.scripts?.prepack, "string", "qualify the normal producer prepack");
    assertNoLegacyDependency(original, "private Athena producer");
    assert.equal(original.peerDependencies["@dalgo/core"], ">=0.8.1 <0.9.0");
    assert.equal(original.peerDependencies["@dalgo/adapter-runtime"], ">=0.1.2 <1.0.0");
    assert.equal(original.dependencies["@smithy/signature-v4"], SIGNER_VERSION);
    mkdirSync(join(consumer, "src"), { recursive: true }); mkdirSync(join(consumer, "browser-src")); mkdirSync(tarballs);
    // Producer declarations may build locally, but its runtime is NEVER packed
    // or substituted for the public0.1.2 installed by the clean consumer.
    run("pnpm", ["--filter", "@dalgo/adapter-runtime", "run", "build"], { timeout: 120_000 });
    run("npm", ["pack", "--ignore-scripts=false", "--pack-destination", tarballs], { cwd: producer, timeout: 120_000 });
    const packedFiles = readdirSync(tarballs);
    assert.equal(packedFiles.length, 1, "pack only the private Athena source artifact");
    assert.ok(packedFiles[0].endsWith(".tgz"));
    const archive = join(tarballs, packedFiles[0]);
    const originalTarballHash = createHash("sha256").update(readFileSync(archive)).digest("hex");
    const archiveIntegrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "private-athena-source-consumer", private: true, type: "module", devDependencies: { esbuild } }, null, 2) + "\n");
    for (const [from, to] of [["consumer.ts", "src/consumer.ts"], ["browser.ts", "browser-src/consumer.ts"], ["runtime.mjs", "runtime.mjs"], ["browser-entry.mjs", "browser-entry.mjs"], ["browser-roots.mjs", "browser-roots.mjs"]]) copyFileSync(join(fixture, from), join(consumer, to));
    copyFileSync(join(repository, ".github", "fixtures", "native-packed-consumer", "browser-guard-loader.mjs"), join(consumer, "browser-guard-loader.mjs"));
    const compilerOptions = { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "ESNext.Disposable"], types: ["node"], strict: true, skipLibCheck: false, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true };
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["src/**/*.ts"] }, null, 2) + "\n");
    writeFileSync(join(consumer, "tsconfig.browser.json"), JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { module: "ESNext", moduleResolution: "Bundler", lib: ["ES2022", "DOM"], types: [] }, include: ["browser-src/**/*.ts"] }, null, 2) + "\n");
    run("npm", ["install", "--strict-peer-deps", "--engine-strict", "--no-audit", "--no-fund", "--save-exact", "--include=dev", "--registry=https://registry.npmjs.org", archive, core.spec, RUNTIME_SPEC, typescript, nodeTypes], { cwd: consumer, timeout: 180_000 });
    const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
    const keys = Object.keys(lock.packages);
    for (const name of ["@dalgo/core", "@dalgo/adapter-runtime", "@smithy/signature-v4"]) assert.equal(keys.filter(key => key.endsWith(`node_modules/${name}`)).length, 1, `one installed identity for ${name}`);
    // Reject precisely the archived CORE, not the retained private adapter name.
    assert.ok(keys.every(key => !key.endsWith("node_modules/@dal-go/dalgo")));
    assert.ok(!existsSync(join(consumer, "node_modules", "@dal-go", "dalgo")));
    const coreLock = lock.packages["node_modules/@dalgo/core"];
    assert.equal(coreLock?.version, core.version); assert.equal(coreLock.resolved, core.tarball); assert.equal(coreLock.integrity, core.integrity);
    const runtimeLock = lock.packages["node_modules/@dalgo/adapter-runtime"];
    assert.equal(runtimeLock?.version, RUNTIME_VERSION); assert.equal(runtimeLock.resolved, RUNTIME_TARBALL); assert.equal(runtimeLock.integrity, RUNTIME_INTEGRITY);
    const signerLock = lock.packages["node_modules/@smithy/signature-v4"];
    assert.equal(signerLock?.version, SIGNER_VERSION); assert.equal(signerLock.resolved, SIGNER_TARBALL); assert.equal(signerLock.integrity, SIGNER_INTEGRITY);
    for (const [name, version] of [["@dalgo/core", core.version], ["@dalgo/adapter-runtime", RUNTIME_VERSION], ["@smithy/signature-v4", SIGNER_VERSION]]) {
      const manifest = JSON.parse(readFileSync(join(consumer, "node_modules", name, "package.json"), "utf8"));
      assert.equal(manifest.name, name); assert.equal(manifest.version, version); assertNoLegacyDependency(manifest, name);
    }
    const root = join(consumer, "node_modules", "@dalgo", "dalgo2athena");
    assert.ok(!lstatSync(root).isSymbolicLink(), "consume the unpacked tarball, never a workspace link");
    const installed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(installed.name, NAME); assert.equal(installed.version, original.version); assert.equal(installed.private, true);
    assert.deepEqual(installed.engines, original.engines);
    assert.deepEqual(installed.peerDependencies, original.peerDependencies); assertNoLegacyDependency(installed, "private Athena tarball");
    assert.equal(installed.dependencies["@smithy/signature-v4"], SIGNER_VERSION);
    assert.deepEqual(installed.exports["."], { types: "./dist/index.d.ts", import: "./dist/index.js" });
    assert.deepEqual(installed.exports["./node"], { types: "./dist/node.d.ts", import: "./dist/node.js" });
    assert.deepEqual(installed.exports["./http"], { types: "./dist/http.d.ts", import: "./dist/http.js" });
    assert.deepEqual(installed.exports["./browser"], { types: "./dist/browser.d.ts", import: "./dist/browser.js" });
    for (const file of walk(root)) if (/\.(?:js|mjs|d\.ts|json|map)$/u.test(file)) assert.ok(!legacyCore.test(readFileSync(file, "utf8")), "no archived core import in private artifact");
    const failures = [];
    for (const profile of ["tsconfig.json", "tsconfig.browser.json"]) {
      try { run(join(consumer, "node_modules", ".bin", "tsc"), ["-p", profile], { cwd: consumer, timeout: 120_000 }); }
      catch (error) { process.stderr.write(`Athena packed declaration profile failed: ${profile}\n`); failures.push(error); }
    }
    if (failures.length > 0) throw failures[0];
    const runtime = JSON.parse(run(process.execPath, ["runtime.mjs"], { cwd: consumer, timeout: 45_000 }).trim());
    assert.deepEqual(runtime, EXPECTED_RUNTIME, "Athena runtime proof summary must cover every required group");
    const require = createRequire(join(consumer, "package.json")); assert.equal(require("esbuild/package.json").version, esbuild); const { build } = require("esbuild");
    const result = await build({ absWorkingDir: consumer, entryPoints: ["browser-entry.mjs"], outfile: "browser-bundle.mjs", platform: "browser", conditions: ["browser"], bundle: true, format: "esm", target: "es2022", metafile: true });
    const inputs = Object.keys(result.metafile.inputs).sort();
    for (const [name, input] of Object.entries(result.metafile.inputs)) {
      const path = relative(consumer, resolve(consumer, name)); assert.ok(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path), "all browser inputs belong to the clean consumer");
      assert.ok(!/node_modules\/(?:@smithy\/[^/]+|@aws-sdk\/[^/]+|@aws-crypto\/[^/]+|mongodb|redis|ioredis|bson|@duckdb\/[^/]+|node-stdlib-browser|buffer|process|stream-browserify|crypto-browserify|path-browserify)(?:\/|$)|\.node$/u.test(name), "no signer, AWS/Smithy, driver, native addon or browser polyfill");
      for (const imported of input.imports) assert.ok(!imported.external && !isBuiltin(imported.path) && !imported.path.startsWith("node:"), "no builtin or external exception");
    }
    for (const output of Object.values(result.metafile.outputs)) for (const imported of output.imports) assert.ok(!imported.external && !isBuiltin(imported.path) && !imported.path.startsWith("node:"));
    assert.ok(inputs.some(name => name.endsWith("/@dalgo/dalgo2athena/dist/browser.js")), "actual packed browser adapter is in the browser graph");
    assert.ok(inputs.every(name => !/@dalgo\/dalgo2athena\/dist\/node\.js$/u.test(name)), "Node signer entry is absent from the browser graph");
    const yamlInputs = inputs.filter(name => /(?:^|\/)node_modules\/yaml\//u.test(name)); assert.ok(yamlInputs.every(name => /(?:^|\/)node_modules\/yaml\/browser\//u.test(name)));
    const browser = JSON.parse(run(process.execPath, ["--experimental-vm-modules", "--import", "./browser-guard-loader.mjs", "browser-roots.mjs"], { cwd: consumer, timeout: 30_000 }).trim());
    assert.deepEqual(browser, { packageGraphGuard: true, guardNegativeControls: true, coreAndErrorIdentity: true, lazy: true, fetches: 0, workers: 0 });
    const tree = JSON.parse(run("npm", ["ls", "--all", "--json", NAME, "@dalgo/core", "@dalgo/adapter-runtime", "@smithy/signature-v4"], { cwd: consumer, timeout: 30_000 })); assertNoLegacyTree(tree, "private Athena consumer");
    assert.deepEqual(sourceHashes(), inputHashes, "private Athena pack changed source");
    assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), originalTarballHash, "tested private tarball changed");
    const receipt = { mode: "athena", artifactKind: "local private source tarball; not publication or release preview", producer: { name: NAME, private: true, version: original.version, prepack: original.scripts.prepack }, realSource, sourceInputHashes: inputHashes, sourceUnchanged: true, archive: { filename: packedFiles[0], sha256: originalTarballHash, integrity: archiveIntegrity, lifecycleScripts: true }, core: coreLock, publicRuntime: runtimeLock, signer: signerLock, profiles: { node: compilerOptions, browser: { moduleResolution: "Bundler", types: [], lib: ["ES2022", "DOM"] } }, runtime, executedNode: process.version, advertisedNodeEngine: installed.engines.node, servedRuntimeScope: "owned loopback HTTP through fixed-origin path/query trusted fetch; scoped same-query pages; not AWS/IAM/default AWS DNS-TLS or browser SQL", browserScope: "imports/laziness/preabort/public identity only; no browser query/CORS", browser, browserInputs: inputs, yamlInputs, browserMetafile: result.metafile, browserBundleSHA256: createHash("sha256").update(readFileSync(join(consumer, "browser-bundle.mjs"))).digest("hex"), legacyReferences: 0, actualAwsIamOrCloud: false };
    if (process.env.DALGO_PACKED_CONSUMER_RECEIPT !== undefined) { mkdirSync(dirname(process.env.DALGO_PACKED_CONSUMER_RECEIPT), { recursive: true }); writeFileSync(process.env.DALGO_PACKED_CONSUMER_RECEIPT, JSON.stringify(receipt, null, 2) + "\n"); }
    passed = true; console.log(JSON.stringify(receipt, null, 2));
  } finally {
    try { assert.deepEqual(sourceHashes(), inputHashes, "private Athena mode changed source inputs"); }
    finally { if (process.env.KEEP_PACKED_CONSUMER !== "1") rmSync(scratch, { recursive: true, force: true }); else process.stderr.write(`Athena fixture ${passed ? "passed" : "failed"}; scratch retained at ${scratch}\n`); }
  }
}
