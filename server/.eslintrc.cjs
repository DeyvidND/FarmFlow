// Minimal, type-aware-parser ESLint config for the API. `nest build` already
// does the heavy type-checking; this catches a few logic-level mistakes without
// duplicating the compiler. Rules that TypeScript already covers are disabled to
// avoid false positives on type-only syntax.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  env: { node: true, es2022: true, jest: true },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/'],
  extends: ['eslint:recommended'],
  rules: {
    'no-unused-vars': 'off', // handled by tsc (noUnusedLocals) — avoids type false-positives
    'no-undef': 'off', // TypeScript resolves globals/types
    'no-redeclare': 'off', // false-positives on TS function overloads; tsc catches real redeclares
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-constant-condition': ['error', { checkLoops: false }],
  },
};
