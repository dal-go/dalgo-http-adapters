import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] }, eslint.configs.recommended, tseslint.configs.recommended,
  { languageOptions: { globals: { AbortController: "readonly", TextDecoder: "readonly", TextEncoder: "readonly", URL: "readonly", clearTimeout: "readonly", crypto: "readonly", setTimeout: "readonly", Uint8Array: "readonly" } }, rules: { "@typescript-eslint/no-explicit-any": "error" } },
);
