import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { parse } from 'yaml';
await build({ entryPoints: ['test/browser-fixture.ts'], bundle: true, platform: 'browser', format: 'esm', outfile: 'browser-fixture.js' });
const { readFileSync } = await import('node:fs');
const browser = await chromium.launch({ headless: true });
const blocked = [], prepared = new Map();
let nativeDefaultPosts = 0;
try {
  const page = await browser.newPage();
  await page.exposeFunction('prepareNativeResponse', (endpoint, executionId, body) => {
    assert.equal(endpoint, 'https://worker.example/ecb-public/v1/databases/ecb/dtql');
    assert.match(executionId, /^[a-f0-9]{32}$/);
    assert.equal(JSON.parse(body).providerReads.execution.id, executionId);
    assert.ok(!prepared.has(executionId));
    prepared.set(executionId, body);
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (url === 'https://directory.example/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script type="module">import { runSyntheticOVDBConsumer, runSyntheticOVDBNativeBrowserConsumer } from "./fixture.js"; window.proof = (async () => ({ ...await runSyntheticOVDBConsumer(), ...await runSyntheticOVDBNativeBrowserConsumer(window.prepareNativeResponse) }))();</script>' });
    if (url === 'https://directory.example/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync('browser-fixture.js', 'utf8') });
    if (url === 'https://worker.example/ecb-public/v1/databases/ecb/dtql') {
      const headers = { 'Access-Control-Allow-Origin': 'https://directory.example', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, OVDB-Execution-ID', 'Cache-Control': 'no-store' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      assert.equal(request.method(), 'POST');
      assert.equal(request.headers()['content-type'], 'application/yaml');
      assert.equal(request.headers().cookie, undefined);
      assert.equal(request.headers().authorization, undefined);
      assert.deepEqual(parse(request.postData()), { from: { name: 'daily' }, limit: 50 });
      const id = request.headers()['ovdb-execution-id'], body = prepared.get(id);
      assert.ok(body, 'native request must use the prepared owner nonce');
      prepared.delete(id);
      nativeDefaultPosts++;
      return route.fulfill({ contentType: 'application/json', headers, body });
    }
    blocked.push(url); await route.abort();
  });
  await page.goto('https://directory.example/');
  const proof = await page.evaluate(() => window.proof);
  assert.equal(nativeDefaultPosts, 2, 'both public exports must POST through untouched native Fetch');
  assert.equal(proof.defaultNativeFetch, true);
  assert.equal(proof.nativeDefaultRows, 2);
  assert.equal(prepared.size, 0);
  if (blocked.length) throw new Error('external browser request refused');
  console.log(JSON.stringify({ ...proof, nativeDefaultPosts, blockedExternalRequests: blocked }));
} catch (error) {
  console.error(JSON.stringify({ nativeDefaultPosts, blockedExternalRequests: blocked }));
  throw error;
} finally { await browser.close(); }
