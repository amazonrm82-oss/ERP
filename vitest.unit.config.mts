import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Unit tests: the app's own logic (no database, no browser), in seconds.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // server-only throws outside a React server; the unit tests import server modules directly
      "server-only": fileURLToPath(new URL("./tests/unit/server-only.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
});
