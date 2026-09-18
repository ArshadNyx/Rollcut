import { defineConfig } from 'vitest/config';

// Unit tests only. Integration tests drive a real browser and live in
// test/e2e, run via `pnpm test:e2e`.
export default defineConfig({
  test: { include: ['test/*.test.ts'] },
});
