import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/data/**',
      '**/*.config.ts',
      '**/*.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['packages/web/src/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    // 依赖方向守护（T-M0-01b，TDD §1.2）：domain 不 import gateway
    files: ['packages/server/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/gateway/**', 'gateway/**'],
              message: 'domain 层不得 import gateway（TDD §1.2 依赖方向）',
            },
          ],
        },
      ],
    },
  },
  {
    // 依赖方向守护（T-M0-01b，TDD §1.2）：pipeline 不 import adapters，经接口注入
    files: ['packages/server/src/pipeline/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/adapters/**', 'adapters/**'],
              message: 'pipeline 层不得 import adapters（TDD §1.2，LLM/存储能力经接口注入）',
            },
          ],
        },
      ],
    },
  },
  {
    // CI 脚本是命令行工具，需要正常输出
    files: ['scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },
);
