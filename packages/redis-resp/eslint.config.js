import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage", "eslint.config.js"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  {
    files: ["scripts/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { Buffer: "readonly", Request: "readonly", AbortController: "readonly", process: "readonly", setTimeout: "readonly", clearTimeout: "readonly" },
      parserOptions: { project: false, projectService: false },
    },
  },
);
