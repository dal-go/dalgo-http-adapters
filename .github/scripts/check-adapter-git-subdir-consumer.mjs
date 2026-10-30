// Node 24. Installs the three browser adapters as pnpm Git subdirectory
// dependencies in a throwaway consumer outside this repository, exactly as the
// DataTug web UI does, then type-checks and dynamically imports them.
//
// A Git subdirectory install fetches one workspace copy per dependency and runs
// that copy's `prepack` scripts. Nothing outside the copy is built, so each
// consumer package must build its workspace dependencies itself. This gate
// proves that ordering; a prebuilt tarball install cannot.
//
// Default source is a temporary local Git repository made from the current
// working tree (tracked and untracked-but-not-ignored files, never `dist`).
// Set DALGO_ADAPTER_GIT_SUBDIR_REF=github:dal-go/dalgo-http-adapters#<sha> to
// run the identical assertions against a pushed commit without changing
// anything else.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_VERSION = "0.8.1";
const CORE_SPEC = CORE_VERSION;
const CORE_INTEGRITY = "sha512-stXi8PPeR3G7AxCairfJEMDGd4KuiU5eyipPDgibCEVlRD435t2FvfQQj3mp+FgZEVzcdel4Z4Iwq3xm9URRSA==";
const TYPESCRIPT_VERSION = "6.0.3";
const ADAPTERS = [
  { name: "@dalgo/adapter-runtime", directory: "packages/adapter-runtime" },
  { name: "@dal-go/dalgo2couchdb", directory: "packages/couchdb" },
  { name: "@dal-go/dalgo2libsql", directory: "packages/libsql" },
  { name: "@dal-go/dalgo2postgrest", directory: "packages/postgrest" },
  { name: "@dal-go/dalgo2typesense", directory: "packages/typesense" },
];
const legacySpecifier = /@dal-go\/dalgo(?![\w-])/u;

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(join(tmpdir(), "dalgo-adapter-git-subdir-consumer-"));
const relativeScratch = relative(repository, scratch);
assert.ok(
  relativeScratch.startsWith(`..${sep}`) || isAbsolute(relativeScratch),
  "the Git-subdirectory consumer must live outside the repository",
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

// The candidate must be source-only: a committed or leaked `dist` would hide a
// missing prepack step. `--exclude-standard` drops ignored `dist`/`node_modules`.
function materializeCandidate() {
  const source = join(scratch, "candidate-source");
  mkdirSync(source, { recursive: true });
  const listed = run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean);
  for (const file of listed) {
    const target = join(source, file);
    mkdirSync(dirname(target), { recursive: true });
    const stats = lstatSync(join(repository, file));
    if (stats.isSymbolicLink()) symlinkSync(readlinkSync(join(repository, file)), target);
    else {
      copyFileSync(join(repository, file), target);
      chmodSync(target, stats.mode);
    }
  }
  for (const adapter of ADAPTERS) {
    assert.ok(
      !existsSync(join(source, adapter.directory, "dist")),
      `${adapter.directory}/dist must not exist in the gated candidate source`,
    );
  }
  const identity = ["-c", "user.name=adapter-git-subdir-gate", "-c", "user.email=gate@invalid"];
  run("git", ["init", "-q", "-b", "main"], { cwd: source });
  run("git", [...identity, "add", "-A"], { cwd: source });
  run("git", [...identity, "commit", "-q", "-m", "gated candidate"], { cwd: source });
  const sha = run("git", ["rev-parse", "HEAD"], { cwd: source }).trim();
  assert.match(sha, /^[0-9a-f]{40}$/u);
  return { url: `git+file://${source}`, sha, kind: "local-git-repository" };
}

function remoteReference(spec) {
  const match = /^github:([\w.-]+\/[\w.-]+)#([0-9a-f]{40})$/u.exec(spec);
  assert.ok(match, "DALGO_ADAPTER_GIT_SUBDIR_REF must be github:<owner>/<repo>#<40-hex sha>");
  const [, ownerRepo, sha] = match;
  return {
    url: `github:${ownerRepo}`,
    sha,
    ownerRepo,
    kind: "pushed-git-commit",
  };
}

function adapterSpec(reference, adapter) {
  return `${reference.url}#${reference.sha}&path:/${adapter.directory}`;
}

function adapterAllowBuild(reference, adapter) {
  if (reference.kind === "local-git-repository") {
    // pnpm reports this exact key when a local Git dependency is not approved.
    return `${adapter.name}@${adapterSpec(reference, adapter)}`;
  }
  const tarball = `https://codeload.github.com/${reference.ownerRepo}/tar.gz/${reference.sha}`;
  return `${adapter.name}@${tarball}#path:/${adapter.directory}`;
}

function coreIdentityOf(packageRoot) {
  // pnpm links peer-resolved dependencies next to the package inside the
  // virtual store (`.../.pnpm/<id>/node_modules/@dalgo/core`), which is what the
  // adapter's ESM imports resolve to from its own location.
  const storeModules = dirname(dirname(packageRoot));
  const packageDir = realpathSync(join(storeModules, "@dalgo", "core"));
  const entry = realpathSync(join(packageDir, "dist", "index.js"));
  return { packageDir, entry };
}

try {
  const consumer = join(scratch, "consumer");
  mkdirSync(join(consumer, "src"), { recursive: true });

  const override = process.env.DALGO_ADAPTER_GIT_SUBDIR_REF?.trim();
  const reference = override ? remoteReference(override) : materializeCandidate();

  const specs = Object.fromEntries(ADAPTERS.map((adapter) => [adapter.name, adapterSpec(reference, adapter)]));
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({
      name: "dalgo-adapter-git-subdir-consumer",
      private: true,
      type: "module",
      dependencies: { "@dalgo/core": CORE_SPEC, ...specs },
      devDependencies: { typescript: TYPESCRIPT_VERSION },
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    [
      "# Exact build approvals for the reviewed dependencies only.",
      "allowBuilds:",
      ...ADAPTERS.map((adapter) => `  '${adapterAllowBuild(reference, adapter)}': true`),
      "",
      "minimumReleaseAgeExclude:",
      `  - '@dalgo/core@${CORE_VERSION}'`,
      "",
    ].join("\n"),
  );
  copyFileSync(
    join(repository, ".github", "scripts", "adapter-packed-consumer.ts"),
    join(consumer, "src", "consumer.ts"),
  );
  copyFileSync(
    join(repository, ".github", "scripts", "adapter-git-subdir-consumer-runtime.mjs"),
    join(consumer, "runtime.mjs"),
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

  const pnpmVersion = run("pnpm", ["--version"]).trim();
  // No local tarball, no `file:`/`link:` specifier, no `--ignore-scripts`, no
  // blanket build approval: the Git fetch must run the reviewed prepack steps.
  run("pnpm", ["install", "--no-frozen-lockfile", "--registry=https://registry.npmjs.org"], { cwd: consumer });

  const lockfile = readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8");
  assert.ok(!/^\s*(?:specifier|version):\s*(?:link|file):/mu.test(lockfile), "consumer lockfile uses a local link");
  assert.ok(!lockfile.includes(repository), "consumer lockfile points at this repository checkout");
  // pnpm 11 repeats each resolution key under `packages:` and `snapshots:`.
  const lockKeys = [...new Set(lockfile
    .split("\n")
    .map((line) => /^ {2}'(.+)':$/u.exec(line)?.[1])
    .filter(Boolean))];
  const coreKeys = lockKeys.filter((key) => key.startsWith("@dalgo/core@"));
  assert.equal(coreKeys.length, 1, `locked @dalgo/core resolutions: ${coreKeys.join(", ")}`);
  assert.equal(coreKeys[0], `@dalgo/core@${CORE_VERSION}`);
  const corePackageBlock = lockfile.split("\n\n").find((block) =>
    block.startsWith(`  '${coreKeys[0]}':\n`) && block.includes("    resolution: "));
  assert.ok(corePackageBlock, "@dalgo/core registry resolution is missing");
  assert.equal(
    corePackageBlock.split("\n").find((line) => line.startsWith("    resolution: ")),
    `    resolution: {integrity: ${CORE_INTEGRITY}}`,
    "@dalgo/core must use the exact verified registry artifact",
  );
  for (const adapter of ADAPTERS) {
    const locked = lockKeys.filter((key) => key.startsWith(`${adapter.name}@`)
      && key.includes(reference.sha)
      && key.includes(`path:/${adapter.directory}`)
      && (reference.kind === "pushed-git-commit" || key.includes("git+file://")));
    assert.ok(locked.length > 0, `${adapter.name} is not locked to ${reference.url}#${reference.sha}&path:/${adapter.directory}`);
  }
  // Every core occurrence, including the peer suffixes on adapter resolutions,
  // must name the one released version.
  const lockedCores = new Set(lockKeys.flatMap((key) => [...key.matchAll(/@dalgo\/core@([^@()]+)/gu)].map((match) => match[1])));
  assert.deepEqual([...lockedCores], [CORE_VERSION]);
  assert.ok(
    !lockKeys.some((key) => key.startsWith("@dal-go/dalgo@")),
    "consumer lockfile resolves the legacy @dal-go/dalgo package",
  );

  const installed = {};
  for (const adapter of ADAPTERS) {
    const installedRoot = realpathSync(join(consumer, "node_modules", ...adapter.name.split("/")));
    assert.ok(
      installedRoot.includes(`${sep}node_modules${sep}.pnpm${sep}`),
      `${adapter.name} was not installed from the Git fetch (at ${installedRoot})`,
    );
    for (const file of ["dist/index.js", "dist/index.d.ts"]) {
      const path = join(installedRoot, file);
      assert.ok(existsSync(path), `${adapter.name} is missing ${file}; its prepack step did not build it`);
      assert.ok(readFileSync(path, "utf8").length > 0, `${adapter.name} ${file} is empty`);
    }
    const manifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
    assert.equal(manifest.name, adapter.name);
    // pnpm keeps the fetched source manifest, including devDependencies. Those
    // are not installed for a consumer, so only runtime sections must be free of
    // workspace/file protocols.
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        assert.ok(!String(range).startsWith("workspace:"), `${adapter.name} keeps a ${section} workspace link to ${name}`);
        assert.ok(!String(range).startsWith("file:"), `${adapter.name} keeps a ${section} file link to ${name}`);
      }
    }
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      assert.ok(
        !Object.hasOwn(manifest[section] ?? {}, "@dal-go/dalgo"),
        `${adapter.name} depends on the legacy @dal-go/dalgo package in ${section}`,
      );
    }
    assert.equal(manifest.peerDependencies?.["@dalgo/core"], ">=0.7.4 <0.9.0");
    if (adapter.directory !== "packages/adapter-runtime") {
      assert.equal(manifest.peerDependencies?.["@dalgo/adapter-runtime"], ">=0.1.0 <1.0.0");
    }
    for (const file of walk(installedRoot)) {
      if (!/\.(?:js|mjs|d\.ts|json|map)$/u.test(file)) continue;
      assert.ok(!legacySpecifier.test(readFileSync(file, "utf8")), `${file} references @dal-go/dalgo`);
    }
    installed[adapter.name] = {
      version: manifest.version,
      gitFetched: true,
    };
  }

  // One @dalgo/core identity: whatever each adapter resolves must be the exact
  // module instance the consumer resolves.
  const coreRoot = join(consumer, "node_modules", "@dalgo", "core");
  const coreEntry = realpathSync(join(coreRoot, "dist", "index.js"));
  const identityDirs = new Set([realpathSync(coreRoot)]);
  const identityEntries = new Set([coreEntry]);
  for (const adapter of ADAPTERS) {
    const packageRoot = realpathSync(join(consumer, "node_modules", ...adapter.name.split("/")));
    const identity = coreIdentityOf(packageRoot);
    identityDirs.add(identity.packageDir);
    identityEntries.add(identity.entry);
  }
  assert.equal(identityDirs.size, 1, `@dalgo/core packages: ${[...identityDirs].join(", ")}`);
  assert.equal(identityEntries.size, 1, `@dalgo/core modules: ${[...identityEntries].join(", ")}`);
  const coreStoreDirectories = readdirSync(join(consumer, "node_modules", ".pnpm"))
    .filter((name) => name.startsWith("@dalgo+core@"));
  assert.equal(coreStoreDirectories.length, 1, `installed @dalgo/core copies: ${coreStoreDirectories.join(", ")}`);
  assert.equal(coreStoreDirectories[0], `@dalgo+core@${CORE_VERSION}`);
  const coreManifest = JSON.parse(readFileSync(join(consumer, "node_modules", "@dalgo", "core", "package.json"), "utf8"));
  assert.equal(coreManifest.name, "@dalgo/core");
  assert.equal(coreManifest.version, CORE_VERSION);

  assert.ok(
    !existsSync(join(consumer, "node_modules", "@dal-go", "dalgo")),
    "consumer node_modules contains @dal-go/dalgo",
  );

  run(join(consumer, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: consumer });
  const runtime = JSON.parse(run(process.execPath, ["runtime.mjs"], { cwd: consumer }).trim());
  assert.deepEqual(runtime, {
    core: { collection: "function", key: "function" },
    runtime: { isCancellableQueryExecutor: "function" },
    couch: { queryWithSignal: "function", runReadwriteTransaction: "function" },
    postgrest: {
      queryWithSignal: "function",
      discover: "function",
      testConnection: "function",
      runReadwriteTransaction: "function",
    },
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

  const receipt = {
    source: { kind: reference.kind, sha: reference.sha, ...(reference.url.startsWith("git+file:") ? { url: reference.url } : {}) },
    pnpm: pnpmVersion,
    core: { name: coreManifest.name, version: coreManifest.version, specifier: CORE_SPEC, integrity: CORE_INTEGRITY },
    adapters: installed,
    allowBuilds: ADAPTERS.map((adapter) => adapterAllowBuild(reference, adapter)),
    prepack: "Git-fetched workspace; no prebuilt dist, no tarball, no local link",
    typecheck: `tsc ${TYPESCRIPT_VERSION} --strict --skipLibCheck=false (Git-installed declarations)`,
    runtimeImports: runtime,
    coreIdentities: 1,
    legacyReferences: 0,
  };
  if (process.env.DALGO_GIT_SUBDIR_RECEIPT) {
    const receiptPath = resolve(process.env.DALGO_GIT_SUBDIR_RECEIPT);
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  if (process.env.KEEP_GIT_SUBDIR_CONSUMER === "1") {
    console.log(JSON.stringify(receipt, null, 2));
    console.log(`Git-subdirectory consumer kept at ${scratch}`);
  } else {
    rmSync(scratch, { recursive: true, force: true });
    console.log(JSON.stringify({ ...receipt, scratch: "removed after success" }, null, 2));
  }
} catch (error) {
  console.error(`Git-subdirectory consumer failed; kept at ${scratch}`);
  throw error;
}
