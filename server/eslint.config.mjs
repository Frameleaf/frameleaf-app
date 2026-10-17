import js from '@eslint/js';
import { importX } from 'eslint-plugin-import-x';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import typescriptEslint from 'typescript-eslint';

export default defineConfig([
  eslintPluginUnicorn.configs.recommended,
  js.configs.recommended,
  typescriptEslint.configs.recommended,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    ignores: ['eslint.config.mjs'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.node,
      },

      parser: typescriptEslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',

      parserOptions: {
        project: 'tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      // Keep the pre-upgrade documentation and parameter style policy.
      'unicorn/no-asterisk-prefix-in-documentation-comments': 'off',
      'unicorn/no-unnecessary-parameters': 'off',
      // shortcut: restore widened style rules after focused reviews of the affected files.
      'unicorn/prefer-ternary': 'off',
      'unicorn/prefer-early-return': 'off',
      'unicorn/prefer-continue': 'off',
      'unicorn/no-unnecessary-array-flat-map': 'off',
      'unicorn/prefer-combined-guards': 'off',
      'unicorn/prefer-default-parameters': 'off',
      'unicorn/prefer-logical-operator-over-ternary': 'off',
      'unicorn/prefer-minimal-ternary': 'off',
      'unicorn/prefer-type-error': 'off',
      'unicorn/no-negated-condition': 'off',
      'unicorn/consistent-conditional-object-spread': 'off',
      'unicorn/prefer-group-by': 'off',
      'unicorn/prefer-set-methods': 'off',
      'unicorn/prefer-single-object-destructuring': 'off',
      'unicorn/prefer-array-from-async': 'off',
      'unicorn/prefer-array-flat-map': 'off',
      'unicorn/no-immediate-mutation': 'off',
      'unicorn/name-replacements': 'off',
      'unicorn/filename-case': 'off',
      'unicorn/no-null': 'off',
      'unicorn/prefer-top-level-await': 'off',
      'unicorn/prefer-event-target': 'off',
      'unicorn/no-thenable': 'off',
      'unicorn/import-style': 'off',
      'unicorn/prefer-structured-clone': 'off',
      'unicorn/no-for-loop': 'off',
      'unicorn/no-array-sort': 'off',
      'unicorn/no-unreadable-for-of-expression': 'off',
      'unicorn/no-break-in-nested-loop': 'off',
      'unicorn/no-top-level-assignment-in-function': 'off',
      'unicorn/consistent-function-scoping': 'off',
      'unicorn/no-await-expression-member': 'off',
      'unicorn/prefer-uint8array-base64': 'off',
      'unicorn/max-nested-calls': 'off',
      'unicorn/no-declarations-before-early-exit': 'off',
      'unicorn/no-unreadable-object-destructuring': 'off',
      'unicorn/single-line-block-comment-style': ['error', 'single-line'],
      // maybe we do want to enable this later. TBD
      'unicorn/prefer-await': 'off',
      'unicorn/consistent-class-member-order': 'off',
      'unicorn/class-reference-in-static-methods': ['error', { preferThis: false, preferSuper: false }],
      'unicorn/no-unsafe-property-key': 'off',
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/no-computed-property-existence-check': 'off',
      'unicorn/no-non-function-verb-prefix': 'off',
      'unicorn/prefer-simple-condition-first': 'off',
      // prefer the typescript-eslint type-aware version
      'unicorn/require-array-sort-compare': 'off',
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      'require-await': 'off',
      '@typescript-eslint/require-await': 'error',
      curly: 2,
      'object-shorthand': ['error', 'always'],
      eqeqeq: 'error',
      'import-x/no-named-as-default': 'off',
      'import-x/order': [
        'error',
        {
          groups: [['builtin', 'external'], 'index', ['parent', 'sibling', 'type']],
          alphabetize: { order: 'asc' },
          named: true,
        },
      ],
      'import-x/newline-after-import': 'error',
      'import-x/no-empty-named-blocks': 'error',

      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['.*'],
              message: 'Relative imports are not allowed.',
            },
          ],
        },
      ],

      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node, ecmaVersion: 'latest', sourceType: 'module' },
  },
  {
    // These Node runtime tests exercise the built entry point; dist is intentionally absent before build.
    files: ['test/runtime/emails.test.mjs'],
    rules: { 'import-x/no-unresolved': 'off' },
  },
  eslintPluginPrettierRecommended,
  {
    files: ['src/utils/media.ts'],
    rules: {
      // Constructor defaults intentionally allocate independent tuning state for each instance.
      'unicorn/no-object-as-default-parameter': 'off',
    },
  },
]);
