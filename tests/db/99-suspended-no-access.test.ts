import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXPORT_TABLES } from "../../src/features/imports/export-build";
import { addMember, asAdmin, asMfaUser, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError } from "./helpers";

// BIL-08/BIL-09 (owner, 13 October 2026): a suspended business has no access until payment.
// The data is kept, public forms keep taking leads, and the owner may download the full export.
afterAll(async () => {
  await asAdmin((q) => q("delete from app.platform_staff where user_id = any($1)", [staffIds]));
  await closePool();
});

type U = { id: string; email: string };
const staffIds: string[] = [];

const setStatus = (org: string, status: string) => asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));

/** Every public table with organization_id that clients may select from at all. */
const orgTables = () =>
  asAdmin(async (q) =>
    (
      await q<{ t: string }>(
        `select c.relname as t
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
          where c.relkind = 'r'
            and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
            and has_any_column_privilege('authenticated', c.oid, 'SELECT')
          order by 1`,
      )
    ).rows.map((r) => r.t),
  );

/** How many rows of the business each table shows this user (table -> count). */
const visible = (userId: string, org: string, tables: string[], mfa = false) =>
  (mfa ? asMfaUser : asUser)(userId, async (q) => {
    const out: Record<string, number> = {};
    for (const t of tables) out[t] = await count(q, `select 1 from public.${t} where organization_id = $1`, [org]);
    return out;
  });

const submit = (token: string, name: string, phone: string) =>
  asService(async (q) => {
    const res = await q<{ result: { status: string; lead_id?: string } }>(
      "select public.intake_submit($1, 'form', $2, null, null, false) as result",
      [token, JSON.stringify({ full_name: name, phone })],
    );
    return res.rows[0].result;
  });

describe("a suspended business: no access until payment", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, support: U;
  let org: string;
  let tables: string[];
  let form: { id: string; token: string };
  let ownerActive: Record<string, number>;

  beforeAll(async () => {
    owner = await createUser("susp-owner");
    org = await createOrg(owner.id, "עסק מושהה");
    admin = await addMember(org, owner.id, "admin", "susp-admin");
    manager = await addMember(org, owner.id, "manager", "susp-manager");
    member = await addMember(org, owner.id, "member", "susp-member");
    viewer = await addMember(org, owner.id, "viewer", "susp-viewer");
    support = await createUser("susp-support");
    staffIds.push(support.id);
    await asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, 'support') on conflict (user_id) do update set role = excluded.role", [support.id]));
    await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));

    // business data of every common kind, made by the member (so every role reads it while active)
    const lead = await insertLead(member.id, org, { full_name: "דנה ברק", phone: "050-1112233" });
    const { pipelineId, stages } = await defaultPipeline(org);
    await asUser(member.id, async (q) => {
      const company = (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'חברת ענן') returning id", [org])).rows[0].id;
      const contact = (
        await q<{ id: string }>("insert into public.contacts (organization_id, first_name, last_name, company_id) values ($1, 'רות', 'לוי', $2) returning id", [org, company])
      ).rows[0].id;
      await q("insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'עסקה', $2, $3, $4)", [org, pipelineId, stages[0].id, contact]);
      await q("insert into public.tasks (organization_id, title, lead_id) values ($1, 'להתקשר', $2)", [org, lead]);
      await q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'שיחה ראשונה', $2)", [org, lead]);
      await q("insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id) values ($1, 'פגישה', now() + interval '1 day', now() + interval '1 day 1 hour', $2)", [org, lead]);
      await q("insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'הצעה.pdf', 'application/pdf', 1000)", [org, lead]);
      await q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'granted', 'manual', 'בשיחה')", [org, lead]);
      await q("insert into public.saved_views (organization_id, object_type, name, scope, owner_id) values ($1, 'lead', 'שלי', 'private', $2)", [org, member.id]);
    });
    await asUser(owner.id, async (q) => {
      await q("insert into public.products (organization_id, name, sku, price_agorot) values ($1, 'מוצר', 'P-1', 10000)", [org]);
      form = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name) values ($1, 'טופס באתר') returning id, token", [org])).rows[0];
    });
    // a notification each, from while the business worked
    await asAdmin((q) =>
      q("insert into public.notifications (organization_id, user_id, type, title) select $1, m.user_id, 'system', 'ברוכים הבאים' from public.memberships m where m.organization_id = $1", [org]),
    );
    tables = await orgTables();
    ownerActive = await visible(owner.id, org, tables);
  });

  it("while active, every role reads the business's data", async () => {
    for (const who of [admin, manager, member, viewer]) {
      const seen = await visible(who.id, org, ["leads", "contacts", "companies", "deals", "tasks", "activities", "meetings", "memberships", "notifications"]);
      for (const [t, n] of Object.entries(seen)) expect(n, `${who.email} ${t}`).toBeGreaterThan(0);
    }
  });

  it("suspended: admins, managers, members and viewers read nothing of the business, in any table", async () => {
    await setStatus(org, "suspended");
    expect(tables.length).toBeGreaterThan(40);
    for (const who of [admin, manager, member, viewer]) {
      const seen = await visible(who.id, org, tables);
      expect(Object.entries(seen).filter(([, n]) => n > 0), who.email).toEqual([]);
      await asUser(who.id, async (q) => {
        // the organization row, the plan, colleagues' profiles: closed too
        expect(await count(q, "select 1 from public.organizations where id = $1", [org])).toBe(0);
        expect(await count(q, "select 1 from public.profiles where id = $1", [owner.id])).toBe(0);
        expect(await count(q, "select 1 from public.saved_views where organization_id = $1", [org])).toBe(0);
        expect((await q<{ r: { org: unknown; membership: unknown; subscription: unknown } }>("select public.org_context($1) as r", [org])).rows[0].r).toMatchObject({
          org: null,
          membership: null,
          subscription: null,
        });
        // the helpers every policy and function asks
        const h = (await q<{ m: boolean; r: string | null; c: boolean }>("select app.is_member($1) as m, app.role_in($1)::text as r, app.can_read_record($1, $2, null) as c", [org, who.id])).rows[0];
        expect(h).toEqual({ m: false, r: null, c: false });
        // the record completeness keys (0157) follow the same rule
        expect((await q<{ k: string[] | null }>("select app.completeness_keys($1, 'lead') as k", [org])).rows[0].k).toBeNull();
        // their own profile stays readable
        expect(await count(q, "select 1 from public.profiles where id = $1", [who.id])).toBe(1);
      });
    }
  });

  it("suspended: the app learns from closed_orgs() that access is closed, and nothing more", async () => {
    const closed = await asUser(member.id, async (q) => (await q<{ r: Array<Record<string, string>> }>("select public.closed_orgs() as r")).rows[0].r);
    expect(closed).toEqual([{ id: org, name: "עסק מושהה", status: "suspended", role: "member" }]);
    // the owner is not closed out; a stranger has nothing
    expect(await asUser(owner.id, async (q) => (await q<{ r: unknown[] }>("select public.closed_orgs() as r")).rows[0].r)).toEqual([]);
    const stranger = await createUser("susp-stranger");
    expect(await asUser(stranger.id, async (q) => (await q<{ r: unknown[] }>("select public.closed_orgs() as r")).rows[0].r)).toEqual([]);
    // a suspended membership is not listed
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, viewer.id]));
    expect(await asUser(viewer.id, async (q) => (await q<{ r: unknown[] }>("select public.closed_orgs() as r")).rows[0].r)).toEqual([]);
    await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, viewer.id]));
  });

  it("suspended: the owner reads what the full export needs, and still cannot write", async () => {
    const ownerSuspended = await visible(owner.id, org, tables);
    for (const t of EXPORT_TABLES) expect(ownerSuspended[t.table], t.table).toBe(ownerActive[t.table]);
    await asUser(owner.id, async (q) => {
      expect(await count(q, "select 1 from public.memberships where organization_id = $1", [org])).toBe(5);
      expect(await count(q, "select 1 from public.profiles where id = any($1)", [[admin.id, manager.id, member.id, viewer.id]])).toBe(4);
      const ctx = (await q<{ r: { org: { status: string }; membership: { role: string } } }>("select public.org_context($1) as r", [org])).rows[0].r;
      expect(ctx.org.status).toBe("suspended");
      expect(ctx.membership.role).toBe("owner");
      expect((await q<{ k: string[] | null }>("select app.completeness_keys($1, 'lead') as k", [org])).rows[0].k).not.toBeNull();
      // the full export is logged with the owner's session
      await q("select public.log_export($1, 'full', null, 12)", [org]);
    });
    const write = await pgError(asUser(owner.id, (q) => q("insert into public.tags (organization_id, name) values ($1, 'x')", [org])));
    expect(write.code).toBe("42501");
  });

  it("suspended: platform support in a customer-approved session still reads, to help", async () => {
    await asAdmin((q) => q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [org]));
    expect(await asMfaUser(support.id, (q) => count(q, "select 1 from public.leads where organization_id = $1", [org]))).toBeGreaterThan(0);
    await asAdmin((q) => q("update public.support_access_grants set revoked_at = now() where organization_id = $1", [org]));
  });

  it("suspended: notifications are kept from everyone but the owner, and only system notices are stored", async () => {
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.notifications where organization_id = $1", [org]))).toBe(0);
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.notifications where organization_id = $1", [org]))).toBe(1);
    await asAdmin((q) =>
      q(
        `insert into public.notifications (organization_id, user_id, type, title) values
           ($1, $2, 'system', 'לבעלים'), ($1, $2, 'lead_new', 'ליד חדש'), ($1, $3, 'system', 'למנהל'), ($1, $4, 'lead_new', 'ליד חדש')`,
        [org, owner.id, admin.id, member.id],
      ),
    );
    const stored = await asAdmin(
      async (q) => (await q<{ t: string }>("select title as t from public.notifications where organization_id = $1 and title <> 'ברוכים הבאים' order by 1", [org])).rows.map((r) => r.t),
    );
    expect(stored).toEqual(["לבעלים"]);
  });

  it("suspended: public forms keep taking leads, without telling anyone", async () => {
    const before = await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1", [org]));
    const result = await submit(form.token, "ליד ברקע", "052-7778801");
    expect(result.status).toBe("accepted");
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and full_name = 'ליד ברקע'", [org]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1", [org]))).toBe(before);
    // the member still sees none of it
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.leads where organization_id = $1", [org]))).toBe(0);
  });

  it("read-only: every role still reads, and forms take leads; cancelled: closed, and forms stop", async () => {
    await setStatus(org, "read_only");
    for (const who of [admin, manager, member, viewer]) {
      expect(await asUser(who.id, (q) => count(q, "select 1 from public.leads where organization_id = $1", [org])), who.email).toBeGreaterThan(0);
      expect(await asUser(who.id, (q) => count(q, "select 1 from public.notifications where organization_id = $1", [org])), who.email).toBeGreaterThan(0);
    }
    expect((await submit(form.token, "ליד בקריאה בלבד", "052-7778802")).status).toBe("accepted");

    await setStatus(org, "cancelled");
    const seen = await visible(member.id, org, tables);
    expect(Object.entries(seen).filter(([, n]) => n > 0)).toEqual([]);
    expect((await pgError(submit(form.token, "ליד אחרי ביטול", "052-7778803"))).hint).toBe("org:read_only");
  });

  it("back to active: everything is there again, the leads that came in meanwhile included", async () => {
    await setStatus(org, "active");
    for (const who of [admin, manager, member, viewer]) {
      const seen = await visible(who.id, org, ["leads", "contacts", "companies", "deals", "tasks", "activities", "meetings", "memberships", "notifications"]);
      for (const [t, n] of Object.entries(seen)) expect(n, `${who.email} ${t}`).toBeGreaterThan(0);
      expect(await asUser(who.id, (q) => count(q, "select 1 from public.leads where organization_id = $1 and full_name in ('ליד ברקע', 'ליד בקריאה בלבד')", [org]))).toBe(2);
    }
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.saved_views where organization_id = $1", [org]))).toBe(1);
    expect(await asUser(member.id, async (q) => (await q<{ r: unknown[] }>("select public.closed_orgs() as r")).rows[0].r)).toEqual([]);
  });
});
