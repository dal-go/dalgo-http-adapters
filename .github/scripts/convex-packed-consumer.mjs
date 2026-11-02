// Canonical0.1.0 source artifact only, not a registry release or engine proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const NAME = "@dalgo/dalgo2convex";
const RUNTIME_VERSION = "0.1.2";
const RUNTIME_SPEC = "@dalgo/adapter-runtime@0.1.2";
const RUNTIME_TARBALL = "https://registry.npmjs.org/@dalgo/adapter-runtime/-/adapter-runtime-0.1.2.tgz";
const RUNTIME_INTEGRITY = "sha512-dNX7DKuCrI4n7IXKfhWAglHNXwqHG0/f4oRveKw+CnG1jLS2KSyhAV+N6UeDmZoiNrAvOigUYVBzKaChYh+OSQ==";
const CONVEX_VERSION = "1.49.0";
const CONVEX_TARBALL = "https://registry.npmjs.org/convex/-/convex-1.49.0.tgz";
const CONVEX_INTEGRITY = "sha512-mkr9oXF8/arkCI1kvYyGytWd62oVXNABh4uwLeI4UQVN6Zuudm4DlmSzNUJKF63djk6f/uUXC+6ffuVSkPLvzA==";
const legacyCore = /@dal-go\/dalgo(?![\w-])/u;

export async function checkConvexPackedConsumer({ repository, scratch, run, walk, sourceHashes, assertNoLegacyDependency, assertNoLegacyTree, core, typescript, nodeTypes, esbuild }) {
  const inputHashes = sourceHashes();
  const realSource = { gitSHA: run("git", ["rev-parse", "HEAD"]).trim(), dirty: run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim() !== "", inputSHA256: createHash("sha256").update(JSON.stringify(inputHashes)).digest("hex") };
  const producer = join(repository, "packages", "convex");
  const fixture = join(repository, ".github", "fixtures", "convex-packed-consumer");
  const consumer = join(scratch, "consumer"), tarballs = join(scratch, "tarballs");
  let passed = false;
  try {
    const original = JSON.parse(readFileSync(join(producer, "package.json"), "utf8"));
    assert.equal(original.name, NAME); assert.equal(original.version, "0.1.0"); assert.notEqual(original.private, true);
    assert.equal(typeof original.scripts?.prepack, "string"); assertNoLegacyDependency(original, "Convex source producer");
    assert.equal(original.dependencies.convex, CONVEX_VERSION);
    assert.equal(original.peerDependencies["@dalgo/core"], ">=0.8.1 <0.9.0");
    assert.equal(original.peerDependencies["@dalgo/adapter-runtime"], ">=0.1.2 <1.0.0");
    mkdirSync(join(consumer, "src"), { recursive: true }); mkdirSync(join(consumer, "browser-src")); mkdirSync(tarballs);
    run("pnpm", ["--filter", "@dalgo/adapter-runtime", "run", "build"], { timeout: 120_000 });
    // Normal producer build/prepack, exact source version; no manual version
    // rewrite, ignored lifecycle, release publication or unrelated battery.
    run("npm", ["pack", "--ignore-scripts=false", "--pack-destination", tarballs], { cwd: producer, timeout: 120_000 });
    const packedFiles = readdirSync(tarballs);
    assert.equal(packedFiles.length, 1); assert.ok(packedFiles[0].endsWith(".tgz"));
    const archive = join(tarballs, packedFiles[0]);
    const originalTarballHash = createHash("sha256").update(readFileSync(archive)).digest("hex");
    const archiveIntegrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "convex-source-packed-consumer", private: true, type: "module", devDependencies: { esbuild } }, null, 2) + "\n");
    for (const [from, to] of [["consumer.ts", "src/consumer.ts"], ["browser.ts", "browser-src/consumer.ts"], ["runtime.mjs", "runtime.mjs"], ["browser-entry.mjs", "browser-entry.mjs"], ["browser-roots.mjs", "browser-roots.mjs"]]) copyFileSync(join(fixture, from), join(consumer, to));
    copyFileSync(join(repository, ".github", "fixtures", "native-packed-consumer", "browser-guard-loader.mjs"), join(consumer, "browser-guard-loader.mjs"));
    const compilerOptions = { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022", "ESNext.Disposable"], types: ["node"], strict: true, skipLibCheck: false, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true };
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["src/**/*.ts"] }, null, 2) + "\n");
    writeFileSync(join(consumer, "tsconfig.browser.json"), JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { module: "ESNext", moduleResolution: "Bundler", lib: ["ES2022", "DOM"], types: [] }, include: ["browser-src/**/*.ts"] }, null, 2) + "\n");
    run("npm", ["install", "--engine-strict", "--strict-peer-deps", "--no-audit", "--no-fund", "--save-exact", "--include=dev", "--registry=https://registry.npmjs.org", archive, core.spec, RUNTIME_SPEC, "convex@" + CONVEX_VERSION, typescript, nodeTypes], { cwd: consumer, timeout: 180_000 });
    const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8")), keys = Object.keys(lock.packages);
    for (const name of ["@dalgo/core", "@dalgo/adapter-runtime", "convex", NAME]) assert.equal(keys.filter(key => key.endsWith("node_modules/" + name)).length, 1, "one installed identity for " + name);
    assert.ok(keys.every(key => !key.endsWith("node_modules/@dal-go/dalgo")));
    assert.ok(!existsSync(join(consumer, "node_modules", "@dal-go", "dalgo")));
    const coreLock = lock.packages["node_modules/@dalgo/core"], runtimeLock = lock.packages["node_modules/@dalgo/adapter-runtime"], convexLock = lock.packages["node_modules/convex"];
    for (const [record, version, resolved, integrity] of [[coreLock, core.version, core.tarball, core.integrity], [runtimeLock, RUNTIME_VERSION, RUNTIME_TARBALL, RUNTIME_INTEGRITY], [convexLock, CONVEX_VERSION, CONVEX_TARBALL, CONVEX_INTEGRITY]]) {
      assert.equal(record?.version, version); assert.equal(record.resolved, resolved); assert.equal(record.integrity, integrity);
    }
    const root = join(consumer, "node_modules", "@dalgo", "dalgo2convex");
    assert.ok(!lstatSync(root).isSymbolicLink(), "consume the tarball, never a workspace link");
    const installed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(installed.name, NAME); assert.equal(installed.version, original.version); assert.equal(installed.private, original.private);
    const vendor = JSON.parse(readFileSync(join(consumer, "node_modules", "convex", "package.json"), "utf8"));
    assert.equal(vendor.name, "convex"); assert.equal(vendor.version, CONVEX_VERSION);
    // Inspect the actual installed mandatory dependency, not a guessed engine
    // floor or a lockfile field that could omit the published manifest.
    assert.equal(vendor.engines?.node, ">=22.0.0", "pinned official Convex Node requirement changed");
    assert.equal(original.engines?.node, vendor.engines.node, "adapter cannot advertise a lower mandatory dependency floor");
    assert.deepEqual(installed.engines, original.engines, "normal packed artifact must preserve producer engine metadata");
    assert.deepEqual(installed.dependencies, original.dependencies); assert.deepEqual(installed.peerDependencies, original.peerDependencies);
    assert.deepEqual(installed.exports["."], { types: "./dist/index.d.ts", import: "./dist/index.js" });
    assertNoLegacyDependency(installed, "Convex source tarball");
    const require = createRequire(join(consumer, "package.json")), fromAdapter = createRequire(join(root, "package.json"));
    // Core/runtime expose ESM-only entries; their actual class identity is
    // asserted by the runtime/VM fixtures, alongside the single physical lock.
    assert.equal(fromAdapter.resolve("convex/values"), require.resolve("convex/values"), "one installed official codec resolution");
    for (const file of walk(root)) if (/\.(?:js|mjs|d\.ts|json|map)$/u.test(file)) assert.ok(!legacyCore.test(readFileSync(file, "utf8")), "no archived core import in artifact");
    const failures = [];
    for (const profile of ["tsconfig.json", "tsconfig.browser.json"]) {
      try { run(join(consumer, "node_modules", ".bin", "tsc"), ["-p", profile], { cwd: consumer, timeout: 120_000 }); }
      catch (error) { process.stderr.write("Convex packed declaration profile failed: " + profile + "\n"); failures.push(error); }
    }
    if (failures.length > 0) throw failures[0];
    const runtime = JSON.parse(run(process.execPath, ["runtime.mjs"], { cwd: consumer, timeout: 30_000 }).trim());
    assert.deepEqual(runtime, {
      coreAndPublicErrorIdentity: true, officialCodecIdentity: true, servedPublicQueryContract: true, nativeValues: true,
      cursorAndAuthScope: true, getManyOrderDuplicatesMissing: true, callerAfterDispatch: true, deadlineAfterDispatch: true,
      disconnect: true, reopen: true, retainedForeignLeases: true, noAdminOrOtherRoutes: true, noSecretCauses: true,
      dataUnchanged: true, cleanup: true, actualConvexBackend: false, actualHostedAuth: false,
    });
    assert.equal(require("esbuild/package.json").version, esbuild); const { build } = require("esbuild");
    const result = await build({ absWorkingDir: consumer, entryPoints: ["browser-entry.mjs"], outfile: "browser-bundle.mjs", platform: "browser", conditions: ["browser"], bundle: true, format: "esm", target: "es2022", metafile: true });
    const inputs = Object.keys(result.metafile.inputs).sort();
    for (const [name, input] of Object.entries(result.metafile.inputs)) {
      const path = relative(consumer, resolve(consumer, name));
      assert.ok(path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path), "all inputs belong to clean consumer");
      assert.ok(!/node_modules\/(?:mongodb|redis|ioredis|bson|ws|@duckdb\/[^/]+|node-stdlib-browser|buffer|process|stream-browserify|crypto-browserify|path-browserify)(?:\/|$)|\.node$/u.test(name), "no driver/addon/polyfill");
      assert.ok(!/node_modules\/convex\/dist\/esm\/(?:browser|server|cli)\//u.test(name), "official codec only, no stateful/admin/realtime client");
      for (const imported of input.imports) assert.ok(!imported.external && !isBuiltin(imported.path) && !imported.path.startsWith("node:"), "no builtin or external exception");
    }
    for (const output of Object.values(result.metafile.outputs)) for (const imported of output.imports) assert.ok(!imported.external && !isBuiltin(imported.path) && !imported.path.startsWith("node:"));
    const yamlInputs = inputs.filter(name => /(?:^|\/)node_modules\/yaml\//u.test(name));
    assert.ok(yamlInputs.every(name => /(?:^|\/)node_modules\/yaml\/browser\//u.test(name)));
    const browser = JSON.parse(run(process.execPath, ["--experimental-vm-modules", "--import", "./browser-guard-loader.mjs", "browser-roots.mjs"], { cwd: consumer, timeout: 30_000 }).trim());
    assert.deepEqual(browser, { packageGraphGuard: true, guardNegativeControls: true, coreAndPublicErrorIdentity: true, lazy: true, fetches: 0, workers: 0, actualBrowserQuery: false });
    const tree = JSON.parse(run("npm", ["ls", "--all", "--json", NAME, "@dalgo/core", "@dalgo/adapter-runtime", "convex"], { cwd: consumer, timeout: 30_000 }));
    assertNoLegacyTree(tree, "Convex packed consumer");
    assert.deepEqual(sourceHashes(), inputHashes, "source pack changed inputs");
    assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), originalTarballHash, "tested source tarball changed");
    const receipt = {
      mode: "convex", artifactKind: "canonical0.1.0 local source tarball, not registry release or version preview",
      producer: { name: NAME, version: original.version, prepack: original.scripts.prepack }, realSource,
      sourceInputHashes: inputHashes, sourceUnchanged: true,
      archive: { filename: packedFiles[0], sha256: originalTarballHash, integrity: archiveIntegrity, lifecycleScripts: true },
      core: coreLock, publicRuntime: runtimeLock, officialConvex: convexLock,
      engineCompatibility: { producer: original.engines.node, actualInstalledVendor: vendor.engines.node, packed: installed.engines.node, engineStrictInstall: true, executedNode: process.versions.node, actualNode22RunClaimed: false },
      profiles: { node: compilerOptions, browser: { moduleResolution: "Bundler", types: [], lib: ["ES2022", "DOM"], skipLibCheck: false } },
      runtime, browser, browserInputs: inputs, yamlInputs,
      registryPublicationClaimed: false, actualBackendOrHostedClaimed: false, installedCLIOrAppClaimed: false,
    };
    if (process.env.DALGO_PACKED_CONSUMER_RECEIPT !== undefined) { mkdirSync(dirname(process.env.DALGO_PACKED_CONSUMER_RECEIPT), { recursive: true }); writeFileSync(process.env.DALGO_PACKED_CONSUMER_RECEIPT, JSON.stringify(receipt, null, 2) + "\n"); }
    passed = true; console.log(JSON.stringify(receipt, null, 2));
  } finally {
    try { assert.deepEqual(sourceHashes(), inputHashes, "Convex mode changed source inputs"); }
    finally { if (process.env.KEEP_PACKED_CONSUMER !== "1") rmSync(scratch, { recursive: true, force: true }); else process.stderr.write(`Convex fixture ${passed ? "passed" : "failed"}; scratch retained at ${scratch}\n`); }
  }
}
