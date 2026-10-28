import { defineConfig } from 'vitest/config';

// Needs the Firestore emulator (pnpm test:rules starts it).
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], fileParallelism: false, testTimeout: 30_000 },
});
