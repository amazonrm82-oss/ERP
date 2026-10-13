import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

const RETENTION = readFileSync(join(process.cwd(), "supabase/migrations/20261006009100_submission_retention.sql"), "utf8");
const PURGE = readFileSync(join(process.cwd(), "supabase/migrations/20261006009110_submission_retention_purge.sql"), "utf8");

type U = { id: string; email: string };

const submit = (token: string, payload: Record<string, unknown>, ipHash: string) =>
  asService(async (q) => {
    const res = await q<{ result: { status: string; lead_id?: string } }>(
      "select public.intake_submit($1, 'form', $2, $3) as result",
      [token, JSON.stringify(payload), ipHash],
    );
    return res.rows[0].result;
  });

const newForm = (userId: string, org: string, name: string) =>
  asUser(userId, async (q) =>
    (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name) values ($1, $2) returning id, token", [org, name])).rows[0],
  );

const purge = () => asAdmin(async (q) => (await q<{ n: number }>("select app.purge_old_form_submissions() as n")).rows[0].n);

type Sub = { id: string; form_id: string | null; form_name: string | null; form_deleted_at: Date | null; lead_id: string | null };
const subsOfLeads = (leadIds: string[]) =>
  asAdmin(async (q) =>
    (
      await q<Sub>("select id, form_id, form_name, form_deleted_at, lead_id from public.form_submissions where lead_id = any ($1) order by created_at", [leadIds])
    ).rows,
  );

// CAP-04 (owner's decision of 12 October 2026): inquiries of a deleted form are kept 12 months, then removed;
// their leads stay.
describe("inquiries of a deleted form are kept 12 months (CAP-04)", () => {
  let owner: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("ret-owner");
    org = await createOrg(owner.id);
    // 52-keep-submissions re-runs 0062, which puts back the old trigger function; this migration
    // must be safe to run again anyway
    await asAdmin((q) => q(RETENTION));
  });

  it("the connector-applied migration holds no drop statement and no delete, the purge file only its function", () => {
    const statements = RETENTION.replace(/--.*$/gm, "").split(";").map((part) => part.trim().toLowerCase());
    expect(statements.filter((part) => part.startsWith("drop"))).toEqual([]);
    expect(RETENTION).not.toMatch(/delete\s+from/i);
    expect(RETENTION).toContain("'45 2 * * *'");
    expect(RETENTION).toContain("select app.purge_old_form_submissions();");
    const purgeCode = PURGE.replace(/--.*$/gm, "");
    expect(purgeCode.match(/create or replace function/gi)).toHaveLength(1);
    expect(purgeCode).not.toMatch(/cron\.|alter table|create (table|index|trigger)/i);
  });

  it("deleting a form stamps when it went, on its rows only", async () => {
    const form = await newForm(owner.id, org, "טופס שמירה");
    const live = await newForm(owner.id, org, "טופס חי");
    const a = await submit(form.token, { full_name: "אבי", phone: "050-2000001" }, "ip-1");
    const b = await submit(live.token, { full_name: "בת", phone: "050-2000002" }, "ip-2");
    const t0 = Date.now();
    await asUser(owner.id, (q) => q("delete from public.forms where id = $1", [form.id]));
    const [kept] = await subsOfLeads([a.lead_id!]);
    expect(kept.form_id).toBeNull();
    expect(kept.form_name).toBe("טופס שמירה");
    expect(kept.form_deleted_at).not.toBeNull();
    expect(Math.abs(kept.form_deleted_at!.getTime() - t0)).toBeLessThan(60_000);
    const [other] = await subsOfLeads([b.lead_id!]);
    expect(other.form_id).toBe(live.id);
    expect(other.form_deleted_at).toBeNull();
  });

  it("removes rows kept longer than 12 months, keeps the rest and every lead, and runs twice harmlessly", async () => {
    const form = await newForm(owner.id, org, "טופס ישן");
    const live = await newForm(owner.id, org, "טופס פעיל");
    const old = await submit(form.token, { full_name: "ותיק", phone: "050-3000001" }, "ip-3");
    const recent = await submit(form.token, { full_name: "חדש", phone: "050-3000002" }, "ip-4");
    const onLive = await submit(live.token, { full_name: "פעיל", phone: "050-3000003" }, "ip-5");
    await asUser(owner.id, (q) => q("delete from public.forms where id = $1", [form.id]));

    await asAdmin(async (q) => {
      await q("update public.form_submissions set form_deleted_at = now() - interval '12 months' - interval '1 day' where lead_id = $1", [old.lead_id]);
      await q("update public.form_submissions set form_deleted_at = now() - interval '12 months' + interval '1 day' where lead_id = $1", [recent.lead_id]);
      // a live form's row is never removed, whatever its column says
      await q("update public.form_submissions set form_deleted_at = now() - interval '5 years' where lead_id = $1", [onLive.lead_id]);
    });
    const leadIds = [old.lead_id!, recent.lead_id!, onLive.lead_id!];
    const leadsBefore = await asAdmin(async (q) =>
      (await q("select id, updated_at, deleted_at, status_id, owner_id from public.leads where id = any ($1) order by id", [leadIds])).rows,
    );

    expect(await purge()).toBeGreaterThanOrEqual(1);
    const left = await subsOfLeads(leadIds);
    expect(left.map((s) => s.lead_id).sort()).toEqual([recent.lead_id, onLive.lead_id].sort());

    // the leads are all still there, unchanged
    const leadsAfter = await asAdmin(async (q) =>
      (await q("select id, updated_at, deleted_at, status_id, owner_id from public.leads where id = any ($1) order by id", [leadIds])).rows,
    );
    expect(leadsAfter).toEqual(leadsBefore);

    // the second run removes nothing more of ours
    const before = await asAdmin((q) => count(q, "select 1 from public.form_submissions where organization_id = $1", [org]));
    expect(await purge()).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.form_submissions where organization_id = $1", [org]))).toBe(before);
  });

  it("rows kept before the migration start their 12 months when it runs; stamped rows keep their date", async () => {
    const form = await newForm(owner.id, org, "טופס מלפני");
    const sub = await submit(form.token, { full_name: "מלפני", phone: "050-4000001" }, "ip-6");
    const other = await submit(form.token, { full_name: "חתום", phone: "050-4000002" }, "ip-7");
    await asUser(owner.id, (q) => q("delete from public.forms where id = $1", [form.id]));
    const stamped = new Date("2026-03-01T00:00:00Z");
    await asAdmin(async (q) => {
      // as left by 0062: kept, but no deletion date
      await q("update public.form_submissions set form_deleted_at = null where lead_id = $1", [sub.lead_id]);
      await q("update public.form_submissions set form_deleted_at = $2 where lead_id = $1", [other.lead_id, stamped]);
    });
    const t0 = Date.now();
    await asAdmin((q) => q(RETENTION));
    const [s] = await subsOfLeads([sub.lead_id!]);
    expect(s.form_deleted_at).not.toBeNull();
    expect(Math.abs(s.form_deleted_at!.getTime() - t0)).toBeLessThan(60_000);
    const [o] = await subsOfLeads([other.lead_id!]);
    expect(o.form_deleted_at!.toISOString()).toBe(stamped.toISOString());
    // a fresh stamp is not removed
    await purge();
    expect(await subsOfLeads([sub.lead_id!])).toHaveLength(1);
  });

  it("no client may run the removal, and clients cannot write the new column", async () => {
    // thunks: each call starts only when awaited, so a refusal is never an unhandled rejection
    for (const run of [
      () => asUser(owner.id, (q) => q("select app.purge_old_form_submissions()")),
      () => asService((q) => q("select app.purge_old_form_submissions()")),
    ]) {
      expect((await pgError(run())).code).toBe("42501");
    }
    const err = await pgError(asUser(owner.id, (q) => q("update public.form_submissions set form_deleted_at = null where organization_id = $1", [org])));
    expect(err.code).toBe("42501");
    // admins read it like the other columns
    const n = await asUser(owner.id, (q) => count(q, "select 1 from public.form_submissions where organization_id = $1 and form_deleted_at is not null", [org]));
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("the purge file can run twice", async () => {
    await asAdmin((q) => q(PURGE));
    await asAdmin((q) => q(PURGE));
    const sec = await asAdmin(async (q) =>
      (await q<{ prosecdef: boolean; proconfig: string[] }>("select prosecdef, proconfig from pg_proc where oid = 'app.purge_old_form_submissions()'::regprocedure")).rows[0],
    );
    expect(sec).toEqual({ prosecdef: true, proconfig: ['search_path=""'] });
  });
});
