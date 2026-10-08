// Node 24. Only the supplied tarball and registry packages enter this consumer.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const [tarballArg, destinationArg, node20, node24] = process.argv.slice(2);
assert.ok(tarballArg && destinationArg && node20 && node24, 'tarball, fresh external directory and Node 20/24 paths required');
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
writeFileSync(resolve(destination, 'package.json'), JSON.stringify({ name: 'ovdb-packed-consumer', private: true, type: 'module' }));
const run = (command, args, extra = {}) => execFileSync(command, args, { cwd: destination, encoding: 'utf8', env: { ...process.env, ...extra } });
run('npm', ['install', '--strict-peer-deps', '--legacy-peer-deps=false', '--force=false', '--ignore-scripts', '--registry=https://registry.npmjs.org', '--save-exact', tarball, '@dalgo/core@0.6.0', 'typescript@6.0.3', 'playwright@1.58.2', 'esbuild@0.25.12']);
const lock = JSON.parse(readFileSync(resolve(destination, 'package-lock.json'), 'utf8'));
const core = lock.packages['node_modules/@dalgo/core'];
assert.equal(core?.version, '0.6.0');
assert.equal(core.resolved, 'https://registry.npmjs.org/@dalgo/core/-/core-0.6.0.tgz');
assert.equal(core.integrity, 'sha512-C/hoawh4YU5Htm9PnrQi7Z9gP9rsy2PZ3Aj9RU3sV+76mEPHQ2rKWGkBjaxSoHB4PZn4DLpAzqQ+OoMKfzZ8BQ==');
assert.equal(Object.keys(lock.packages).filter(p => p.endsWith('node_modules/@dalgo/core')).length, 1);
assert.ok(!lock.packages['node_modules/@dal-go/dalgo']);
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path || path === 'node_modules/@dalgo/ovdb') continue;
  assert.ok(!pkg.link && pkg.resolved?.startsWith('https://registry.npmjs.org/'), `nonregistry dependency: ${path}`);
}
const ovdbRoot = resolve(destination, 'node_modules/@dalgo/ovdb');
const manifest = JSON.parse(readFileSync(resolve(ovdbRoot, 'package.json'), 'utf8'));
assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './dtql']);
for (const path of ['client', 'database', 'query', 'path', 'dist/index.js']) {
  run(process.execPath, ['--input-type=module', '-e', `try { await import('@dalgo/ovdb/${path}'); process.exit(1); } catch (e) { if(e.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw e; }`]);
}
assert.equal(manifest.name, '@dalgo/ovdb');
assert.equal(manifest.version, process.env.EXPECTED_PACKAGE_VERSION);
assert.equal(manifest.gitHead, process.env.EXPECTED_SOURCE_SHA);
assert.equal(lock.packages['node_modules/@dalgo/ovdb'].integrity, hashes.integrity);
assert.ok(!manifest.private);
assert.equal(manifest.peerDependencies['@dalgo/core'], '>=0.6.0 <0.7.0');
assert.equal(readFileSync(resolve(ovdbRoot, 'LICENSE'), 'utf8').trimEnd(), readFileSync(resolve(repository, 'LICENSE'), 'utf8').trimEnd());
mkdirSync(resolve(destination, 'test'));
const fixtureSource = readFileSync(resolve(repository, 'packages/ovdb/test/dtql-fixture.ts'), 'utf8').replace('../src/dtql/index.js', '@dalgo/ovdb/dtql');
writeFileSync(resolve(destination, 'test/dtql-fixture.ts'), fixtureSource);
cpSync(resolve(repository, 'packages/ovdb/test/browser-fixture.ts'), resolve(destination, 'test/browser-fixture.ts'));
writeFileSync(resolve(destination, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022', 'DOM'], strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: false, rootDir: 'test', outDir: 'fixture' }, include: ['test/browser-fixture.ts'] }));
cpSync(resolve(repository, '.github/scripts/ovdb-runtime-smoke.mjs'), resolve(destination, 'runtime-smoke.mjs'));
const runtimes = [node20, node24].map((runtime, index) => {
  const major = index === 0 ? 20 : 24;
  assert.ok(index === 0 ? run(runtime, ['--version']).trim() === 'v20.0.0' : /^v24\./.test(run(runtime, ['--version']).trim()), `Node ${major} required`);
  run(runtime, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
  const proof = JSON.parse(run(runtime, ['runtime-smoke.mjs']).trim());
  assert.match(proof.nodeVersion, new RegExp(`^v${major}\\.`));
  return { ...proof, typedImports: true, ...hashes, sourceSHA: manifest.gitHead };
});
cpSync(resolve(repository, '.github/scripts/ovdb-browser-smoke.mjs'), resolve(destination, 'browser-smoke.mjs'));
run('npm', ['ls', '@dalgo/core', '@dalgo/ovdb', '--all']);
run(process.execPath, ['node_modules/playwright/cli.js', 'install', 'chromium']);
const browser = JSON.parse(run(process.execPath, ['browser-smoke.mjs']).trim());
assert.equal(browser.synthetic, true);
assert.equal(browser.providerRequests, 0);
assert.equal(browser.defaultNativeFetch, true);
assert.equal(browser.nativeDefaultPosts, 2);
assert.equal(browser.nativeDefaultRows, 2);
assert.deepEqual(digest(), hashes, 'artifact changed during verification');
writeFileSync(resolve(destination, 'artifact-receipt.json'), JSON.stringify({ tarball, ...hashes, sourceSHA: manifest.gitHead, package: { name: manifest.name, version: manifest.version, gitHead: manifest.gitHead }, core, browser, runtimes }, null, 2) + '\n');
