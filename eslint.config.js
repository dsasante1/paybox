// Determinism enforcement (see docs/architecture.md#virtual-time).
//
// The emulator's core promise is that the same inputs + the same seed produce
// byte-identical output, and that `paybox time advance 5m` fires everything
// scheduled in that window *instantly*. That only holds if nothing in the
// codebase reads wall-clock time or unseeded randomness directly.
//
// These rules are the mechanism. Discipline is not.

const AMBIENT_NONDETERMINISM = [
  {
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message:
      'Date.now() is non-deterministic. Inject a Clock and call clock.now(). See packages/core/src/time/.',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message:
      'new Date() reads the wall clock. Use clock.now() / clock.nowISO() instead.',
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message:
      'Math.random() is unseeded. Inject a Random and call random.next(). See packages/core/src/random.ts.',
  },
  {
    selector: "CallExpression[callee.name=/^(setTimeout|setInterval)$/]",
    message:
      'Raw timers bypass virtual time and will not fire under `paybox time advance`. Use clock.schedule() or enqueue a job.',
  },
  {
    selector: "MemberExpression[property.name='randomUUID']",
    message:
      'crypto.randomUUID() is unseeded. Use the seeded id generator in @paybox/shared.',
  },
];

import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'apps/dashboard/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-restricted-syntax': ['error', ...AMBIENT_NONDETERMINISM],
    },
  },
  {
    // The clock and random implementations are the *only* places allowed to
    // touch the real sources of non-determinism. Everything else goes through
    // them. Tests may also use raw timers for their own orchestration.
    files: [
      'packages/core/src/time/**/*.ts',
      'packages/core/src/random.ts',
      'packages/shared/src/ids.ts',
      '**/*.test.ts',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
