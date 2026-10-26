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
        // DSN-06: colours and font sizes come from the design system (src/app/globals.css)
        ...["Literal", "TemplateElement"].flatMap((node) => {
          const value = node === "Literal" ? "value" : "value.raw";
          return [
            {
              selector: `${node}[${value}=/(^|[\\s:])(bg|text|border|ring|outline|fill|stroke|from|via|to|decoration|divide|shadow|caret|placeholder)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)\\b/]`,
              message: "Use a colour of the design system (bg-surface, text-ink-soft, text-on-accent…), not a Tailwind palette colour (DSN-06).",
            },
            {
              selector: `${node}[${value}=/-\\[(#|rgb|hsl)/]`,
              message: "Colours are defined only in src/app/globals.css (DSN-06).",
            },
            {
              selector: `${node}[${value}=/(^|[\\s:])text-\\[[0-9.]+(rem|px|em)\\]/]`,
              message: "Use a size of the type scale (text-2xs, text-caption, text-sm, text-md, text-lead…), not a font size written here (DSN-06).",
            },
          ];
        }),
      ],
    },
  },
  // FXC-08: the service-role key has only the uses listed (CLAUDE.md, hard rule 5); a new one is the owner's decision
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
      "src/lib/supabase/service.ts",
      "src/features/intake/server.ts",
      "src/features/intake/public-form.ts",
      "src/features/notifications/push-server.ts",
      "src/features/files/cleanup-server.ts",
      // CAL-07: the personal calendar feed, approved public secret-link pattern (owner, 8 October 2026)
      "src/features/calendar-feed/feed-server.ts",
      // CAL-10: the public booking page, approved public secret-link pattern (owner, 8 October 2026)
      "src/features/booking/public-server.ts",
      // BIZ-02: the public business card, approved public secret-link pattern (owner, 13 October 2026)
      "src/features/business-cards/public-server.ts",
      // QUO-08: the customer's quote page, approved public secret-link pattern (owner, 8 October 2026)
      "src/features/quotes/public-server.ts",
      // BIZ-03: the QR scan counter, approved public secret-link pattern (owner, 13 October 2026)
      "src/features/qr-codes/scan-server.ts",
      // SPD-07: the site widget's script and short form, approved public secret-link pattern (owner, 13 October 2026)
      "src/features/site-widgets/public-server.ts",
      // ORD-05: the customer's order confirmation page, approved public secret-link pattern (owner, 20 October 2026)
      "src/features/orders/public-server.ts",
      // QUO-06 follow-ups (owner, 26 October 2026): the server alone writes a quote's PDF (public.quote_pdf_store), and the
      // customer downloads it from the quote's link (public.quote_public_pdf)
      "src/features/quotes/pdf-store-server.ts",
      "src/features/quotes/pdf-public-server.ts",
      // ADM-01 (owner, 26 October 2026, answer (ב)): the public subprocessors page (public.subprocessors_public_page)
      "src/features/legal/subprocessors-public-server.ts",
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
