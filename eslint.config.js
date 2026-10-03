import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "error",
      // Plugins e handlers do Fastify são convencionalmente async mesmo
      // quando não usam await diretamente (para manter a assinatura
      // compatível com o tipo esperado pelo framework).
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "coverage/", "eslint.config.js", "public/"],
  }
);
