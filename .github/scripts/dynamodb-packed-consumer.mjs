// Private DynamoDB source artifact qualification only. Keep the producer's name,
// private flag and version; install actual released core/runtime into scratch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const NAME = "@dal-go/dalgo2dynamodb";
const SDK_VERSION = "3.1136.0";
const SDK = {
  "@aws-sdk/client-dynamodb": { version: SDK_VERSION, integrity: "sha512-EEgixP37uQV7UqFxl1JaWGYA7QQeeP0yKSN5uCkAbNw9gBifGGk2cqm8qt1Mz+kzw0OwpL8W445R1UT+RTRBhA==", tarball: `https://registry.npmjs.org/@aws-sdk/client-dynamodb/-/client-dynamodb-${SDK_VERSION}.tgz` },
  "@aws-sdk/lib-dynamodb": { version: SDK_VERSION, integrity: "sha512-6F2BFM/u6GqfeVxp8YdmyfBIBQX76Dc+UTlxtf+Kbfsl+80UezRLkx1evF0GOUUqAeokaFbk8zjgU/lAQai3hg==", tarball: `https://registry.npmjs.org/@aws-sdk/lib-dynamodb/-/lib-dynamodb-${SDK_VERSION}.tgz` },
};
const RUNTIME_VERSION = "0.1.2";
const RUNTIME_SPEC = `@dalgo/adapter-runtime@${RUNTIME_VERSION}`;
const RUNTIME_TARBALL = "https://registry.npmjs.org/@dalgo/adapter-runtime/-/adapter-runtime-0.1.2.tgz";
const RUNTIME_INTEGRITY = "sha512-dNX7DKuCrI4n7IXKfhWAglHNXwqHG0/f4oRveKw+CnG1jLS2KSyhAV+N6UeDmZoiNrAvOigUYVBzKaChYh+OSQ==";
const legacyCore = /@dal-go\/dalgo(?![\w-])/u;

export async function checkDynamoDBPackedConsumer({ repository, scratch, run, walk, sourceHashes, assertNoLegacyDependency, assertNoLegacyTree, core, typescript, nodeTypes, esbuild }) {
  const inputHashes = sourceHashes();
  const realSource = { gitSHA: run("git", ["rev-parse", "HEAD"]).trim(), dirty: run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim() !== "", inputSHA256: createHash("sha256").update(JSON.stringify(inputHashes)).digest("hex") };
  const producer = join(repository, "packages", "dynamodb");
  const fixture = join(repository, ".github", "fixtures", "dynamodb-packed-consumer");
  const consumer = join(scratch, "consumer");
  const tarballs = join(scratch, "tarballs");
  let passed = false;
  try {
    const original = JSON.parse(readFileSync(join(producer, "package.json"), "utf8"));
    assert.equal(original.name, NAME); assert.equal(original.private, true); assert.equal(original.version, "0.1.0");
    assert.equal(typeof original.scripts?.prepack, "string", "qualify the normal producer prepack");
    assertNoLegacyDependency(original, "private DynamoDB producer");
    assert.equal(original.peerDependencies["@dalgo/core"], ">=0.8.1 <0.9.0");
    assert.equal(original.peerDependencies["@dalgo/adapter-runtime"], ">=0.1.2 <1.0.0");
    mkdirSync(join(consumer, "src"), { recursive: true }); mkdirSync(join(consumer, "browser-src")); mkdirSync(join(consumer, "vendor-src")); mkdirSync(tarballs);
    // Producer declarations may build locally, but its runtime is NEVER packed
    // or substituted for the public0.1.2 installed by the clean consumer.
    run("pnpm", ["--filter", "@dalgo/adapter-runtime", "run", "build"], { timeout: 120_000 });
    run("npm", ["pack", "--ignore-scripts=false", "--pack-destination", tarballs], { cwd: producer, timeout: 120_000 });
    const packedFiles = readdirSync(tarballs);
    assert.equal(packedFiles.length, 1, "pack only the private DynamoDB source artifact");
    assert.ok(packedFiles[0].endsWith(".tgz"));
    const archive = join(tarballs, packedFiles[0]);
    const originalTarballHash = createHash("sha256").update(readFileSync(archive)).digest("hex");
    const archiveIntegrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "private-dynamodb-source-consumer", private: true, type: "module", devDependencies: { esbuild } }, null, 2) + "\n");
    for (const [from, to] of [["consumer.ts", "src/consumer.ts"], ["browser.ts", "browser-src/consumer.ts"], ["vendor-browser.ts", "vendor-src/consumer.ts"], ["runtime.mjs", "runtime.mjs"], ["native-runtime.mjs", "native-runtime.mjs"], ["browser-entry.mjs", "browser-entry.mjs"], ["browser-roots.mjs", "browser-roots.mjs"]]) copyFileSync(join(fixture, from), join(consumer, to));
    copyFileSync(join(repository, ".github", "fixtures", "native-packed-consumer", "browser-guard-loader.mjs"), join(consumer, "browser-guard-loader.mjs"));
    const compilerOptions = { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "ESNext.Disposable"], types: ["node"], strict: true, skipLibCheck: false, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true };
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["src/**/*.ts"] }, null, 2) + "\n");
    writeFileSync(join(consumer, "tsconfig.browser.json"), JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { module: "ESNext", moduleResolution: "Bundler", lib: ["ES2022", "DOM"], types: [] }, include: ["browser-src/**/*.ts"] }, null, 2) + "\n");
    run("npm", ["install", "--strict-peer-deps", "--no-audit", "--no-fund", "--save-exact", "--include=dev", "--registry=https://registry.npmjs.org", archive, core.spec, RUNTIME_SPEC, ...Object.keys(SDK).map(name => `${name}@${SDK_VERSION}`), typescript, nodeTypes], { cwd: consumer, timeout: 180_000 });
    const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
    const keys = Object.keys(lock.packages);
    for (const name of ["@dalgo/core", "@dalgo/adapter-runtime"]) assert.equal(keys.filter(key => key.endsWith(`node_modules/${name}`)).length, 1, `one installed identity for ${name}`);
    // Reject precisely the archived CORE, not the retained private adapter name.
    assert.ok(keys.every(key => !key.endsWith("node_modules/@dal-go/dalgo")));
    assert.ok(!existsSync(join(consumer, "node_modules", "@dal-go", "dalgo")));
    const coreLock = lock.packages["node_modules/@dalgo/core"];
    assert.equal(coreLock?.version, core.version); assert.equal(coreLock.resolved, core.tarball); assert.equal(coreLock.integrity, core.integrity);
    const runtimeLock = lock.packages["node_modules/@dalgo/adapter-runtime"];
    assert.equal(runtimeLock?.version, RUNTIME_VERSION); assert.equal(runtimeLock.resolved, RUNTIME_TARBALL); assert.equal(runtimeLock.integrity, RUNTIME_INTEGRITY);
    const sdkLocks = {};
    for (const [name, expected] of Object.entries(SDK)) {
      assert.equal(keys.filter(key => key.endsWith(`node_modules/${name}`)).length, 1, `one official SDK identity for ${name}`);
      const item = lock.packages[`node_modules/${name}`];
      assert.equal(item?.version, expected.version); assert.equal(item.resolved, expected.tarball); assert.equal(item.integrity, expected.integrity); sdkLocks[name] = item;
    }
    for (const [name, version] of [["@dalgo/core", core.version], ["@dalgo/adapter-runtime", RUNTIME_VERSION]]) {
      const manifest = JSON.parse(readFileSync(join(consumer, "node_modules", name, "package.json"), "utf8"));
      assert.equal(manifest.name, name); assert.equal(manifest.version, version); assertNoLegacyDependency(manifest, name);
    }
    const root = join(consumer, "node_modules", "@dal-go", "dalgo2dynamodb");
    assert.ok(!lstatSync(root).isSymbolicLink(), "consume the unpacked tarball, never a workspace link");
    const installed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(installed.name, NAME); assert.equal(installed.version, original.version); assert.equal(installed.private, true);
    assert.deepEqual(installed.peerDependencies, original.peerDependencies); assertNoLegacyDependency(installed, "private DynamoDB tarball");
    assert.deepEqual(installed.exports["."], { types: "./dist/index.d.ts", import: "./dist/index.js" });
    for (const file of walk(root)) if (/\.(?:js|mjs|d\.ts|json|map)$/u.test(file)) assert.ok(!legacyCore.test(readFileSync(file, "utf8")), "no archived core import in private artifact");
    for (const file of walk(join(root, "dist"))) if (file.endsWith(".d.ts")) assert.ok(!/@aws-sdk\/|@smithy\/|node:|\bNodeJS\b|\bBuffer\b/u.test(readFileSync(file, "utf8")), "adapter declarations must not pull vendor Node ambient types");
    const failures = [];
    for (const profile of ["tsconfig.json", "tsconfig.browser.json"]) {
      try { run(join(consumer, "node_modules", ".bin", "tsc"), ["-p", profile], { cwd: consumer, timeout: 120_000 }); }
      catch (error) { process.stderr.write(`DynamoDB packed declaration profile failed: ${profile}\n`); failures.push(error); }
    }
    if (failures.length > 0) throw failures[0];
    // Diagnostic only: direct vendor imports are distinct from the adapter-only DOM gate above.
    writeFileSync(join(consumer, "tsconfig.vendor-browser.json"), JSON.stringify({ extends: "./tsconfig.browser.json", include: ["vendor-src/**/*.ts"] }, null, 2)+"\n");
    let vendorDOM;
    try {
      run(join(consumer, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.vendor-browser.json"], { cwd: consumer, timeout: 120_000 });
      vendorDOM = { passed: true, scope: "direct official SDK DOM imports plus negative Node-global controls" };
    } catch (error) {
      const diagnostics = [error.stdout, error.stderr].filter(value => typeof value === "string").join("\n");
      assert.ok(diagnostics.length > 0, "retain the actual vendor-only diagnostic");
      vendorDOM = { passed: false, scope: "direct official SDK DOM imports; separate upstream ambient diagnostic, not an adapter DOM pass", diagnostics };
    }
    const runtime = JSON.parse(run(process.execPath, ["runtime.mjs"], { cwd: consumer, timeout: 30_000 }).trim());
    const { native: nativeRuntime, ...managedRuntime } = runtime;
    assert.deepEqual(managedRuntime, { coreAndErrorIdentity: true, actualSdkHandlerProtocol: true, typedValues: true, paging: true, batchOrderDuplicates: true, callerAfterDispatch: true, deadlineAfterDispatch: true, credentialWaiting: true, parsedBudgets: true, clientNeverDestroyed: true, reopen: true, cleanup: true, actualDynamoDBOrHostedIAM: false });
    assert.deepEqual(nativeRuntime, { officialLowLevelSdk: true, exactNativeValues: true, binaryNumericKeys: true, indexSortTiesAndBaseIdentity: true, fullUnionCursor: true, emptyEvaluatedPages: true, scopedCursor: true, projectionRefusals: true, batchOrderDuplicatesAnd101: true, unprocessedFailsWithoutRetry: true, parsedBudget: true, callerAfterDispatch: true, deadlineAfterDispatch: true, credentialWaiting: true, borrowedNeverDestroyed: true, reopen: true, cleanup: true, actualDynamoDBOrHostedIAM: false });
    const require = createRequire(join(consumer, "package.json")); assert.equal(require("esbuild/package.json").version, esbuild); const { build } = require("esbuild");
    const result = await build({ absWorkingDir: consumer, entryPoints: ["browser-entry.mjs"], outfile: "browser-bundle.mjs", platform: "browser", conditions: ["browser"], bundle: true, format: "esm", target: "es2022", metafile: true });
    const inputs = Object.keys(result.metafile.inputs).sort();
    for (const [name, input] of Object.entries(result.metafile.inputs)) {
      const path = relative(consumer, resolve(consumer, name)); assert.ok(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path), "all browser inputs belong to the clean consumer");
      assert.ok(!/node_modules\/(?:mongodb|redis|ioredis|bson|@duckdb\/[^/]+|node-stdlib-browser|buffer|process|stream-browserify|crypto-browserify|path-browserify)(?:\/|$)|\.node$/u.test(name), "no driver, native addon or browser polyfill");
      for (const imported of input.imports) assert.ok(!imported.external && !isBuiltin(imported.path) && !imported.path.startsWith("node:"), "no builtin or external exception");
    }
    for (const output of Object.values(result.metafile.outputs)) for (const imported of output.imports) assert.ok(!imported.external && !isBuiltin(imported.path) && !imported.path.startsWith("node:"));
    const yamlInputs = inputs.filter(name => /(?:^|\/)node_modules\/yaml\//u.test(name)); assert.ok(yamlInputs.every(name => /(?:^|\/)node_modules\/yaml\/browser\//u.test(name)));
    const browser = JSON.parse(run(process.execPath, ["--experimental-vm-modules", "--import", "./browser-guard-loader.mjs", "browser-roots.mjs"], { cwd: consumer, timeout: 30_000 }).trim());
    assert.deepEqual(browser, { packageGraphGuard: true, guardNegativeControls: true, coreAndErrorIdentity: true, lazy: true, parsedNativeValues: true, nativeRootIdentity: true, nativeLazy: true, nativeClosedValues: true, borrowedNeverDestroyed: true, fetches: 0, workers: 0 });
    const tree = JSON.parse(run("npm", ["ls", "--all", "--json", NAME, "@dalgo/core", "@dalgo/adapter-runtime", ...Object.keys(SDK)], { cwd: consumer, timeout: 30_000 })); assertNoLegacyTree(tree, "private DynamoDB consumer");
    assert.deepEqual(sourceHashes(), inputHashes, "private DynamoDB pack changed source");
    assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), originalTarballHash, "tested private tarball changed");
    const receipt = { mode: "dynamodb", artifactKind: "local private source tarball; not publication or release preview", producer: { name: NAME, private: true, version: original.version, prepack: original.scripts.prepack }, realSource, sourceInputHashes: inputHashes, sourceUnchanged: true, archive: { filename: packedFiles[0], sha256: originalTarballHash, integrity: archiveIntegrity, lifecycleScripts: true }, core: coreLock, publicRuntime: runtimeLock, sdk: sdkLocks, vendorDOMDiagnostic: vendorDOM, profiles: { node: compilerOptions, browser: { moduleResolution: "Bundler", types: [], lib: ["ES2022", "DOM"] } }, runtime, browser, browserInputs: inputs, yamlInputs, browserMetafile: result.metafile, browserBundleSHA256: createHash("sha256").update(readFileSync(join(consumer, "browser-bundle.mjs"))).digest("hex"), legacyReferences: 0, actualDynamoDBOrHostedIAM: false };
    if (process.env.DALGO_PACKED_CONSUMER_RECEIPT !== undefined) { mkdirSync(dirname(process.env.DALGO_PACKED_CONSUMER_RECEIPT), { recursive: true }); writeFileSync(process.env.DALGO_PACKED_CONSUMER_RECEIPT, JSON.stringify(receipt, null, 2) + "\n"); }
    passed = true; console.log(JSON.stringify(receipt, null, 2));
  } finally {
    try { assert.deepEqual(sourceHashes(), inputHashes, "private DynamoDB mode changed source inputs"); }
    finally { if (process.env.KEEP_PACKED_CONSUMER !== "1") rmSync(scratch, { recursive: true, force: true }); else process.stderr.write(`DynamoDB fixture ${passed ? "passed" : "failed"}; scratch retained at ${scratch}\n`); }
  }
}
