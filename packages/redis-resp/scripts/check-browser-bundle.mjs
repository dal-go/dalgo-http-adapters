import { build } from "esbuild";
import { fileURLToPath, URL } from "node:url";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
  metafile: true,
});
for (const input of Object.keys(result.metafile.inputs)) {
  if (/redis-resp\/src\/(?:node|server|resp)\.ts$/u.test(input)) {
    throw new Error("Redis browser entry includes a server-only module");
  }
}
