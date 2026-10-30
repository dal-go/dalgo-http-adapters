// Node 24. Packs the browser adapters, installs only those tarballs plus the
// exact released @dalgo/core version in a fresh directory outside this repository,
// and type-checks/runs a consumer that never has @dal-go/dalgo available.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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

try {
  const tarballs = join(scratch, "tarballs");
  const consumer = join(scratch, "consumer");
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(join(consumer, "src"), { recursive: true });

  run("pnpm", [
    "--filter", "@dalgo/adapter-runtime",
    "--filter", "@dal-go/dalgo2couchdb",
    "--filter", "@dal-go/dalgo2libsql",
    "--filter", "@dal-go/dalgo2postgrest",
    "--filter", "@dal-go/dalgo2typesense",
    "pack",
    "--pack-destination", tarballs,
  ]);

  const packFiles = readdirSync(tarballs).filter((name) => name.endsWith(".tgz")).sort();
  assert.equal(packFiles.length, 5, "expected exactly five packed adapter tarballs");
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
    tarball("dal-go-dalgo2couchdb-"),
    tarball("dal-go-dalgo2libsql-"),
    tarball("dal-go-dalgo2postgrest-"),
    tarball("dal-go-dalgo2typesense-"),
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
    postgrest: join(consumer, "node_modules", "@dal-go", "dalgo2postgrest"),
    couch: join(consumer, "node_modules", "@dal-go", "dalgo2couchdb"),
    libsql: join(consumer, "node_modules", "@dal-go", "dalgo2libsql"),
    typesense: join(consumer, "node_modules", "@dal-go", "dalgo2typesense"),
    runtime: join(consumer, "node_modules", "@dalgo", "adapter-runtime"),
  };
  for (const [label, root] of Object.entries(packageRoots)) {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assertNoLegacyDependency(manifest, label);
    assert.deepEqual(manifest.exports["."], { types: "./dist/index.d.ts", import: "./dist/index.js" });
    for (const file of walk(root)) {
      if (!/\.(?:js|mjs|d\.ts|json|map)$/u.test(file)) continue;
      const contents = readFileSync(file, "utf8");
      assert.ok(!legacySpecifier.test(contents), `${file} references @dal-go/dalgo`);
    }
  }

  const postDeclaration = readFileSync(join(packageRoots.postgrest, "dist", "database.d.ts"), "utf8");
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
    "@dal-go/dalgo2couchdb",
    "@dal-go/dalgo2libsql",
    "@dal-go/dalgo2postgrest",
    "@dal-go/dalgo2typesense",
  ], { cwd: consumer }));
  assertNoLegacyTree(tree, "installed npm");

  const receipt = {
    scratch,
    core: { name: coreManifest.name, version: coreManifest.version, resolved: core.resolved, integrity: core.integrity },
    packages: Object.fromEntries(Object.entries(packageRoots).map(([label, root]) => {
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      return [label, { name: manifest.name, version: manifest.version }];
    })),
    typecheck: "tsc --strict --skipLibCheck=false (packed declarations, no @dal-go/dalgo)",
    runtime,
    legacyReferences: 0,
  };
  if (process.env.KEEP_PACKED_CONSUMER === "1") {
    console.log(JSON.stringify(receipt, null, 2));
    console.log(`Packed consumer kept at ${scratch}`);
  } else {
    rmSync(scratch, { recursive: true, force: true });
    console.log(JSON.stringify({ ...receipt, scratch: "removed after success" }, null, 2));
  }
} catch (error) {
  console.error(`Packed consumer failed; kept at ${scratch}`);
  throw error;
}
