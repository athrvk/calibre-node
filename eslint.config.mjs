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
        project: true
      }
    }
  },
  {
    ignores: ['**/node_modules', 'dist']
  }
);