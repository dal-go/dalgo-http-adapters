import { build } from 'esbuild';
import { chromium } from 'playwright';
await build({ entryPoints: ['test/browser-fixture.ts'], bundle: true, platform: 'browser', format: 'esm', outfile: 'browser-fixture.js' });
const { readFileSync } = await import('node:fs');
const browser = await chromium.launch({ headless: true });
const blocked = [];
try {
  const page = await browser.newPage();
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url === 'https://directory.example/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script type="module">import { runSyntheticOVDBConsumer } from "./fixture.js"; window.proof = runSyntheticOVDBConsumer();</script>' });
    if (url === 'https://directory.example/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync('browser-fixture.js', 'utf8') });
    blocked.push(url); await route.abort();
  });
  await page.goto('https://directory.example/');
  const proof = await page.evaluate(() => window.proof);
  if (blocked.length) throw new Error('external browser request refused');
  console.log(JSON.stringify({ ...proof, blockedExternalRequests: blocked }));
} finally { await browser.close(); }
