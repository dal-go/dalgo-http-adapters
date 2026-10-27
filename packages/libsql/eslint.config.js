import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".browser/**", "playwright-report/**", "test-results/**"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        AbortController: "readonly",
        AbortSignal: "readonly",
        Headers: "readonly",
        Response: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        Uint8Array: "readonly",
        atob: "readonly",
        btoa: "readonly",
        clearTimeout: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        location: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  {
    files: ["scripts/*.mjs", "test/browser/server.ts"],
    languageOptions: { globals: { Buffer: "readonly", console: "readonly", process: "readonly", setTimeout: "readonly", URL: "readonly" } },
  },
);
