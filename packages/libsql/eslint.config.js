import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { AbortController: "readonly", TextDecoder: "readonly", TextEncoder: "readonly", Uint8Array: "readonly", clearTimeout: "readonly", setTimeout: "readonly" } },
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
);
