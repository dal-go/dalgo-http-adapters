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
const identity = { name: "@dalgo/bigquery", version, gitHead: sourceSHA };
const digest = bytes => ({ sha256: createHash("sha256").update(bytes).digest("hex"), integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` });
const readJSON = path => JSON.parse(readFileSync(path, "utf8"));
const failUnless = (condition, message) => { if (!condition) throw new Error(message); };
const inspect = tarball => {
  const files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
  failUnless(files.every(file => /^package\/(dist\/[^\s]+|package\.json|README\.md|LICENSE)$/.test(file) && !file.split("/").includes("..")), "unexpected tarball file");
  const contents = file => execFileSync("tar", ["-xOzf", tarball, `package/${file}`], { encoding: "utf8" });
  const manifest = JSON.parse(contents("package.json"));
  failUnless(Object.entries(identity).every(([key, value]) => manifest[key] === value), "wrong packed package/version/gitHead");
  failUnless(!manifest.private && manifest.peerDependencies?.["@dalgo/core"] === "^0.1.0 || ^0.6.0" && !manifest.peerDependencies?.["@dal-go/dalgo"], "wrong packed core peer");
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    failUnless(Object.entries(manifest[section] ?? {}).every(([name, value]) => name !== "@dal-go/dalgo" && !/^(file:|link:|workspace:|git[+:]|https?:)/.test(value)), "repository-only or legacy dependency");
  }
  for (const entry of [".", "./analytical"]) for (const kind of ["import", "types"]) {
    const path = manifest.exports?.[entry]?.[kind];
    failUnless(typeof path === "string" && path.startsWith("./dist/") && files.includes(`package/${path.slice(2)}`), `missing ${entry} ${kind}`);
  }
  failUnless(files.includes("package/README.md") && files.includes("package/LICENSE"), "missing README/LICENSE");
  for (const file of files.filter(file => /\.(js|ts)$/.test(file))) failUnless(!contents(file.slice(8)).includes("@dal-go/dalgo"), "legacy import in packed output");
  return { manifest, files };
};

if (mode === "pack") {
  failUnless(!existsSync(directory), "artifact directory must be fresh; refusing a second pack");
  mkdirSync(directory, { recursive: true });
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/bigquery");
  const staging = resolve(directory, "staging");
  mkdirSync(staging);
  for (const file of ["dist", "README.md", "LICENSE"]) cpSync(resolve(pkg, file), resolve(staging, file), { recursive: true });
  const manifest = readJSON(resolve(pkg, "package.json"));
  failUnless(manifest.name === identity.name && manifest.version === version, "source package identity mismatch");
  // npm tarball publication reads gitHead from the packed manifest. Explicitly
  // bind it to the authorized checkout without editing its tracked manifest.
  writeFileSync(resolve(staging, "package.json"), JSON.stringify({ ...manifest, gitHead: sourceSHA }, null, 2) + "\n");
  const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: staging, encoding: "utf8" });
  writeFileSync(resolve(directory, "npm-pack.json"), output);
  const packs = JSON.parse(output);
  failUnless(packs.length === 1 && packs[0].filename === `dalgo-bigquery-${version}.tgz`, "unexpected npm pack result");
  const tarball = resolve(directory, packs[0].filename);
  const hashes = digest(readFileSync(tarball));
  failUnless(packs[0].integrity === hashes.integrity, "npm pack integrity mismatch");
  const { files } = inspect(tarball);
  writeFileSync(receiptPath, JSON.stringify({ tarball, ...hashes, sourceSHA, package: identity, files }, null, 2) + "\n");
  rmSync(staging, { recursive: true });
} else {
  failUnless(!!consumerReceiptArg, "consumer receipt required");
  const receipt = readJSON(receiptPath), consumer = readJSON(resolve(consumerReceiptArg));
  failUnless(receipt.tarball === resolve(directory, `dalgo-bigquery-${version}.tgz`) && receipt.sourceSHA === sourceSHA && Object.entries(identity).every(([key, value]) => receipt.package?.[key] === value), "wrong artifact receipt identity");
  const hashes = digest(readFileSync(receipt.tarball));
  failUnless(hashes.sha256 === receipt.sha256 && hashes.integrity === receipt.integrity && consumer.tarball === receipt.tarball && consumer.sha256 === hashes.sha256 && consumer.integrity === hashes.integrity, "tested artifact bytes mismatch");
  failUnless(consumer.sourceSHA === sourceSHA && Object.entries(identity).every(([key, value]) => consumer.package?.[key] === value), "wrong tested package/version/gitHead");
  failUnless(consumer.core?.version === "0.1.0" && consumer.core.resolved === "https://registry.npmjs.org/@dalgo/core/-/core-0.1.0.tgz" && consumer.core.integrity === "sha512-mhEm1UrpPRHsJ+WbZ95cOxeZzpUioXxmmEa+FsI+FlVs0zFWKMqB/Sj/UkmQ7RSptbSM8OTFnXbQnowo5eTxCw==", "wrong tested registry core");
  failUnless(consumer.runtimes?.length === 2 && consumer.runtimes[0].version === "v20.0.0" && /^v24\./.test(consumer.runtimes[1].version), "Node 20.0.0 and 24 receipts required");
  const expectedCores = [
    ["0.1.0", "sha512-mhEm1UrpPRHsJ+WbZ95cOxeZzpUioXxmmEa+FsI+FlVs0zFWKMqB/Sj/UkmQ7RSptbSM8OTFnXbQnowo5eTxCw=="],
    ["0.6.0", "sha512-C/hoawh4YU5Htm9PnrQi7Z9gP9rsy2PZ3Aj9RU3sV+76mEPHQ2rKWGkBjaxSoHB4PZn4DLpAzqQ+OoMKfzZ8BQ=="],
  ];
  failUnless(consumer.coreMatrix?.length === 2, "both supported core receipts required");
  expectedCores.forEach(([coreVersion, integrity], index) => {
    const proof = consumer.coreMatrix[index];
    failUnless(proof.core?.version === coreVersion && proof.core.resolved === `https://registry.npmjs.org/@dalgo/core/-/core-${coreVersion}.tgz` && proof.core.integrity === integrity, "wrong core matrix identity");
    failUnless(proof.runtimes?.length === 2 && proof.runtimes[0].version === "v20.0.0" && /^v24\./.test(proof.runtimes[1].version) && proof.runtimes.every(runtime => runtime.typedImports === true), "typed Node20/24 matrix receipts required");
  });
  const browser = consumer.combinedBrowser;
  failUnless(browser?.synthetic === true && browser.coreVersion === "0.6.0" && browser.providerRequests === 0 && browser.blockedExternalRequests?.length === 0 && browser.sharedKeyIdentity === true && browser.bigqueryDefaultNativeFetch === true && browser.bigqueryExplicitNativeFetch === true && browser.bigqueryRows === 2 && browser.bigqueryPosts === 2 && browser.httpRows === 1 && browser.httpGets === 1 && browser.ovdbDefaultRows === 2 && browser.ovdbExplicitRows === 2 && browser.ovdbPosts?.default === 2 && browser.ovdbPosts.explicit === 2, "strict shared-core native browser receipt required");
  failUnless(consumer.combinedArtifacts?.length === 2 && consumer.combinedArtifacts.every((candidate, index) => candidate.package?.name === ["@dalgo/http", "@dalgo/ovdb"][index] && candidate.sourceSHA === sourceSHA && candidate.package.gitHead === sourceSHA && /^[0-9a-f]{64}$/.test(candidate.sha256) && candidate.integrity?.startsWith("sha512-")), "same-source combined package receipts required");
  inspect(receipt.tarball);
}
