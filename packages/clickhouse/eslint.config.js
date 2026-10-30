import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage", "eslint.config.js"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["scripts/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { URL: "readonly", AbortController: "readonly", AbortSignal: "readonly", Buffer: "readonly", Response: "readonly", TextDecoder: "readonly", console: "readonly", document: "readonly", fetch: "readonly", performance: "readonly", process: "readonly", setTimeout: "readonly", window: "readonly" },
      parserOptions: { project: false, projectService: false },
    },
  },
);
