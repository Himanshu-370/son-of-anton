import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/support/isolate-home.ts'],
    // Above the 10 s lock wait (src/core/lock.ts): contention tests may be slow under load but must not be cut off.
    testTimeout: 20_000,
  },
});
