import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Never read a real ~/.hivenod/agent.json from the machine running the tests.
    env: { HIVENOD_HOME: '/nonexistent/hive-home-for-tests' },
  },
});
