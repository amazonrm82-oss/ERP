import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // FXC-05: a database read must look at its error (src/lib/db-read.ts)
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "VariableDeclarator[init.type='AwaitExpression'] > ObjectPattern.id:has(> Property[key.name='data']):not(:has(> Property[key.name='error']))",
          message: "A database read must check its error: destructure `error` too, or use must() from @/lib/db-read.",
        },
        {
          selector: "MemberExpression[property.name='data'][object.type='AwaitExpression']",
          message: "A database read must check its error: use must() from @/lib/db-read.",
        },
      ],
    },
  },
  // FXC-08: the service-role key has three uses only (CLAUDE.md, hard rule 5); a new one is the owner's decision
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
      "src/lib/supabase/service.ts",
      "src/features/intake/server.ts",
      "src/features/intake/public-form.ts",
      "src/features/notifications/push-server.ts",
      "src/features/files/cleanup-server.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^@/lib/supabase/service$|/supabase/service$)",
              message: "The service-role key is only for the uses listed in CLAUDE.md (hard rule 5). Ask the owner before adding one.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Third-party Claude Code skills, not app code.
    ".claude/**",
  ]),
]);

export default eslintConfig;
