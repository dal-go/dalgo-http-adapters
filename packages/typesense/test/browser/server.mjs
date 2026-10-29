// Serves the real-Chromium proof pages. `/bundle.js` exposes the package's
// built dist entry for the real cross-origin SDK proof. `/verifier.js` is a
// dedicated test-only bundle of the real internal verifier, used to isolate its
// macrotask cadence from HTTP and body-read timing. The page is a normal
// cross-origin HTTP origin; the adapter then talks directly to the
// separately-originated pinned Typesense server, so Chromium itself enforces
// the server's CORS response. Nothing is proxied, routed or intercepted.
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? "4331");

async function bundle(entry, label) {
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  const code = result.outputFiles[0]?.contents;
  if (code === undefined) throw new Error(`esbuild produced no browser bundle for ${label}`);
  return code;
}

const adapterCode = await bundle("entry.mjs", "the adapter");
const verifierCode = await bundle("verifier-entry.mjs", "the internal verifier");

function page(title, script) {
  return `<!doctype html>
<meta charset="utf-8">
<title>${title}</title>
<script type="module" src="${script}"></script>
<body>ready</body>
`;
}

const adapterHtml = page("Typesense SDK browser proof", "/bundle.js");
const verifierHtml = page("Typesense verifier cadence proof", "/verifier.js");

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  if (request.url === "/bundle.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(adapterCode);
    return;
  }
  if (request.url === "/verifier.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(verifierCode);
    return;
  }
  if (request.url === "/verifier.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(verifierHtml);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(adapterHtml);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Typesense SDK browser proof server listening on http://127.0.0.1:${port}`);
});
