// The owned fixture may use Node test helpers. Its imported package graph may
// not import a Node builtin, database driver, or either lazy DuckDB engine.
// Synchronous Node24 hooks cover CommonJS require as well as ESM import.
// https://nodejs.org/docs/latest-v24.x/api/module.html#customization-hooks
import { builtinModules, registerHooks } from "node:module";
const fixture = new URL("./browser-roots.mjs", import.meta.url).href;
const builtins = new Set(builtinModules);
const drivers = /^(?:mongodb|bson|@duckdb\/(?:node-api|node-bindings(?:-[^/]+)?|duckdb-wasm))(?:\/|$)/u;
const driverFiles = /\/node_modules\/(?:mongodb|bson|@duckdb\/(?:node-api|node-bindings(?:-[^/]+)?|duckdb-wasm))(?:\/|$)/u;
function refuse(specifier) {
  const error = new Error(`Packed browser package graph imported a forbidden dependency: ${specifier}`);
  error.code = "ERR_NATIVE_PACKED_BROWSER_IMPORT";
  throw error;
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (drivers.test(specifier)) refuse(specifier);
    if ((specifier.startsWith("node:") || builtins.has(specifier)) && context.parentURL !== fixture) refuse(specifier);
    const result = nextResolve(specifier, context);
    if (driverFiles.test(decodeURIComponent(result.url))) refuse(specifier);
    return result;
  },
});
