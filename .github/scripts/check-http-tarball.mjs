// Node 24. Only the supplied tarball and registry packages enter this consumer.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const [tarballArg, destinationArg] = process.argv.slice(2);
assert.ok(tarballArg && destinationArg, 'tarball and fresh external directory required');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tarball = resolve(tarballArg), destination = resolve(destinationArg);
const rel = relative(repository, destination);
assert.ok(rel.startsWith(`..${sep}`) || isAbsolute(rel), 'consumer must be outside repository');
assert.ok(!existsSync(destination), 'fresh consumer directory required');
const digest = () => {
  const bytes = readFileSync(tarball);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
};
const hashes = digest();
assert.equal(hashes.sha256, process.env.EXPECTED_ARTIFACT_SHA256);
assert.equal(hashes.integrity, process.env.EXPECTED_ARTIFACT_INTEGRITY);
mkdirSync(destination, { recursive: true });
writeFileSync(resolve(destination, 'package.json'), JSON.stringify({ name: 'http-packed-consumer', private: true, type: 'module' }));
const run = (command, args, extra = {}) => execFileSync(command, args, { cwd: destination, encoding: 'utf8', env: { ...process.env, ...extra } });
run('npm', ['install', '--strict-peer-deps', '--legacy-peer-deps=false', '--force=false', '--ignore-scripts', '--registry=https://registry.npmjs.org', '--save-exact', tarball, '@dalgo/core@0.5.0', 'typescript@6.0.3', 'playwright@1.58.2']);
const lock = JSON.parse(readFileSync(resolve(destination, 'package-lock.json'), 'utf8'));
const core = lock.packages['node_modules/@dalgo/core'];
assert.equal(core?.version, '0.5.0');
assert.equal(core.resolved, 'https://registry.npmjs.org/@dalgo/core/-/core-0.5.0.tgz');
assert.equal(core.integrity, 'sha512-pb5b4ia7iO4gxmVKs+7UZZNn3f8iVDIS9T68w830Y7T1Jlilx3dgdtbQXm2kk0kyOicBOLVlur60tqoPYUmTvA==');
assert.equal(Object.keys(lock.packages).filter(p => p.endsWith('node_modules/@dalgo/core')).length, 1);
assert.ok(!lock.packages['node_modules/@dal-go/dalgo']);
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path || path === 'node_modules/@dal-go/dalgo2http') continue;
  assert.ok(!pkg.link && pkg.resolved?.startsWith('https://registry.npmjs.org/'), `nonregistry dependency: ${path}`);
}
const httpRoot = resolve(destination, 'node_modules/@dal-go/dalgo2http');
const manifest = JSON.parse(readFileSync(resolve(httpRoot, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@dal-go/dalgo2http');
assert.equal(manifest.version, process.env.EXPECTED_PACKAGE_VERSION);
assert.equal(manifest.gitHead, process.env.EXPECTED_SOURCE_SHA);
assert.equal(lock.packages['node_modules/@dal-go/dalgo2http'].integrity, hashes.integrity);
assert.ok(!manifest.private);
assert.equal(manifest.peerDependencies['@dalgo/core'], '>=0.5.0 <0.6.0');
assert.equal(readFileSync(resolve(httpRoot, 'LICENSE'), 'utf8').trimEnd(), readFileSync(resolve(repository, 'LICENSE'), 'utf8').trimEnd());
mkdirSync(resolve(destination, 'test'));
cpSync(resolve(repository, 'packages/http/test/browser-fixture.ts'), resolve(destination, 'test/browser-fixture.ts'));
writeFileSync(resolve(destination, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022', 'DOM'], strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: false, rootDir: 'test', outDir: 'fixture' }, include: ['test/browser-fixture.ts'] }));
run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
run('npm', ['ls', '@dalgo/core', '@dal-go/dalgo2http', '--all']);
run(process.execPath, ['node_modules/playwright/cli.js', 'install', 'chromium']);
const browser = JSON.parse(run(process.execPath, [resolve(repository, 'packages/http/scripts/browser-smoke.mjs')], {
  PLAYWRIGHT_MODULE: resolve(destination, 'node_modules/playwright/index.mjs'),
  HTTP_PACKAGE_ROOT: httpRoot, CORE_PACKAGE_ROOT: resolve(destination, 'node_modules/@dalgo/core'),
  HTTP_FIXTURE_ROOT: resolve(destination, 'fixture'),
}).trim());
assert.equal(browser.synthetic, true);
assert.equal(browser.providerRequests, 0);
assert.deepEqual(digest(), hashes, 'artifact changed during verification');
writeFileSync(resolve(destination, 'artifact-receipt.json'), JSON.stringify({ tarball, ...hashes, sourceSHA: manifest.gitHead, package: { name: manifest.name, version: manifest.version, gitHead: manifest.gitHead }, core, browser }, null, 2) + '\n');
