// Owned temporary copy verifies standalone lint/check without generated artifacts.
// No install, provider request or shared checkout deletion occurs.
import assert from 'node:assert/strict';
import { cp, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'dalgo-http-clean-output-'));
try {
  const cleanRoot = join(temporaryRoot, 'http');
  const excluded = new Set(['node_modules', 'dist', '.browser-fixture-dist', 'coverage']);
  await cp(packageRoot, cleanRoot, { recursive: true, filter: source => !excluded.has(basename(source)) });
  await symlink(await realpath(join(packageRoot, 'node_modules')), join(cleanRoot, 'node_modules'), 'dir');
  for (const script of ['lint', 'check']) {
    for (const output of ['dist', '.browser-fixture-dist']) {
      await assert.rejects(stat(join(cleanRoot, output)), { code: 'ENOENT' });
    }
    console.log(`Clean-output regression: no HTTP dist or browser fixture output exists before standalone ${script}.`);
    // npm runs the identical manifest scripts without pnpm's automatic install.
    const result = spawnSync('npm', ['run', script], { cwd: cleanRoot, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status === null) throw Error(`clean-output ${script} terminated: ${result.signal}`);
    process.exitCode = result.status;
    if (result.status !== 0) break;
    assert.ok((await stat(join(cleanRoot, 'dist/index.js'))).isFile());
    assert.ok((await stat(join(cleanRoot, 'dist/index.d.ts'))).isFile());
    console.log(`Clean-output regression passed: ${script} bootstrapped public exports without disabling typed lint.`);
    // Only remove artifacts in this owned copy, so the next script also starts cold.
    for (const output of ['dist', '.browser-fixture-dist']) {
      await rm(join(cleanRoot, output), { recursive: true, force: true });
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
