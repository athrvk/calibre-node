import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended
    ],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // A lint-only project so that `*.test.ts` files -- which the build
        // config deliberately excludes from the published output -- are still
        // type-aware linted.
        project: ['./tsconfig.eslint.json']
      }
    }
  },
  {
    ignores: ['**/node_modules', 'dist']
  }
);