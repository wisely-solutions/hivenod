import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/playwright-report/**', '.firebase/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  { files: ['apps/web/**/*.{ts,tsx}'], ...jsxA11y.flatConfigs.recommended },
  {
    files: ['**/*.{js,mjs}', 'packages/agent/**/*.ts', 'scripts/**'],
    languageOptions: { globals: globals.node },
  },
  { files: ['apps/web/public/*.js'], languageOptions: { globals: globals.browser } },
);
