import { defineConfig } from 'vitest/config';

// Needs the Auth and Firestore emulators (pnpm test:rules starts them).
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], fileParallelism: false, testTimeout: 30_000 },
});
