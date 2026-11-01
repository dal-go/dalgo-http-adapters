// Dedicated mode of the existing packed-consumer battery. Its shared producer
// staging/Changesets/core/source guards are supplied by the parent helper.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const RUNTIME_VERSION = "0.1.2";
const RUNTIME_SPEC = `@dalgo/adapter-runtime@${RUNTIME_VERSION}`;
const RUNTIME_TARBALL = "https://registry.npmjs.org/@dalgo/adapter-runtime/-/adapter-runtime-0.1.2.tgz";
const RUNTIME_INTEGRITY = "sha512-dNX7DKuCrI4n7IXKfhWAglHNXwqHG0/f4oRveKw+CnG1jLS2KSyhAV+N6UeDmZoiNrAvOigUYVBzKaChYh+OSQ==";
const DIRECTORIES = ["redis-resp", "upstash-redis"];

export async function checkUpstashPackedConsumer({ repository, scratch, run, walk, sourceHashes, packingWorkspace, assertNoLegacyDependency, assertNoLegacyTree, core, typescript, nodeTypes, esbuild }) {
  const inputHashes = sourceHashes();
  const source = { gitSHA: run("git", ["rev-parse", "HEAD"]).trim(), dirty: run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim() !== "", inputSHA256: createHash("sha256").update(JSON.stringify(inputHashes)).digest("hex") };
  const fixture = join(repository, ".github", "fixtures", "upstash-packed-consumer");
  const consumer = join(scratch, "consumer");
  const tarballs = join(scratch, "tarballs");
  let passed = false;
  try {
    mkdirSync(join(consumer, "src"), { recursive: true });
    mkdirSync(join(consumer, "browser-src"));
    mkdirSync(tarballs);
    const packing = packingWorkspace();
    const archives = [];
    for (const name of DIRECTORIES) {
      const args = packing.preview
        ? ["pack", "--ignore-scripts", "--json", "--pack-destination", tarballs]
        : ["pack", "--json", "--pack-destination", tarballs];
      const metadata = JSON.parse(run("npm", args, { cwd: join(packing.directory, "packages", name), timeout: 120_000 }));
      assert.equal(metadata.length, 1);
      const actual = metadata[0];
      if (packing.preview) assert.equal(actual.version, packing.preview.versions[actual.name].version);
      archives.push({ directory: `packages/${name}`, name: actual.name, version: actual.version, filename: actual.filename, integrity: actual.integrity, lifecycleScripts: !packing.preview });
    }
    const packedFiles = readdirSync(tarballs).sort();
    assert.equal(packedFiles.length, 2, "pack only Redis protocol and Upstash; never a runtime preview");
    assert.ok(packedFiles.every(name => name.endsWith(".tgz") && !name.startsWith("dalgo-adapter-runtime-")));
    const hashes = () => Object.fromEntries(packedFiles.map(name => [name, createHash("sha256").update(readFileSync(join(tarballs, name))).digest("hex")]));
    const originalHashes = hashes();
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "dalgo-upstash-packed-consumer", private: true, type: "module", devDependencies: { esbuild } }, null, 2) + "\n");
    for (const [from, to] of [["consumer.ts", "src/consumer.ts"], ["browser.ts", "browser-src/consumer.ts"], ["runtime.mjs", "runtime.mjs"], ["browser-entry.mjs", "browser-entry.mjs"], ["browser-roots.mjs", "browser-roots.mjs"]]) copyFileSync(join(fixture, from), join(consumer, to));
    // Reuse the already reviewed actual package-graph guard, including CJS hooks.
    copyFileSync(join(repository, ".github", "fixtures", "native-packed-consumer", "browser-guard-loader.mjs"), join(consumer, "browser-guard-loader.mjs"));
    const compilerOptions = { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "ESNext.Disposable"], types: ["node"], strict: true, skipLibCheck: false, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true };
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["src/**/*.ts"] }, null, 2) + "\n");
    writeFileSync(join(consumer, "tsconfig.browser.json"), JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { module: "ESNext", moduleResolution: "Bundler", lib: ["ES2022", "DOM"], types: [] }, include: ["browser-src/**/*.ts"] }, null, 2) + "\n");
    run("npm", ["install", "--strict-peer-deps", "--no-audit", "--no-fund", "--save-exact", "--include=dev", "--registry=https://registry.npmjs.org", ...packedFiles.map(name => join(tarballs, name)), RUNTIME_SPEC, core.spec, typescript, nodeTypes], { cwd: consumer, timeout: 180_000 });
    const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
    const keys = Object.keys(lock.packages);
    for (const name of ["@dalgo/core", "@dalgo/adapter-runtime"]) assert.equal(keys.filter(key => key.endsWith(`node_modules/${name}`)).length, 1, `one installed identity for ${name}`);
    assert.ok(keys.every(key => !key.endsWith("node_modules/@dal-go/dalgo")), "no archived core package");
    assert.ok(!existsSync(join(consumer, "node_modules", "@dal-go", "dalgo")));
    const coreLock = lock.packages["node_modules/@dalgo/core"];
    assert.equal(coreLock?.version, core.version); assert.equal(coreLock.resolved, core.tarball); assert.equal(coreLock.integrity, core.integrity);
    const runtimeLock = lock.packages["node_modules/@dalgo/adapter-runtime"];
    assert.equal(runtimeLock?.version, RUNTIME_VERSION); assert.equal(runtimeLock.resolved, RUNTIME_TARBALL); assert.equal(runtimeLock.integrity, RUNTIME_INTEGRITY);
    for (const [name, version] of [["@dalgo/core", core.version], ["@dalgo/adapter-runtime", RUNTIME_VERSION]]) {
      const manifest = JSON.parse(readFileSync(join(consumer, "node_modules", name, "package.json"), "utf8"));
      assert.equal(manifest.name, name); assert.equal(manifest.version, version);
      assertNoLegacyDependency(manifest, name);
    }
    const packageRoots = Object.fromEntries(["redis-resp", "upstash-redis"].map(name => [name, join(consumer, "node_modules", "@dalgo", `dalgo2${name}`)]));
    for (const [name, root] of Object.entries(packageRoots)) {
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      assertNoLegacyDependency(manifest, name);
      assert.deepEqual(manifest.exports["."], { types: "./dist/index.d.ts", import: "./dist/index.js" });
      if (packing.preview) {
        assert.equal(manifest.version, packing.preview.versions[manifest.name].version);
        assert.deepEqual(manifest.peerDependencies, packing.preview.versions[manifest.name].peers);
      }
      for (const file of walk(root)) {
        if (/\.(?:js|mjs|d\.ts|json|map)$/u.test(file)) assert.ok(!/@dal-go\/dalgo(?![\w-])/u.test(readFileSync(file, "utf8")), "no archived core in packed package");
      }
    }
    const redisManifest = JSON.parse(readFileSync(join(packageRoots["redis-resp"], "package.json"), "utf8"));
    assert.deepEqual(redisManifest.exports["./protocol"], { types: "./dist/protocol.d.ts", import: "./dist/protocol.js" });
    for (const file of Object.values(redisManifest.exports["./protocol"])) assert.ok(existsSync(join(packageRoots["redis-resp"], file)));
    const upstashManifest = JSON.parse(readFileSync(join(packageRoots["upstash-redis"], "package.json"), "utf8"));
    assert.equal(upstashManifest.peerDependencies["@dalgo/adapter-runtime"], ">=0.1.2 <1.0.0", "do not raise the runtime floor or substitute preview0.2");
    assert.equal(upstashManifest.peerDependencies["@dalgo/dalgo2redis-resp"], ">=0.2.0 <1.0.0");
    const profiles = ["tsconfig.json", "tsconfig.browser.json"];
    const failures = [];
    for (const profile of profiles) {
      try { run(join(consumer, "node_modules", ".bin", "tsc"), ["-p", profile], { cwd: consumer, timeout: 120_000 }); }
      catch (error) { process.stderr.write(`Upstash packed declaration profile failed: ${profile}\n`); failures.push(error); }
    }
    if (failures.length > 0) throw failures[0];
    const runtime = JSON.parse(run(process.execPath, ["runtime.mjs"], { cwd: consumer, timeout: 30_000 }).trim());
    assert.deepEqual(runtime, { publicErrorIdentity: true, servedHttpContract: true, nativeValues: true, malformedRepliesRefused: true, scopedScan: true, badAuthRedacted: true, readOnly: true, callerAfterDispatch: true, deadlineAfterDispatch: true, reopen: true, cleanup: true, hostedUpstash: false });
    const require = createRequire(join(consumer, "package.json"));
    assert.equal(require("esbuild/package.json").version, esbuild);
    const { build } = require("esbuild");
    const result = await build({ absWorkingDir: consumer, entryPoints: ["browser-entry.mjs"], outfile: "browser-bundle.mjs", platform: "browser", conditions: ["browser"], bundle: true, format: "esm", target: "es2022", metafile: true });
    for (const [name, input] of Object.entries(result.metafile.inputs)) {
      const path = relative(consumer, resolve(consumer, name));
      assert.ok(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path), "all browser inputs must come from clean consumer");
      assert.ok(!/dalgo2redis-resp\/dist\/(?:node|server)\.js$|node_modules\/(?:mongodb|redis|ioredis|bson|@duckdb\/[^/]+)(?:\/|$)|\.node$/u.test(name), "no native driver in browser graph");
      for (const imported of input.imports) assert.ok(!imported.external && !isBuiltin(imported.path) && !imported.path.startsWith("node:"), "no external exception, builtin or polyfill in browser graph");
    }
    for (const output of Object.values(result.metafile.outputs)) for (const imported of output.imports) assert.ok(!imported.external && !isBuiltin(imported.path) && !imported.path.startsWith("node:"));
    const inputs = Object.keys(result.metafile.inputs).sort();
    const yamlInputs = inputs.filter(name => /(?:^|\/)node_modules\/yaml\//u.test(name));
    assert.ok(yamlInputs.every(name => /(?:^|\/)node_modules\/yaml\/browser\//u.test(name)), "honor the public YAML browser mapping");
    assert.ok(inputs.every(name => !/node_modules\/(?:node-stdlib-browser|buffer|process|stream-browserify|crypto-browserify|path-browserify)(?:\/|$)/u.test(name)), "no Node browser polyfills");
    const browser = JSON.parse(run(process.execPath, ["--experimental-vm-modules", "--import", "./browser-guard-loader.mjs", "browser-roots.mjs"], { cwd: consumer, timeout: 30_000 }).trim());
    assert.deepEqual(browser, { packageGraphGuard: true, guardNegativeControls: true, publicErrorIdentity: true, lazy: true, fetches: 0, workers: 0 });
    const tree = JSON.parse(run("npm", ["ls", "--all", "--json", "@dalgo/core", "@dalgo/adapter-runtime", "@dalgo/dalgo2redis-resp", "@dalgo/dalgo2upstash-redis"], { cwd: consumer, timeout: 30_000 }));
    assertNoLegacyTree(tree, "installed Upstash consumer");
    assert.deepEqual(sourceHashes(), inputHashes, "Upstash preview/install changed source");
    assert.deepEqual(hashes(), originalHashes, "tested tarballs changed");
    const receipt = { mode: "upstash", realSource: source, sourceInputHashes: inputHashes, sourceUnchanged: true, releasePreview: packing.preview, archives, tarballs: originalHashes, core: coreLock, publicRuntime: runtimeLock, profiles: { node: compilerOptions, browser: { moduleResolution: "Bundler", types: [], lib: ["ES2022", "DOM"] } }, runtime, browser, browserInputs: inputs, yamlInputs, browserMetafile: result.metafile, browserBundleSHA256: createHash("sha256").update(readFileSync(join(consumer, "browser-bundle.mjs"))).digest("hex"), legacyReferences: 0, hostedUpstash: false };
    if (process.env.DALGO_PACKED_CONSUMER_RECEIPT !== undefined) {
      mkdirSync(dirname(process.env.DALGO_PACKED_CONSUMER_RECEIPT), { recursive: true });
      writeFileSync(process.env.DALGO_PACKED_CONSUMER_RECEIPT, JSON.stringify(receipt, null, 2) + "\n");
    }
    passed = true;
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    try { assert.deepEqual(sourceHashes(), inputHashes, "Upstash mode changed tracked or untracked source"); }
    finally {
      if (process.env.KEEP_PACKED_CONSUMER !== "1") rmSync(scratch, { recursive: true, force: true });
      else process.stderr.write(`Upstash fixture ${passed ? "passed" : "failed"}; scratch retained at ${scratch}\n`);
    }
  }
}
