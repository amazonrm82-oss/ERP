@AGENTS.md

# CRM SaaS — project guide for Claude Code

A multi-tenant CRM sold per seat to Israeli small and mid-size businesses. Hebrew, RTL.
Every customer ("organization") signs up alone, picks a plan and adds employees under it.

- Full product spec (Hebrew): `docs/SPEC.md`
- What is built and what comes next: `docs/BACKLOG.md`
- Decisions and open questions: `docs/DECISIONS.md`
- Full QA plan (Hebrew): `docs/QA-PLAN.md` — a separate phase that starts only after the whole
  backlog is built and the owner says to start. Do not run it during the build.

## Hard safety rules — read before doing anything

This is a **new, standalone project**. The owner runs other live systems and they must not be affected.

**History of this repository.** It is `amazonrm82-oss/ERP`. Until 6 October 2026 it held a different
application (a Vite + React ERP with its own Supabase project). The owner asked to remove that code
and build this CRM here instead. The old code is preserved on the branch
`backup/erp-before-crm-2026-10-06` — never delete or rewrite that branch.

1. **Work only in this repository.** Never read, clone, modify or push to any other repository of the
   owner (`arizot-crm-web`, `machon-managers`, `hapak300`, `MEXUZ`).
2. **Use a brand-new Supabase project and a brand-new Vercel project for this app.** Do not reuse
   URLs, keys or env vars from any other project — including the Supabase project the old ERP used.
   These migrations assume an **empty `public` schema**: the old ERP has its own `profiles`,
   customers and leads tables that clash with ours, and migration `…000400_rls.sql` revokes client
   grants on *all* tables in `public`. Before applying migrations to any hosted database, list its
   existing tables; if `public` is not empty, stop and ask the owner.
3. **Destructive database commands need the owner's explicit go-ahead in the current conversation**,
   and only after printing the target project ref and having it confirmed:
   `supabase db push`, `supabase db reset`, `supabase link`, any `drop`/`truncate`, any manual SQL on a
   hosted database.
4. **Database tests run only against the local throwaway database.** `tests/db/helpers.ts` refuses any
   host that is not local and any database whose name does not end in `_test`. Do not weaken that guard.
   `tests/db/supabase-shim.sql` is test-only and must never be run on a real Supabase project.
5. **No secrets in the repo.** Only `.env.example` is committed. The service-role key is never used in
   browser code and never in code that handles a user request on the user's behalf. It has two uses
   (`src/lib/supabase/service.ts`): the lead intake (`src/features/intake/`), which calls
   `public.intake_submit()` and reads a form's public display settings; and the push dispatcher
   (`src/features/notifications/push-server.ts`, route `/api/push/dispatch`, called by the database
   with a shared secret), which calls `public.claim_push_notifications()` and reads/deletes
   `push_subscriptions`.
6. If something looks like it belongs to another system, stop and ask.

## Stack

- Next.js 16 (App Router, `src/`), React 19, TypeScript strict, Tailwind v4. Note `src/proxy.ts` (the
  Next 16 name for middleware). Read `node_modules/next/dist/docs/` before using Next APIs.
- Supabase: Postgres with Row Level Security, Auth, later Realtime and Storage. `@supabase/ssr`.
- Hosting target: Vercel. Database tests: Vitest + `pg` against a local PostgreSQL 16.

## Commands

```bash
npm run dev            # app on localhost (needs .env.local, see .env.example)
npm run lint
npm run typecheck
npm run build

npm run db:test:start  # start a throwaway local PostgreSQL on 127.0.0.1:54329
npm run test:db        # rebuild crm_saas_test from the migrations and run all database tests
npm run db:test:stop
npm run test:e2e       # browser flow; needs `npx supabase start` (Docker) + `npm run dev` on the local stack
node scripts/policy-mutation-sweep.mjs   # slow; proves the tests catch every weakened policy
```

All four of `lint`, `typecheck`, `build`, `test:db` must pass before a change is called done.

## Architecture rules

### Tenancy and security (the part that must never break)

- One shared database. Every business table has `organization_id uuid not null` and a
  `unique (organization_id, id)`. References between business tables are **composite foreign keys**
  `(organization_id, x_id)`, so a row can never point into another organization.
- Isolation is enforced by **RLS in the database**, not by application code. The app still adds
  `.eq("organization_id", orgId)` to every query, for clarity and index use.
- Access helpers live in schema `app` (not exposed by the API): `app.is_member`, `app.is_admin`,
  `app.can_write`, `app.can_read_record`, `app.can_edit_record`, `app.can_delete_record`,
  `app.org_writable`, `app.org_limit`, `app.org_has_feature`.
- Roles: `owner`, `admin`, `manager`, `member`, `viewer`. Record visibility per organization:
  `org` | `team` | `own`. Members edit what they own; managers their teams' records; admins everything.
  Deleting (recycle bin) is for admins and team managers; purging is admin-only.
- Things only the server may change (organization status, subscription, counters, audit log, outbox)
  are protected by **missing grants / column-level grants**, not by policies.
- Operations that span tables or need elevated rights are **RPC functions in `public`**
  (`create_organization`, `create_invitation`, `accept_invitation`, `transfer_ownership`,
  `convert_lead`, `run_automation_now`; `intake_submit` and `claim_push_notifications` are granted to
  `service_role` only). They are `security definer`, pin `search_path = ''`, and check permissions first.
- The automation engine lives in the database (migration 0009): `app.process_outbox()` every minute and
  `app.run_scheduled_automations()` every 15 minutes, scheduled with pg_cron. Every id inside a rule's
  JSON is re-checked against the rule's organization when it runs. Changes made by an automation are
  marked `payload.origin = 'automation'` in the outbox and do not trigger automations.
- Notifications (migration 0010): `notifications` is in the `supabase_realtime` publication (the bell
  subscribes with the user's token, RLS filters). pg_cron job `crm-notifications` runs every minute:
  `app.send_task_reminders()` then `app.dispatch_push()`, which pings the app through pg_net using
  `app.settings` (`push_dispatch_url`, `push_dispatch_secret`), filled in by hand per environment.
  `push_subscriptions` is per user (no `organization_id`); `user_id` is set from the session by trigger.
- Reports (migration 0011) are `public.report_*` functions, **security invoker** on purpose: RLS decides
  what is counted. Do not make them security definer. They return jsonb; `src/features/reports/build.ts`
  shapes it into tables for the screen and the CSV export.
- A trigger function that must tell a browser write from a server write uses `current_user` and is
  therefore **security invoker**. Inside a `security definer` function `current_user` is the owner.
- PL/pgSQL gotcha that already bit this project twice: `new.some_column` raises when the firing table
  has no such column, even inside an `if` for another table. Nest the reference under its own `if`,
  or write one function per table.

### Checklist for every new table (the tests enforce most of it)

1. `organization_id` + `unique (organization_id, id)` + composite FKs to other tenant tables.
2. `alter table … enable row level security`.
3. `revoke all … from anon, authenticated`, then grant only what a client needs (column-level for
   updates when some columns are server-only).
4. Policies for select / insert / update / delete, each one carrying the tenant check **itself**
   (an `UPDATE`/`DELETE` without `WHERE` is filtered by its own policy only).
5. `touch_row` trigger; audit trigger if the table is configuration or business data; `emit_event`
   trigger if automations should react to it.
6. Add the table to `tests/db/02-tenant-isolation.test.ts` (read, no-op update, delete, insert, and
   the "no WHERE clause" test) and add role tests to `03-roles-and-visibility.test.ts`.
7. Update `src/lib/database.types.ts` — `07-app-types-match-schema.test.ts` fails until it matches.
8. Run `node scripts/policy-mutation-sweep.mjs <table>`; it must report 0 missed.

New functions: `revoke all … from public, anon` and grant to `authenticated` explicitly. Supabase
grants new objects in `public` to `anon` by default; the tests fail if a migration forgets to take
that back.

### Migrations

- `supabase/migrations/<timestamp>_<name>.sql`, applied in name order. Never edit a migration that
  has been applied to a hosted project; add a new one. 0001–0005 are applied to the hosted project.
  The owner applies new migrations by hand in the SQL Editor; code that depends on a migration is
  pushed to `main` (which deploys) only after the owner confirms it ran. Hand them over in parts:
  `node scripts/split-for-sql-editor.mjs <migration>` (a longer paste was cut off at ~4,000 chars and
  0010 ran half way). Prefer statements that are safe to run twice, so a failed part can be rerun.
- Money is integer agorot + currency code. Times are `timestamptz` (UTC), shown in the organization's
  time zone (default `Asia/Jerusalem`). Phones are stored as typed plus `phone_e164` (set by trigger).
- Plan limits and feature flags live in `plans.limits` / `plans.features`, with per-organization
  overrides on `subscriptions`. Limit errors use SQLSTATE `P0001` with `hint = 'limit:<key>'` or
  `'feature:<key>'`; the app maps hints to Hebrew messages in `src/lib/errors.ts`.

### Application code

- Server Components by default. Mutations are Server Actions: validate with zod, call Supabase with
  the user's session, return `{ ok: true } | { ok: false, message }`, then `revalidatePath`.
- Feature folders: `src/features/<area>/{queries,actions,schema}.ts` + `components/`.
  Shared primitives in `src/components/ui/`. No PostgREST embedding so far; lookups are fetched
  separately and joined in code.
- An update blocked by RLS returns zero rows and no error: always select the id back and treat
  "0 rows" as "deleted or not permitted".
- All user-facing text is Hebrew, short and plain. Code, identifiers, comments: English.
- RTL: logical properties only (`ps-`, `pe-`, `ms-`, `me-`, `start-`, `end-`, `text-start`). Phones
  and emails render with `dir="ltr"`. Every screen must work at 360px width.
- Accessibility target: WCAG 2.0 AA (Israeli standard IS 5568). Labels on inputs, visible focus,
  keyboard reachable, contrast.

## What has and has not been verified (as of the first commit)

Verified:
- The five migrations apply cleanly to PostgreSQL 16.
- 65 database tests pass: tenant isolation on every table and verb, roles and visibility, invitations,
  seats, plan limits, read-only lifecycle, lead conversion, audit log, outbox, notifications, and that
  `database.types.ts` matches the schema.
- Weakening any of the 80 non-trivial RLS policies to "allow all" makes the tests fail.
- `lint`, `typecheck` and `build` pass. Login/signup screens were looked at in a browser at 1280px
  and 360px.
- The CI workflow (`.github/workflows/ci.yml`) passed on GitHub for the first push: lint, typecheck,
  database tests against a `postgres:16` service, and build.

Verified on 6 October 2026:
- All migrations apply on a real (local, Docker) Supabase stack, and the whole flow passes there in a
  real browser: `tests/e2e/main-flow.mjs`.
- The owner ran migrations 0001–0005 on the hosted project (`eowuxxkiedpjrqvfqcgn`).

Not verified yet:
- The flow on the hosted project and the live site (`https://erp-3yft.vercel.app`).
- Performance of the per-row access functions on large tables.

## Working agreement

- Take the next item from `docs/BACKLOG.md` unless told otherwise. Keep changes small and reviewable.
- When a decision is the owner's (pricing, legal wording, which payment provider), ask; do not guess
  silently. Record the answer in `docs/DECISIONS.md`.
- Say plainly what was tested and what was not.
