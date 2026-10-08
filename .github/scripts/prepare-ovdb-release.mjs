// Node 24 release artifact gate. Pack once, then verify the same immutable bytes.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const [mode, directoryArg, sourceSHA, version, consumerReceiptArg] = process.argv.slice(2);
if (!["pack", "verify"].includes(mode) || !directoryArg || !/^[0-9a-f]{40}$/.test(sourceSHA ?? "") || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) throw new Error("mode, artifact directory, exact source SHA and version required");
const directory = resolve(directoryArg);
const receiptPath = resolve(directory, "packed-artifact.json");
const identity = { name: "@dalgo/ovdb", version, gitHead: sourceSHA };
const digest = bytes => ({ sha256: createHash("sha256").update(bytes).digest("hex"), integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` });
const readJSON = path => JSON.parse(readFileSync(path, "utf8"));
const failUnless = (condition, message) => { if (!condition) throw new Error(message); };
const inspect = tarball => {
  const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
  failUnless(files.every(file => /^package\/(dist-dtql\/[^\s]+|package\.json|README\.md|LICENSE)$/.test(file) && !file.split("/").includes("..")), "unexpected tarball file");
  const contents = file => execFileSync("tar", ["-xOzf", tarball, `package/${file}`], { encoding: "utf8" });
  const manifest = JSON.parse(contents("package.json"));
  failUnless(Object.entries(identity).every(([key, value]) => manifest[key] === value), "wrong packed package/version/gitHead");
  failUnless(manifest.publishConfig?.access === "public" && manifest.publishConfig?.registry === "https://registry.npmjs.org", "public registry access required");
  failUnless(!manifest.private && manifest.peerDependencies?.["@dalgo/core"] === ">=0.6.0 <0.7.0" && !manifest.peerDependencies?.["@dal-go/dalgo"], "wrong packed core peer");
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    failUnless(Object.entries(manifest[section] ?? {}).every(([name, value]) => name !== "@dal-go/dalgo" && !/^(file:|link:|workspace:|git[+:]|github:|https?:)/.test(value)), "repository-only or legacy dependency");
  }
  for (const entry of [".", "./dtql"]) for (const kind of ["import", "types"]) {
    failUnless(Object.keys(manifest.exports ?? {}).length === 2, "unexpected export entry");
    failUnless(Object.keys(manifest.exports?.[entry] ?? {}).length === 2, "unexpected export condition");
    const path = manifest.exports?.[entry]?.[kind];
    failUnless(path === (kind === "import" ? "./dist-dtql/index.js" : "./dist-dtql/index.d.ts"), "wrong query-only entrypoint");
    failUnless(typeof path === "string" && path.startsWith("./dist-dtql/") && files.includes(`package/${path.slice(2)}`), `missing ${entry} ${kind}`);
  }
  failUnless(files.includes("package/README.md") && files.includes("package/LICENSE"), "missing README/LICENSE");
  for (const file of files.filter(file => /\.(js|ts|map)$/.test(file))) failUnless(!/(?:OpenVaultDbClient|OpenVaultDbDatabase|bearer|getAccessToken|\.\.\/client|\.\.\/database|@dal-go\/dalgo)/i.test(contents(file.slice(8))), "legacy code in packed output");
  return { manifest, files };
};

if (mode === "pack") {
  failUnless(!existsSync(directory), "artifact directory must be fresh; refusing a second pack");
  mkdirSync(directory, { recursive: true });
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/ovdb");
  const staging = resolve(directory, "staging");
  mkdirSync(staging);
  for (const file of ["dist-dtql", "README.md", "LICENSE"]) cpSync(resolve(pkg, file), resolve(staging, file), { recursive: true });
  const manifest = readJSON(resolve(pkg, "package.json"));
  failUnless(manifest.name === identity.name && manifest.version === version, "source package identity mismatch");
  // npm tarball publication reads gitHead from the packed manifest. Explicitly
  // bind it to the authorized checkout without editing its tracked manifest.
  writeFileSync(resolve(staging, "package.json"), JSON.stringify({ ...manifest, gitHead: sourceSHA }, null, 2) + "\n");
  const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: staging, encoding: "utf8" });
  writeFileSync(resolve(directory, "npm-pack.json"), output);
  const packs = JSON.parse(output);
  failUnless(packs.length === 1 && packs[0].filename === `dalgo-ovdb-${version}.tgz`, "unexpected npm pack result");
  const tarball = resolve(directory, packs[0].filename);
  const hashes = digest(readFileSync(tarball));
  failUnless(packs[0].integrity === hashes.integrity, "npm pack integrity mismatch");
  const { files } = inspect(tarball);
  writeFileSync(receiptPath, JSON.stringify({ tarball, ...hashes, sourceSHA, package: identity, files }, null, 2) + "\n");
  rmSync(staging, { recursive: true });
} else {
  failUnless(!!consumerReceiptArg, "consumer receipt required");
  const receipt = readJSON(receiptPath), consumer = readJSON(resolve(consumerReceiptArg));
  failUnless(receipt.tarball === resolve(directory, `dalgo-ovdb-${version}.tgz`) && receipt.sourceSHA === sourceSHA && Object.entries(identity).every(([key, value]) => receipt.package?.[key] === value), "wrong artifact receipt identity");
  const hashes = digest(readFileSync(receipt.tarball));
  failUnless(hashes.sha256 === receipt.sha256 && hashes.integrity === receipt.integrity && consumer.tarball === receipt.tarball && consumer.sha256 === hashes.sha256 && consumer.integrity === hashes.integrity, "tested artifact bytes mismatch");
  failUnless(consumer.sourceSHA === sourceSHA && Object.entries(identity).every(([key, value]) => consumer.package?.[key] === value), "wrong tested package/version/gitHead");
  failUnless(consumer.core?.version === "0.6.0" && consumer.core.resolved === "https://registry.npmjs.org/@dalgo/core/-/core-0.6.0.tgz" && consumer.core.integrity === "sha512-C/hoawh4YU5Htm9PnrQi7Z9gP9rsy2PZ3Aj9RU3sV+76mEPHQ2rKWGkBjaxSoHB4PZn4DLpAzqQ+OoMKfzZ8BQ==", "wrong tested registry core");
  failUnless(consumer.browser?.synthetic === true && consumer.browser.providerRequests === 0 && consumer.browser.blockedExternalRequests?.length === 0 && consumer.browser.core === "registry:0.6.0" && consumer.browser.defaultNativeFetch === true && consumer.browser.nativeDefaultPosts === 2 && consumer.browser.nativeDefaultRows === 2, "native synthetic registry consumer receipt required");
  failUnless(Array.isArray(consumer.runtimes) && consumer.runtimes.length === 2, "Node 20 and Node 24 runtime receipts required");
  for (const [index, major] of [20, 24].entries()) {
    const proof = consumer.runtimes[index];
    failUnless(typeof proof?.nodeVersion === "string" && (major === 20 ? proof.nodeVersion === "v20.0.0" : /^v24\./.test(proof.nodeVersion)), `wrong Node ${major} runtime`);
    failUnless(proof.synthetic === true && proof.typedImports === true && proof.nativeRows === 1 && proof.preIORefusal === true && proof.providerRequests === 0 && proof.core === "registry:0.6.0", "strict typed/public synthetic runtime proof required");
    failUnless(proof.sourceSHA === sourceSHA && proof.sha256 === hashes.sha256 && proof.integrity === hashes.integrity && Object.entries(identity).every(([key, value]) => proof.package?.[key] === value), "runtime artifact identity mismatch");
  }
  inspect(receipt.tarball);
}
