// Verify one immutable artifact against every required registry core version.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ovdbReleaseCores } from './ovdb-release-cores.mjs';

const [tarball, destinationArg, node20, node24] = process.argv.slice(2);
assert.ok(tarball && destinationArg && node20 && node24, 'artifact, fresh consumer directory, Node 20/24 required');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const destination = resolve(destinationArg), rel = relative(repository, destination);
assert.ok(rel.startsWith(`..${sep}`) || isAbsolute(rel), 'consumer must be outside repository');
assert.ok(!existsSync(destination), 'fresh consumer directory required');
mkdirSync(destination, { recursive: true });
const receipts = ovdbReleaseCores.map(core => {
  const consumer = resolve(destination, `core-${core.version}`);
  process.stdout.write(execFileSync(process.execPath, [resolve(repository, '.github/scripts/check-ovdb-tarball.mjs'), resolve(tarball), consumer, node20, node24], {
    cwd: repository, encoding: 'utf8', env: { ...process.env, OVDB_CORE_VERSION: core.version },
  }));
  return JSON.parse(readFileSync(resolve(consumer, 'artifact-receipt.json'), 'utf8'));
});
const receipt = { ...receipts[0], coreMatrix: receipts };
writeFileSync(resolve(destination, 'artifact-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
