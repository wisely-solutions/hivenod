import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/gates.ts', 'src/actions.ts'],
      reporter: ['text', 'json-summary'],
      // Acceptance (Build 03): 100% branch coverage on gates.ts.
      thresholds: {
        'src/gates.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
      },
    },
  },
});
