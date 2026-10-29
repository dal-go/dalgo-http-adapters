// Browser entry for the real-Chromium proof. esbuild bundles this module (and
// the package's built `dist` ESM entry) into one browser module, which exposes
// the actual adapter class on `globalThis` for the Playwright page.
import * as adapter from "../../dist/index.js";

globalThis.TypesenseAdapter = adapter;
