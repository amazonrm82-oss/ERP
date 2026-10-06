import { defineConfig } from "vitest/config";

// Database tests: apply the migrations to a throwaway local Postgres and
// check tenant isolation, permissions and plan limits.
export default defineConfig({
  test: {
    include: ["tests/db/**/*.test.ts"],
    globalSetup: ["tests/db/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
