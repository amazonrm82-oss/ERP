import { afterAll, describe, expect, it } from "vitest";

import { asAdmin, closePool } from "./helpers";

afterAll(closePool);

// CAP-11, owner 8 November 2026, answer (145) א: the Meta webhook keeps its three service-role functions, on conditions:
// meta_lead_receive writes ids only; meta_lead_claim answers only what making the lead needs (arrival, lease, the Meta lead
// id, the business and connection ids the envelope is bound to, and the page token's envelope); meta_lead_finish makes the
// lead through public.intake_submit. Their md5 (body, security definer, settings and arguments, as test 284 pins the OPS-04
// functions) is pinned here as reviewed. A change to any of them fails this test until it gets a fresh independent review
// against those conditions; only then is the md5 below updated, with a line saying what was rechecked.
// Review of 8 November 2026 (finding 1, page squatting): re-pinned after verified_at, the page fan-out in receive, the page id
// in claim's answer, and verification with eviction in finish; the app helpers the three call are pinned too.
// Re-review (N1-N3): re-pinned after the ended-connection rule (app.meta_lead_connection_open) in receive and claim, the
// verified-first order of receive, finish's lock order (page lock, then its own row skip locked) and token_invalid keeping
// the arrivals; end_connection now skips rows another transaction holds.
const REVIEWED_MD5: Record<string, string> = {
  "public.meta_lead_claim": "c82b03ef48e6520bdf4e6e1c80f1de32",
  "public.meta_lead_finish": "494fc5576fc6932426dcac1903fb0e63",
  "public.meta_lead_receive": "b75e59d41a3beb6507bf9cdaf20eabcc",
};
const REVIEWED_HELPER_MD5: Record<string, string> = {
  "app.meta_lead_connection_open": "04567294c34d5ee389d6fcfad5d6cb94",
  "app.meta_lead_end_connection": "6d4ef95d544935edba225dcf3c908d51",
  "app.meta_lead_retry_at": "74f98a85cdcfc3868174dcc4887531e7",
  "app.meta_lead_source": "0dc01d98131c91816e5043d9fc7a3f21",
  "app.meta_lead_text": "e292e8feccc1d34f9eeedbd5cf2c39f9",
};
// Third review, R2: these three carry the page-ownership rule (only a VERIFIED live connection takes a page, the going-live
// check, the secret save's lock order). A change needs a fresh review against review finding 1 and N1-N2.
const REVIEWED_OWNERSHIP_MD5: Record<string, string> = {
  "app.integration_page_taken": "4238ceb0a268c9f6fdcfc5be73d06497",
  "app.integrations_check": "cb1449612233fea234ac86ba829d1517",
  "public.integration_secret_set": "ce21bf64ac5578e0f00ecafd0cc2d6f7",
};

describe("Meta Lead Ads functions are pinned (CAP-11, owner (145) א)", () => {
  it("the three service-role functions are the reviewed ones, definer, search_path '' and service_role only", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; md5: string; definer: boolean; config: string[] | null; anon: boolean; authenticated: boolean; service: boolean }>(
            `select n.nspname || '.' || p.proname as name,
                    md5(p.prosrc || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_function_identity_arguments(p.oid)) as md5,
                    p.prosecdef as definer, p.proconfig as config,
                    has_function_privilege('anon', p.oid, 'execute') as anon,
                    has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
                    has_function_privilege('service_role', p.oid, 'execute') as service
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('meta_lead_receive', 'meta_lead_claim', 'meta_lead_finish')
              order by 1`,
          )
        ).rows,
    );
    expect(Object.fromEntries(rows.map((r) => [r.name, r.md5]))).toEqual(REVIEWED_MD5);
    for (const row of rows) {
      expect(row, row.name).toMatchObject({ definer: true, config: ["search_path=\"\""], anon: false, authenticated: false, service: true });
    }
  });

  it("the app helpers they call are the reviewed ones, and no API role may call them", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; md5: string; anon: boolean; authenticated: boolean; service: boolean }>(
            `select n.nspname || '.' || p.proname as name,
                    md5(p.prosrc || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_function_identity_arguments(p.oid)) as md5,
                    has_function_privilege('anon', p.oid, 'execute') as anon,
                    has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
                    has_function_privilege('service_role', p.oid, 'execute') as service
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'app' and p.proname in ('meta_lead_connection_open', 'meta_lead_end_connection', 'meta_lead_retry_at', 'meta_lead_source', 'meta_lead_text')
              order by 1`,
          )
        ).rows,
    );
    expect(Object.fromEntries(rows.map((r) => [r.name, r.md5]))).toEqual(REVIEWED_HELPER_MD5);
    for (const row of rows) expect(row, row.name).toMatchObject({ anon: false, authenticated: false, service: false });
  });

  it("the page-ownership functions are the reviewed ones", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; md5: string }>(
            `select n.nspname || '.' || p.proname as name,
                    md5(p.prosrc || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_function_identity_arguments(p.oid)) as md5
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname = 'app' and p.proname in ('integration_page_taken', 'integrations_check'))
                 or (n.nspname = 'public' and p.proname = 'integration_secret_set')
              order by 1`,
          )
        ).rows,
    );
    expect(Object.fromEntries(rows.map((r) => [r.name, r.md5]))).toEqual(REVIEWED_OWNERSHIP_MD5);
  });

  it("finish reaches the lead only through intake_submit; receive writes the arrivals only", async () => {
    const src = await asAdmin(async (q) =>
      Object.fromEntries(
        (
          await q<{ name: string; src: string }>(
            "select p.proname as name, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('meta_lead_receive', 'meta_lead_finish')",
          )
        ).rows.map((r) => [r.name, r.src]),
      ),
    );
    expect(src.meta_lead_finish).toContain("public.intake_submit(v_token, 'meta'");
    expect(src.meta_lead_finish).not.toMatch(/insert into public\.leads/);
    expect([...src.meta_lead_receive.matchAll(/insert into ([a-z_.]+)/g)].map((m) => m[1]).sort()).toEqual(["app.meta_lead_arrivals", "app.meta_lead_receive_counts"]);
  });
});
