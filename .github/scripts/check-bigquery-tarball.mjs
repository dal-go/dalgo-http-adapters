// Run with Node 24. The destination must be a fresh external directory.
// Usage: node check-bigquery-tarball.mjs <tarball> <external-directory> <node-runtime>...
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const coreVersion = process.env.BIGQUERY_CORE_VERSION ?? "0.1.0";
const coreIntegrity = { "0.1.0": "sha512-mhEm1UrpPRHsJ+WbZ95cOxeZzpUioXxmmEa+FsI+FlVs0zFWKMqB/Sj/UkmQ7RSptbSM8OTFnXbQnowo5eTxCw==", "0.6.0": "sha512-C/hoawh4YU5Htm9PnrQi7Z9gP9rsy2PZ3Aj9RU3sV+76mEPHQ2rKWGkBjaxSoHB4PZn4DLpAzqQ+OoMKfzZ8BQ==" }[coreVersion];
if (!coreIntegrity) throw new Error("unsupported core compatibility target");
const [tarballArg, destinationArg, ...runtimes] = process.argv.slice(2);
if (!tarballArg || !destinationArg || !runtimes.length) throw new Error("tarball, external directory and runtime paths are required");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tarball = resolve(tarballArg), destination = resolve(destinationArg);
const artifactBytes = readFileSync(tarball);
const artifactSHA256 = createHash("sha256").update(artifactBytes).digest("hex");
const artifactIntegrity = `sha512-${createHash("sha512").update(artifactBytes).digest("base64")}`;
if (process.env.EXPECTED_ARTIFACT_SHA256 && process.env.EXPECTED_ARTIFACT_SHA256 !== artifactSHA256) throw new Error("unexpected artifact SHA256");
if (process.env.EXPECTED_ARTIFACT_INTEGRITY && process.env.EXPECTED_ARTIFACT_INTEGRITY !== artifactIntegrity) throw new Error("unexpected artifact integrity");
const destinationRelative = relative(repository, destination);
if (!destinationRelative.startsWith(`..${sep}`) && !isAbsolute(destinationRelative)) throw new Error("consumer must be outside the repository");
if (existsSync(destination)) throw new Error("consumer directory must be fresh");
const run = (command, args, extraEnv = {}) => execFileSync(command, args, {
  cwd: destination, stdio: "inherit", env: { ...process.env, ...extraEnv },
});
mkdirSync(destination, { recursive: true });
writeFileSync(resolve(destination, "package.json"), JSON.stringify({ name: "bigquery-packed-consumer", private: true, type: "module" }));
// Vitest 2 runs on the declared Node 20.0.0 floor. It is a test tool only;
// package code and declarations come exclusively from the supplied tarball.
run("npm", ["install", "--strict-peer-deps", "--legacy-peer-deps=false", "--force=false", "--ignore-scripts", "--registry=https://registry.npmjs.org", "--save-exact", tarball, `@dalgo/core@${coreVersion}`, "typescript@6.0.3", "vitest@2.1.9"]);
const lock = JSON.parse(readFileSync(resolve(destination, "package-lock.json"), "utf8"));
const core = lock.packages["node_modules/@dalgo/core"];
if (core?.version !== coreVersion || core.resolved !== `https://registry.npmjs.org/@dalgo/core/-/core-${coreVersion}.tgz` || core.integrity !== coreIntegrity) throw new Error("registry core baseline required");
if (Object.keys(lock.packages).filter(p => p.endsWith("node_modules/@dalgo/core")).length !== 1 || lock.packages["node_modules/@dal-go/dalgo"]) throw new Error("exactly one canonical core required");
const installedPackage = resolve(destination, "node_modules/@dalgo/bigquery");
const manifest = JSON.parse(readFileSync(resolve(installedPackage, "package.json"), "utf8"));
if (manifest.name !== "@dalgo/bigquery" || manifest.private || manifest.peerDependencies?.["@dalgo/core"] !== "^0.1.0 || ^0.6.0" || manifest.peerDependencies?.["@dal-go/dalgo"]) throw new Error("unexpected package contract");
if (lock.packages["node_modules/@dalgo/bigquery"]?.integrity !== artifactIntegrity) throw new Error("installed artifact integrity mismatch");
if (process.env.EXPECTED_PACKAGE_VERSION && manifest.version !== process.env.EXPECTED_PACKAGE_VERSION) throw new Error("unexpected package version");
if (process.env.EXPECTED_SOURCE_SHA && manifest.gitHead !== process.env.EXPECTED_SOURCE_SHA) throw new Error("unexpected package gitHead");
for (const entry of [".", "./analytical"]) {
  for (const kind of ["import", "types"]) {
    const path = manifest.exports?.[entry]?.[kind];
    if (typeof path !== "string" || !path.startsWith("./dist/") || !existsSync(resolve(installedPackage, path))) throw new Error(`missing ${entry} ${kind}`);
  }
}
for (const name of ["README.md", "LICENSE"]) if (!existsSync(resolve(installedPackage, name))) throw new Error(`missing ${name}`);
const pkg = resolve(repository, "packages/bigquery");
cpSync(resolve(pkg, "testdata"), resolve(destination, "testdata"), { recursive: true });
mkdirSync(resolve(destination, "test"));
for (const name of ["database.test.ts", "sql.test.ts", "analytical-contract.test.ts", "contract-http.ts", "contract-parity.ts", "metadata-client.test.ts", "metadata-harness.test.ts", "analytical-request.test.ts"]) {
  let source = readFileSync(resolve(pkg, "test", name), "utf8")
    .replaceAll('"../src/index.js"', '"@dalgo/bigquery"')
    .replaceAll('"../src/analytical.js"', '"@dalgo/bigquery/analytical"');
  if (name === "analytical-request.test.ts") {
    // Exercise the same TIMESTAMP cases through the public request serializer.
    source = source.replace('import { wireParameters } from "../src/analytical/protocol.js";',
      'const wireParameters = (parameters: unknown[]) => (queryRequest({ parameters } as never, execution, bounds(), source.location, true) as { queryParameters: unknown }).queryParameters;');
  }
  if (source.includes("../src/")) throw new Error(`source-path import in ${name}`);
  writeFileSync(resolve(destination, "test", name), source);
}
const fixtures = resolve(repository, ".github/fixtures/bigquery-consumer");
cpSync(resolve(fixtures, "core-identity.test.ts"), resolve(destination, "test/core-identity.test.ts"));
cpSync(resolve(fixtures, "consumer.ts"), resolve(destination, "consumer.ts"));
writeFileSync(resolve(destination, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmit: true }, include: ["consumer.ts"] }));
run("npm", ["ls", "@dalgo/core", "@dalgo/bigquery", "--all"]);
for (const [index, runtime] of runtimes.entries()) {
  run(resolve(runtime), ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
  run(resolve(runtime), ["node_modules/vitest/vitest.mjs", "run", "--pool=forks", "--maxWorkers=1", "--minWorkers=1"], {
    BIGQUERY_PARITY_REPORT: resolve(destination, `parity-${index}.json`),
    BIGQUERY_CONTRACT_REPORT: resolve(destination, `http-${index}.json`),
  });
}
const bytes = readFileSync(tarball);
if (createHash("sha256").update(bytes).digest("hex") !== artifactSHA256) throw new Error("artifact changed during verification");
writeFileSync(resolve(destination, "artifact-receipt.json"), JSON.stringify({ tarball, sha256: artifactSHA256, integrity: artifactIntegrity, sourceSHA: manifest.gitHead, package: { name: manifest.name, version: manifest.version, gitHead: manifest.gitHead }, core, runtimes: runtimes.map(runtime => ({ typedImports: true, path: resolve(runtime), version: execFileSync(resolve(runtime), ["--version"], { encoding: "utf8" }).trim() })) }, null, 2) + "\n");
