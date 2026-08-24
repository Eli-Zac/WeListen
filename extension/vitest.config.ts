import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tests/e2e uses @playwright/test's own runner (`pnpm test:e2e`), not vitest.
    exclude: ['**/node_modules/**', 'tests/e2e/**'],
  },
});
