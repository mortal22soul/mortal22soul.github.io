import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintPluginAstro from "eslint-plugin-astro";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
  // Global ignores (replaces .eslintignore)
  {
    ignores: [".vscode/", "dist/", "node_modules/", "public/", ".astro/"],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript recommended rules
  ...tseslint.configs.recommended,

  // Astro recommended rules
  ...eslintPluginAstro.configs.recommended,

  // Custom rules
  {
    rules: {
      "@typescript-eslint/triple-slash-reference": "off",
    },
  },

  // Prettier must be LAST to disable conflicting formatting rules
  eslintConfigPrettier,
];
