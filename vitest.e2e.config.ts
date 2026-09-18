import { defineConfig } from 'vitest/config';

// Playwright-backed integration tests: slow, and they need a browser.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
