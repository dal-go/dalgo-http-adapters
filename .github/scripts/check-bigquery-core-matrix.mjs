// Preserve core0.1 and prove one strict core0.6 shared by three packed adapters.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const [tarballArg, destinationArg, node20, node24] = process.argv.slice(2);
assert.ok(tarballArg && destinationArg && node20 && node24, 'artifact, fresh consumer directory, Node20/24 required');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), destination = resolve(destinationArg), tarball = resolve(tarballArg);
const rel = relative(repository, destination); assert.ok(rel.startsWith(`..${sep}`) || isAbsolute(rel)); assert.ok(!existsSync(destination));
mkdirSync(destination, { recursive: true });
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const run = (command, args, cwd, env = {}) => execFileSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const consumers = ['0.1.0', '0.6.0'].map(core => {
  const path = resolve(destination, `core-${core}`);
  process.stdout.write(run(process.execPath, [resolve(repository, '.github/scripts/check-bigquery-tarball.mjs'), tarball, path, node20, node24], repository, { BIGQUERY_CORE_VERSION: core }));
  return { path, receipt: json(resolve(path, 'artifact-receipt.json')) };
});
const [baseline, modern] = consumers;
const candidates = ['http', 'ovdb'].map(name => {
  const manifest = json(resolve(repository, `packages/${name}/package.json`));
  const artifact = resolve(destination, `${name}-artifact`);
  process.stdout.write(run(process.execPath, [resolve(repository, `.github/scripts/prepare-${name}-release.mjs`), 'pack', artifact, baseline.receipt.sourceSHA, manifest.version], repository));
  return json(resolve(artifact, 'packed-artifact.json'));
});
process.stdout.write(run('npm', ['install', '--strict-peer-deps', '--legacy-peer-deps=false', '--force=false', '--ignore-scripts', '--registry=https://registry.npmjs.org', '--save-exact', ...candidates.map(c => c.tarball), 'playwright@1.58.2', 'esbuild@0.25.12'], modern.path));
const lock = json(resolve(modern.path, 'package-lock.json'));
assert.equal(Object.keys(lock.packages).filter(p => p.endsWith('node_modules/@dalgo/core')).length, 1);
assert.equal(lock.packages['node_modules/@dalgo/core'].version, '0.6.0');
assert.equal(lock.packages['node_modules/@dalgo/bigquery'].integrity, baseline.receipt.integrity);
for (const candidate of candidates) {
  const name = candidate.package.name; assert.equal(lock.packages[`node_modules/${name}`].integrity, candidate.integrity);
  assert.deepEqual(json(resolve(modern.path, `node_modules/${name}/package.json`)).gitHead, baseline.receipt.sourceSHA);
}
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path || ['node_modules/@dalgo/bigquery', 'node_modules/@dalgo/http', 'node_modules/@dalgo/ovdb'].includes(path)) continue;
  assert.ok(!pkg.link && pkg.resolved?.startsWith('https://registry.npmjs.org/'), `nonregistry dependency: ${path}`);
}
const test = resolve(modern.path, 'test');
cpSync(resolve(repository, '.github/fixtures/bigquery-combined/browser.ts'), resolve(test, 'browser.ts'));
cpSync(resolve(repository, 'packages/http/test/browser-fixture.ts'), resolve(test, 'http-fixture.ts'));
writeFileSync(resolve(test, 'dtql-fixture.ts'), readFileSync(resolve(repository, 'packages/ovdb/test/dtql-fixture.ts'), 'utf8').replace('../src/dtql/index.js', '@dalgo/ovdb/dtql'));
writeFileSync(resolve(modern.path, 'tsconfig.combined.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022', 'DOM'], strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmit: true }, include: ['test/browser.ts'] }));
for (const runtime of [node20, node24]) process.stdout.write(run(runtime, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.combined.json'], modern.path));
cpSync(resolve(repository, '.github/scripts/bigquery-combined-browser.mjs'), resolve(modern.path, 'combined-browser.mjs'));
process.stdout.write(run('npm', ['ls', '@dalgo/core', '@dalgo/bigquery', '@dalgo/http', '@dalgo/ovdb', '--all'], modern.path));
process.stdout.write(run(process.execPath, ['node_modules/playwright/cli.js', 'install', 'chromium'], modern.path));
const browser = JSON.parse(run(process.execPath, ['combined-browser.mjs'], modern.path).trim());
assert.equal(browser.synthetic, true); assert.equal(browser.providerRequests, 0); assert.equal(browser.coreVersion, '0.6.0');
assert.equal(browser.blockedExternalRequests.length, 0);
const hash = createHash('sha256').update(readFileSync(tarball)).digest('hex'); assert.equal(hash, baseline.receipt.sha256);
const receipt = { ...baseline.receipt, coreMatrix: consumers.map(c => ({ core: c.receipt.core, runtimes: c.receipt.runtimes })), combinedBrowser: browser, combinedArtifacts: candidates };
writeFileSync(resolve(destination, 'artifact-receipt.json'), JSON.stringify(receipt, null, 2)+'\n');
