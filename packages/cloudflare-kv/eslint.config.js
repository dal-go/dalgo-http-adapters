import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["dist", "coverage", "eslint.config.js", "examples"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  {
    files: ["scripts/*.mjs"], ...tseslint.configs.disableTypeChecked,
    languageOptions: { parserOptions: { project: false, projectService: false }, globals: {
      process: "readonly", Buffer: "readonly", AbortController: "readonly", AbortSignal: "readonly",
      setTimeout: "readonly", clearTimeout: "readonly",
    } },
  },
);
