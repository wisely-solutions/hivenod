import { defineConfig } from 'vitest/config';

// Black-box tests of the Go CLI (`hivenod`): they build the binary once and drive it over MCP
// (stdio) and its commands, against the Auth and Firestore emulators and the real rules
// (pnpm test:rules starts them). The Go CLI is the only agent client (item MlWOc3O5NyfZcLgetrVo).
export default defineConfig({
  test: {
    globalSetup: ['test/globalSetup.ts'],
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
