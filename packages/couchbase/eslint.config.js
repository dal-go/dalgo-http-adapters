import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config({ ignores: ["dist", "coverage", "eslint.config.js"] }, eslint.configs.recommended, ...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked, { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } }, rules: { "@typescript-eslint/restrict-template-expressions": "off", "@typescript-eslint/no-unsafe-assignment": "off" } });
