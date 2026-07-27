module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended-type-checked'],
  rules: {
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }]
  },
  ignorePatterns: ['dist/', 'coverage/', 'node_modules/', 'skills/']
};
