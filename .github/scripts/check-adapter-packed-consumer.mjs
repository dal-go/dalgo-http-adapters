// Node 24. Packs the browser adapters, installs only those tarballs plus the
// exact released @dalgo/core version in a fresh directory outside this repository,
// and type-checks/runs a consumer that never has @dal-go/dalgo available.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_VERSION = "0.8.1";
const CORE_SPEC = `@dalgo/core@${CORE_VERSION}`;
const CORE_TARBALL = `https://registry.npmjs.org/@dalgo/core/-/core-${CORE_VERSION}.tgz`;
const CORE_INTEGRITY = "sha512-stXi8PPeR3G7AxCairfJEMDGd4KuiU5eyipPDgibCEVlRD435t2FvfQQj3mp+FgZEVzcdel4Z4Iwq3xm9URRSA==";
const TYPESCRIPT_SPEC = "typescript@6.0.3";
const legacySpecifier = /@dal-go\/dalgo(?![\w-])/u;

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(join(tmpdir(), "dalgo-adapter-packed-consumer-"));
const relativeScratch = relative(repository, scratch);
assert.ok(
  relativeScratch.startsWith(`..${sep}`) || isAbsolute(relativeScratch),
  "the packed consumer must live outside the repository",
);

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch (error) {
    if (typeof error.stdout === "string") process.stderr.write(error.stdout);
    if (typeof error.stderr === "string") process.stderr.write(error.stderr);
    throw error;
  }
}

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function assertNoLegacyDependency(manifest, label) {
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert.ok(
      !Object.hasOwn(manifest[section] ?? {}, "@dal-go/dalgo"),
      `${label} manifest declares the legacy @dal-go/dalgo package in ${section}`,
    );
  }
}

function assertNoLegacyTree(node, label) {
  assert.notEqual(node.name, "@dal-go/dalgo", `${label} tree contains @dal-go/dalgo`);
  for (const dependency of Object.values(node.dependencies ?? {})) {
    assertNoLegacyTree(dependency, label);
  }
}

function sourceHashes() {
  const files = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort();
  return files.map((file) => {
    const path = join(repository, file);
    const bytes = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path);
    return [file, createHash("sha256").update(bytes).digest("hex")];
  });
}

function packingWorkspace() {
  const pending = join(repository, ".changeset", "clickhouse-ordinal-contract.md");
  if (!existsSync(pending)) return { directory: repository, preview: false };
  // The source runtime keeps its released version until the normal version PR.
  // Preview REAL Changesets generation in scratch so strict peers can exercise
  // the upcoming ordinal contract without lying about its >=0.2.0 floor or
  // hand-editing any package version. Build source first; packing executes no
  // lifecycle scripts and scratch contains no credentials or node_modules.
  const cliManifest = JSON.parse(readFileSync(join(repository, "node_modules", "@changesets", "cli", "package.json"), "utf8"));
  assert.equal(cliManifest.version, "3.0.3", "use the installed declared Changesets CLI");
  const packed = new Set(["adapter-runtime", "clickhouse", "couchdb", "libsql", "postgrest", "typesense"]);
  const filters = [...packed].flatMap((name) => ["--filter", name === "adapter-runtime" ? "@dalgo/adapter-runtime" : `@dalgo/dalgo2${name}`]);
  run("pnpm", [...filters, "run", "build"], { timeout: 180_000 });
  const directory = join(scratch, "release-preview");
  mkdirSync(directory, { recursive: true });
  copyFileSync(join(repository, "package.json"), join(directory, "package.json"));
  copyFileSync(join(repository, "pnpm-workspace.yaml"), join(directory, "pnpm-workspace.yaml"));
  mkdirSync(join(directory, ".changeset"));
  for (const name of readdirSync(join(repository, ".changeset"))) {
    if (name === "config.json" || name.endsWith(".md")) copyFileSync(join(repository, ".changeset", name), join(directory, ".changeset", name));
  }
  const config = JSON.parse(readFileSync(join(directory, ".changeset", "config.json"), "utf8"));
  assert.equal(config.commit, false, "release preview must not create commits");
  const budget = { files: 0, bytes: 0 };
  const stage = (source, destination) => {
    const info = lstatSync(source);
    assert.ok(!info.isSymbolicLink(), "pack staging must not follow source symlinks");
    const name = source.split(sep).at(-1);
    assert.ok(!name.startsWith(".env") && !["node_modules", ".git", ".wb", ".wb-worklog"].includes(name), "private inputs cannot enter pack staging");
    if (info.isDirectory()) {
      mkdirSync(destination, { recursive: true });
      for (const name of readdirSync(source)) stage(join(source, name), join(destination, name));
    } else {
      assert.ok(info.isFile());
      budget.files += 1; budget.bytes += info.size;
      assert.ok(budget.files <= 5000 && budget.bytes <= 64 * 1024 * 1024, "release preview staging exceeded its bound");
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
  };
  for (const name of readdirSync(join(repository, "packages"))) {
    const source = join(repository, "packages", name);
    const manifest = join(source, "package.json");
    if (!existsSync(manifest)) continue;
    const destination = join(directory, "packages", name);
    mkdirSync(destination, { recursive: true });
    copyFileSync(manifest, join(destination, "package.json"));
    if (packed.has(name)) {
      const metadata = JSON.parse(readFileSync(manifest, "utf8"));
      for (const entry of metadata.files) {
        assert.match(entry, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u);
        assert.ok(!entry.split("/").includes(".."));
        stage(join(source, entry), join(destination, entry));
      }
    }
  }
  // Changesets status needs a real HEAD/main divergence context. This fresh,
  // no-remote Git repository is ONLY synthetic test metadata in scratch; it is
  // never the producer repository or a version-PR/publication receipt.
  const fixtureEnv = { ...process.env };
  for (const name of Object.keys(fixtureEnv)) if (name.startsWith("GIT_")) delete fixtureEnv[name];
  const gitOptions = { cwd: directory, env: fixtureEnv, timeout: 30_000 };
  run("git", ["init", "--initial-branch=main"], gitOptions);
  run("git", ["add", "--", "."], gitOptions);
  run("git", ["-c", "user.name=DALgo release preview fixture", "-c", "user.email=release-preview@example.invalid", "commit", "-m", "Synthetic release-preview baseline"], gitOptions);
  const baseline = run("git", ["rev-parse", "HEAD"], gitOptions).trim();
  assert.match(baseline, /^[a-f0-9]{40}$/u);
  assert.equal(run("git", ["branch", "--show-current"], gitOptions).trim(), "main");
  assert.equal(run("git", ["remote"], gitOptions).trim(), "", "preview baseline must have no remote");
  const cli = join(repository, "node_modules", "@changesets", "cli", "bin.js");
  const planPath = join(directory, "changesets-plan.json");
  run(process.execPath, [cli, "status", "--output", planPath], { cwd: directory, env: fixtureEnv, timeout: 60_000 });
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  run(process.execPath, [cli, "version"], { cwd: directory, env: fixtureEnv, timeout: 60_000 });
  const runtime = JSON.parse(readFileSync(join(directory, "packages", "adapter-runtime", "package.json"), "utf8"));
  assert.match(runtime.version, /^0\.2\./u, "ordinary Changesets must produce the declared ordinal runtime minor");
  const versions = Object.fromEntries([...packed].map((name) => {
    const metadata = JSON.parse(readFileSync(join(directory, "packages", name, "package.json"), "utf8"));
    return [metadata.name, { version: metadata.version, peers: metadata.peerDependencies }];
  }));
  return { directory, preview: { kind: "ordinary Changesets release preview, not publication/version-PR receipt", syntheticGitBaseline: { sha: baseline, branch: "main", remotes: [], kind: "scratch test fixture, not source history" }, cliVersion: cliManifest.version, plan, versions, stagedFiles: budget.files, stagedBytes: budget.bytes } };
}

const inputHashes = sourceHashes();
const realSource = {
  gitSHA: run("git", ["rev-parse", "HEAD"]).trim(),
  dirty: run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim() !== "",
  inputSHA256: createHash("sha256").update(JSON.stringify(inputHashes)).digest("hex"),
};
try {
  const tarballs = join(scratch, "tarballs");
  const consumer = join(scratch, "consumer");
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(join(consumer, "src"), { recursive: true });
  const packing = packingWorkspace();

  if (packing.preview) {
    // npm documents pack's explicit --ignore-scripts CLI option. The compiled
    // source is already staged; this local archive step must never rebuild it.
    // https://docs.npmjs.com/cli/v11/commands/npm-pack/#ignore-scripts
    const archives = [];
    for (const name of ["adapter-runtime", "clickhouse", "couchdb", "libsql", "postgrest", "typesense"]) {
      const args = ["pack", "--ignore-scripts", "--json", "--pack-destination", tarballs];
      const metadata = JSON.parse(run("npm", args, { cwd: join(packing.directory, "packages", name), timeout: 120_000 }));
      assert.equal(metadata.length, 1, "one local preview archive per package");
      const actual = metadata[0];
      assert.equal(actual.version, packing.preview.versions[actual.name].version);
      archives.push({ command: ["npm", ...args], directory: `packages/${name}`, name: actual.name, version: actual.version, filename: actual.filename, integrity: actual.integrity, shasum: actual.shasum });
    }
    packing.preview.packing = { kind: "local npm archives, not publication", lifecycleScripts: false, archives };
  } else {
    run("pnpm", [
      "--filter", "@dalgo/adapter-runtime",
      "--filter", "@dalgo/dalgo2clickhouse",
      "--filter", "@dalgo/dalgo2couchdb",
      "--filter", "@dalgo/dalgo2libsql",
      "--filter", "@dalgo/dalgo2postgrest",
      "--filter", "@dalgo/dalgo2typesense",
      "pack",
      "--pack-destination", tarballs,
    ], { cwd: packing.directory });
  }

  const packFiles = readdirSync(tarballs).filter((name) => name.endsWith(".tgz")).sort();
  assert.equal(packFiles.length, 6, "expected exactly six packed adapter tarballs");
  const packedHashes = () => Object.fromEntries(packFiles.map((name) => [name, createHash("sha256").update(readFileSync(join(tarballs, name))).digest("hex")]));
  const originalTarballHashes = packedHashes();
  const tarball = (prefix) => {
    const matches = packFiles.filter((name) => name.startsWith(prefix));
    assert.equal(matches.length, 1, `expected one tarball for ${prefix}`);
    return join(tarballs, matches[0]);
  };

  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "dalgo-adapter-packed-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  copyFileSync(
    join(repository, ".github", "scripts", "adapter-packed-consumer.ts"),
    join(consumer, "src", "consumer.ts"),
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022", "DOM"],
        strict: true,
        skipLibCheck: false,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
      },
      include: ["src/**/*.ts"],
    }, null, 2)}\n`,
  );

  run("npm", [
    "install",
    "--strict-peer-deps",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    "--registry=https://registry.npmjs.org",
    tarball("dalgo-adapter-runtime-"),
    tarball("dalgo-dalgo2clickhouse-"),
    tarball("dalgo-dalgo2couchdb-"),
    tarball("dalgo-dalgo2libsql-"),
    tarball("dalgo-dalgo2postgrest-"),
    tarball("dalgo-dalgo2typesense-"),
    CORE_SPEC,
    TYPESCRIPT_SPEC,
  ], { cwd: consumer });

  const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
  const lockKeys = Object.keys(lock.packages);
  assert.ok(
    lockKeys.every((key) => !key.endsWith("node_modules/@dal-go/dalgo")),
    "package-lock.json contains the legacy @dal-go/dalgo package",
  );
  assert.equal(
    lockKeys.filter((key) => key.endsWith("node_modules/@dalgo/core")).length,
    1,
    "exactly one @dalgo/core identity must be installed",
  );
  assert.ok(
    !existsSync(join(consumer, "node_modules", "@dal-go", "dalgo")),
    "node_modules contains @dal-go/dalgo",
  );

  const core = lock.packages["node_modules/@dalgo/core"];
  assert.equal(core?.version, CORE_VERSION);
  assert.equal(core.resolved, CORE_TARBALL);
  assert.equal(core.integrity, CORE_INTEGRITY);
  const coreManifest = JSON.parse(readFileSync(join(consumer, "node_modules", "@dalgo", "core", "package.json"), "utf8"));
  assert.equal(coreManifest.name, "@dalgo/core");
  assert.equal(coreManifest.version, CORE_VERSION);

  for (const name of ["postgrest", "couchdb", "libsql", "typesense", "adapter-runtime"]) {
    for (const file of walk(join(repository, "packages", name, "src"))) {
      assert.ok(!legacySpecifier.test(readFileSync(file, "utf8")), `${file} references @dal-go/dalgo`);
    }
  }

  const packageRoots = {
    clickhouse: join(consumer, "node_modules", "@dalgo", "dalgo2clickhouse"),
    postgrest: join(consumer, "node_modules", "@dalgo", "dalgo2postgrest"),
    couch: join(consumer, "node_modules", "@dalgo", "dalgo2couchdb"),
    libsql: join(consumer, "node_modules", "@dalgo", "dalgo2libsql"),
    typesense: join(consumer, "node_modules", "@dalgo", "dalgo2typesense"),
    runtime: join(consumer, "node_modules", "@dalgo", "adapter-runtime"),
  };
  for (const [label, root] of Object.entries(packageRoots)) {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(manifest.name, relative(join(consumer, "node_modules"), root).split(sep).join("/"));
    if (packing.preview) {
      assert.equal(manifest.version, packing.preview.versions[manifest.name].version);
      assert.deepEqual(manifest.peerDependencies, packing.preview.versions[manifest.name].peers);
    }
    assertNoLegacyDependency(manifest, label);
    assert.deepEqual(manifest.exports["."], { types: "./dist/index.d.ts", import: "./dist/index.js" });
    for (const file of walk(root)) {
      if (!/\.(?:js|mjs|d\.ts|json|map)$/u.test(file)) continue;
      const contents = readFileSync(file, "utf8");
      assert.ok(!legacySpecifier.test(contents), `${file} references @dal-go/dalgo`);
    }
  }

  const postDeclaration = readFileSync(join(packageRoots.postgrest, "dist", "database.d.ts"), "utf8");
  const clickhouseIndex = readFileSync(join(packageRoots.clickhouse, "dist", "index.d.ts"), "utf8");
  const clickhouseNative = readFileSync(join(packageRoots.clickhouse, "dist", "native.d.ts"), "utf8");
  assert.match(clickhouseIndex, /NativeClickHouseDatabase as ClickHouseDatabase/u);
  assert.match(clickhouseNative, /implements OrdinalQueryExecutor/u);
  assert.match(clickhouseNative, /readonly readOnly: true/u);
  assert.ok(!existsSync(join(packageRoots.clickhouse, "dist", "database.js")), "private keyed/append prototype must not be packed");
  assert.ok(!existsSync(join(packageRoots.clickhouse, "dist", "query.js")), "private keyed SQL compiler must not be packed");
  assert.match(
    postDeclaration,
    /runReadwriteTransaction<Result>\(callback: \(transaction: ReadwriteTransaction\) => Promise<Result>\)/u,
  );
  assert.match(postDeclaration, /from "@dalgo\/core"/u);
  assert.ok(!postDeclaration.includes("@dal-go/dalgo"), "packed PostgREST declarations reference the legacy package");

  const couchIndexDeclaration = readFileSync(join(packageRoots.couch, "dist", "index.d.ts"), "utf8");
  const nativeDeclaration = readFileSync(join(packageRoots.couch, "dist", "native.d.ts"), "utf8");
  assert.match(couchIndexDeclaration, /NativeCouchDbDatabase/u);
  assert.match(couchIndexDeclaration, /NATIVE_COUCHDB_READ_CAPABILITIES/u);
  assert.match(nativeDeclaration, /export declare class NativeCouchDbDatabase implements Database/u);
  assert.match(nativeDeclaration, /readonly readOnly: true/u);
  assert.match(nativeDeclaration, /NativeCouchDbQuery<T> extends StructuredQuery<T>/u);
  assert.match(nativeDeclaration, /from "@dalgo\/core"/u);
  assert.ok(!legacySpecifier.test(nativeDeclaration), "packed native CouchDB declarations reference the legacy package");

  const libsqlIndexDeclaration = readFileSync(join(packageRoots.libsql, "dist", "index.d.ts"), "utf8");
  const libsqlNativeDeclaration = readFileSync(join(packageRoots.libsql, "dist", "native.d.ts"), "utf8");
  const libsqlCapabilitiesDeclaration = readFileSync(join(packageRoots.libsql, "dist", "capabilities.d.ts"), "utf8");
  assert.match(libsqlIndexDeclaration, /NativeLibSQLDatabase/u);
  assert.match(libsqlIndexDeclaration, /NATIVE_LIBSQL_READ_CAPABILITIES/u);
  assert.match(libsqlIndexDeclaration, /LIBSQL_READ_CAPABILITIES/u);
  assert.match(libsqlNativeDeclaration, /export declare class NativeLibSQLDatabase implements Database/u);
  assert.match(libsqlNativeDeclaration, /readonly readOnly: true/u);
  assert.match(libsqlNativeDeclaration, /from "@dalgo\/core"/u);
  assert.match(libsqlCapabilitiesDeclaration, /storage: "native-rows"/u);
  assert.ok(!legacySpecifier.test(libsqlNativeDeclaration), "packed native libSQL declarations reference the legacy package");

  const typesenseIndexDeclaration = readFileSync(join(packageRoots.typesense, "dist", "index.d.ts"), "utf8");
  const typesenseDatabaseDeclaration = readFileSync(join(packageRoots.typesense, "dist", "database.d.ts"), "utf8");
  const typesenseSearchDeclaration = readFileSync(join(packageRoots.typesense, "dist", "search.d.ts"), "utf8");
  assert.match(typesenseIndexDeclaration, /TypesenseDatabase/u);
  assert.match(typesenseIndexDeclaration, /TypesenseContinuationBoundError/u);
  assert.match(typesenseIndexDeclaration, /TYPESENSE_READ_CAPABILITIES/u);
  assert.match(typesenseDatabaseDeclaration, /export declare class TypesenseDatabase implements Database, CancellableQueryExecutor/u);
  assert.match(typesenseDatabaseDeclaration, /readonly readOnly: true/u);
  assert.match(typesenseDatabaseDeclaration, /from "@dalgo\/core"/u);
  assert.match(typesenseSearchDeclaration, /readonly textMatch\?: string/u);
  assert.ok(!legacySpecifier.test(typesenseDatabaseDeclaration), "packed Typesense declarations reference the legacy package");

  run(join(consumer, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: consumer });

  copyFileSync(
    join(repository, ".github", "scripts", "adapter-packed-consumer-runtime.mjs"),
    join(consumer, "runtime.mjs"),
  );
  const runtime = JSON.parse(run(process.execPath, ["runtime.mjs"], { cwd: consumer }).trim());
  assert.deepEqual(runtime, {
    core: { collection: "function", key: "function" },
    runtime: { isCancellableQueryExecutor: "function" },
    clickhouse: { readOnly: true, queryOrdinal: "function", isOrdinal: true, sameAlias: true, keyedOrWriteMethods: false },
    postgrest: {
      queryWithSignal: "function",
      discover: "function",
      testConnection: "function",
      runReadwriteTransaction: "function",
    },
    couch: { queryWithSignal: "function", runReadwriteTransaction: "function" },
    libsql: {
      queryWithSignal: "function",
      discover: "function",
      testConnection: "function",
      managedQueryWithSignal: "function",
    },
    nativeLibsql: {
      readOnly: true,
      queryWithSignal: "function",
      discover: "function",
      testConnection: "function",
      describe: "function",
      insertRefused: true,
      transactionRefused: true,
    },
    native: {
      readOnly: true,
      queryWithSignal: "function",
      testConnection: "function",
      describe: "function",
      insertRefused: true,
      transactionRefused: true,
    },
    typesense: {
      readOnly: true,
      queryWithSignal: "function",
      search: "function",
      schema: "function",
      describe: "function",
      textMatch: "string",
      transactionRefused: true,
    },
  });

  const tree = JSON.parse(run("npm", [
    "ls",
    "--all",
    "--json",
    "@dalgo/core",
    "@dalgo/adapter-runtime",
    "@dalgo/dalgo2clickhouse",
    "@dalgo/dalgo2couchdb",
    "@dalgo/dalgo2libsql",
    "@dalgo/dalgo2postgrest",
    "@dalgo/dalgo2typesense",
  ], { cwd: consumer }));
  assertNoLegacyTree(tree, "installed npm");
  assert.deepEqual(sourceHashes(), inputHashes, "pack/Changesets preview changed source inputs");
  assert.deepEqual(packedHashes(), originalTarballHashes, "tested packed tarballs changed during installation or consumer checks");

  const receipt = {
    scratch,
    sourceGitSHA: realSource.gitSHA,
    realSource,
    sourceInputHashes: inputHashes,
    sourceInputSHA256: createHash("sha256").update(JSON.stringify(inputHashes)).digest("hex"),
    sourceUnchanged: true,
    releasePreview: packing.preview,
    tarballs: originalTarballHashes,
    core: { name: coreManifest.name, version: coreManifest.version, resolved: core.resolved, integrity: core.integrity },
    packages: Object.fromEntries(Object.entries(packageRoots).map(([label, root]) => {
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      return [label, { name: manifest.name, version: manifest.version }];
    })),
    typecheck: "tsc --strict --skipLibCheck=false (packed declarations, no @dal-go/dalgo)",
    runtime,
    legacyReferences: 0,
  };
  if (process.env.DALGO_PACKED_CONSUMER_RECEIPT !== undefined) {
    mkdirSync(dirname(process.env.DALGO_PACKED_CONSUMER_RECEIPT), { recursive: true });
    writeFileSync(process.env.DALGO_PACKED_CONSUMER_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  if (process.env.KEEP_PACKED_CONSUMER === "1") {
    console.log(JSON.stringify(receipt, null, 2));
    console.log(`Packed consumer kept at ${scratch}`);
  } else {
    rmSync(scratch, { recursive: true, force: true });
    console.log(JSON.stringify({ ...receipt, scratch: "removed after success" }, null, 2));
  }
} catch (error) {
  if (existsSync(join(repository, ".changeset", "clickhouse-ordinal-contract.md")) && process.env.KEEP_PACKED_CONSUMER !== "1") {
    rmSync(scratch, { recursive: true, force: true });
    console.error("Packed release preview failed; temporary workspace removed");
  } else {
    console.error(`Packed consumer failed; kept at ${scratch}`);
  }
  throw error;
} finally {
  try {
    assert.deepEqual(sourceHashes(), inputHashes, "pack/Changesets preview changed tracked or untracked source inputs");
  } finally {
    rmSync(join(scratch, "release-preview"), { recursive: true, force: true });
  }
}
