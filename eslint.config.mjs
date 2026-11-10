import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// FXC-05 (a database read must look at its error, src/lib/db-read.ts) and DSN-06 (colours and sizes of the design system)
const readAndDesignSelectors = [
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
];

// IMP-04 (owner (160) א): SUPABASE_JWT_SECRET (the project's JWT secret, as strong as the service key) is read in ONE file
// only, the background job worker's signer. Its name anywhere else in src is refused: process.env.X, process.env["X"] and
// destructuring alike.
const JWT_SECRET_SIGNER = "src/features/background/user-token.ts";
const jwtSecretSelectors = [
  "MemberExpression[property.name='SUPABASE_JWT_SECRET']",
  "MemberExpression[property.value='SUPABASE_JWT_SECRET']",
  "Property[key.name='SUPABASE_JWT_SECRET']",
  "Property[key.value='SUPABASE_JWT_SECRET']",
  "Literal[value='SUPABASE_JWT_SECRET']",
  "TemplateElement[value.raw=/SUPABASE_JWT_SECRET/]",
].map((selector) => ({
  selector,
  message: "SUPABASE_JWT_SECRET is read only by the background job worker's signer (src/features/background/user-token.ts), owner (160) א.",
}));

// FXC-08: the service-role key has only the uses listed (CLAUDE.md, hard rule 5); a new one is the owner's decision
const serviceKeyAllowList = {
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
    // WAB-05: link previews for listed preview bots, approved public secret-link pattern (owner, 27 October 2026)
    "src/features/link-preview/preview-server.ts",
    // BIZ-03: the QR scan counter, approved public secret-link pattern (owner, 13 October 2026)
    "src/features/qr-codes/scan-server.ts",
    // SPD-07: the site widget's script and short form, approved public secret-link pattern (owner, 13 October 2026)
    "src/features/site-widgets/public-server.ts",
    // ORD-05: the customer's order confirmation page, approved public secret-link pattern (owner, 20 October 2026)
    "src/features/orders/public-server.ts",
    // BAL-04: the customer's statement page, approved public secret-link pattern (owner, 8 October 2026)
    "src/features/statements/public-server.ts",
    // CNS-09 / CNS-10: the customer's preferences page and unsubscribe link, approved public secret-link pattern (owner's
    // answer (225) א, 10 November 2026)
    "src/features/preferences/public-server.ts",
    // QUO-06 follow-ups (owner, 26 October 2026): the server alone writes a quote's PDF (public.quote_pdf_store), and the
    // customer downloads it from the quote's link (public.quote_public_pdf)
    "src/features/quotes/pdf-store-server.ts",
    "src/features/quotes/pdf-public-server.ts",
    // QUO-09 signed PDF (owner (3) א, (33) ב): the customer's route and staff's write of an accepted quote's signed PDF
    "src/features/quotes/signed-pdf-server.ts",
    // ORD-05 PDF (owner, 1 November 2026, answer (1) ב): the server alone writes an order's PDF (public.order_pdf_store),
    // and the customer downloads it from the order's link (public.order_public_pdf)
    "src/features/orders/pdf-store-server.ts",
    "src/features/orders/pdf-public-server.ts",
    // CAP-11 (owner, 4 November 2026, answer (126) א): the Meta Lead Ads webhook and its sweep
    "src/features/meta-leads/webhook-server.ts",
    // INT-01 (owner, 10 November 2026, answer (227) ב): "test connection" with the stored token
    // (public.integration_test_claim, public.integration_test_finish), after the owner's or admin's session was checked
    "src/features/integrations/test-server.ts",
    // ADM-01 (owner, 26 October 2026, answer (ב)): the public subprocessors page (public.subprocessors_public_page)
    "src/features/legal/subprocessors-public-server.ts",
    // OPS-02 (owner, 2 November 2026, answers (40) ב, (42) ד): the secret-link pages' shared per-sender limit of "not found"
    // answers (public.public_sender_check, public.public_sender_miss)
    "src/lib/public-sender-server.ts",
    // OPS-04 (owner, 26 October 2026, wave 3 use (1)): the background job worker woken by the database with the shared
    // secret (public.claim_jobs, public.finish_job, public.job_message_may_send)
    "src/features/jobs/run-server.ts",
    // PRK-02 (owner, 26 October 2026, wave 3 use (3)): the public privacy-request page (public.privacy_request_page) and its
    // form (public.privacy_request_submit)
    "src/features/privacy-requests/public-server.ts",
  ],
};

const serviceKeyPattern = {
  regex: "(^@/lib/supabase/service$|/supabase/service$)",
  message: "The service-role key is only for the uses listed in CLAUDE.md (hard rule 5). Ask the owner before adding one.",
};

// IMP-04 review 1 (owner (160) א): only the background job worker makes the person's token source and client. Pages and
// actions may import backgroundJobsReady (and TokenRefused / the types) from that module, nothing that signs.
const BACKGROUND_WORKER = "src/features/jobs/run-server.ts";
const tokenSourcePattern = {
  regex: "(^@/features/background/user-token$|/user-token$)",
  importNames: ["createBackgroundTokenSource", "createUserClient"],
  message: "Only the background job worker (src/features/jobs/run-server.ts) makes the person's token source and client (IMP-04, owner (160) א).",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [JWT_SECRET_SIGNER],
    rules: { "no-restricted-syntax": ["error", ...readAndDesignSelectors, ...jwtSecretSelectors] },
  },
  // the signer keeps every other rule of the block above
  {
    files: [JWT_SECRET_SIGNER],
    rules: { "no-restricted-syntax": ["error", ...readAndDesignSelectors] },
  },
  // FXC-08 (the service key) and IMP-04 (the person's token): one rule, so the two allow-lists are judged together
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: serviceKeyAllowList.ignores,
    rules: { "no-restricted-imports": ["error", { patterns: [serviceKeyPattern, tokenSourcePattern] }] },
  },
  // the service key's allowed files still may not make the person's token, but for the worker itself
  {
    files: serviceKeyAllowList.ignores.filter((file) => file !== BACKGROUND_WORKER),
    rules: { "no-restricted-imports": ["error", { patterns: [tokenSourcePattern] }] },
  },
  // OPS-06: server code logs only through the structured logger (src/lib/log.ts). A browser file that must write to the
  // browser's console says so with an eslint-disable comment and its reason.
  {
    files: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.js", "src/**/*.mjs"],
    ignores: ["src/lib/log.ts"],
    rules: {
      "no-console": "error",
      "no-restricted-globals": ["error", { name: "console", message: "Log through src/lib/log.ts (OPS-06)." }],
      "no-restricted-properties": [
        "error",
        { object: "process", property: "stdout", message: "Log through src/lib/log.ts (OPS-06)." },
        { object: "process", property: "stderr", message: "Log through src/lib/log.ts (OPS-06)." },
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
