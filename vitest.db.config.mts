import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Database tests: apply the migrations to a throwaway local Postgres and
// check tenant isolation, permissions and plan limits.
export default defineConfig({
  // a test may compare the app's own checks with the database's (custom fields)
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/db/**/*.test.ts"],
    globalSetup: ["tests/db/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
