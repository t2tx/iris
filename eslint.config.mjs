// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Bolt's listener contract requires async handlers even when the body
      // delegates to synchronous calls — `await` is not always present.
      '@typescript-eslint/require-await': 'off',
      // コード複雑度
      complexity: ['warn', {max: 10}],
      'max-depth': ['warn', {max: 4}],
      'max-lines': ['warn', {max: 700, skipBlankLines: true, skipComments: true}],
      'max-lines-per-function': [
        'warn',
        {max: 80, skipBlankLines: true, skipComments: true},
      ],
    },
  },
  {
    // node:test's top-level test() calls are fire-and-forget by design.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
);
