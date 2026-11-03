import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import filledCases from "../unit/fixtures/message-filled-problems.json";
import cases from "../unit/fixtures/message-template-problems.json";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");

/** MSG-02 follow-up, owner (90) ג: what a service template may hold, checked before every send. */
describe("service template rule (MSG-02)", () => {
  let owner: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("svc-rule-owner");
    org = await createOrg(owner.id);
  });

  it("app.message_template_problem answers the shared fixture like the TS rule", async () => {
    for (const c of cases) {
      const got = await asAdmin(
        async (q) =>
          (
            await q<{ p: string | null }>("select app.message_template_problem($1, $2, $3, $4, $5, $6) as p", [
              c.channel,
              c.messageType,
              c.subject,
              c.body,
              ("ownDomain" in c ? c.ownDomain : null) ?? null,
              ("businessEmail" in c ? c.businessEmail : null) ?? null,
            ])
          ).rows[0].p,
      );
      expect(got, c.note).toBe(c.problem);
    }
  });

  it("no API role may call the rule or the sender gate", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ role: string; f: string; ok: boolean }>(
            `select r.role, f.f, has_function_privilege(r.role, f.f, 'execute') as ok
               from unnest(array['anon', 'authenticated', 'service_role']) as r(role),
                    unnest(array['app.message_template_problem(text, text, text, text, text, text)', 'app.message_template_sendable(uuid, uuid)',
                                 'app.message_template_problem(text, text, text, text, text)',
                                 'app.message_external_link(text, text)', 'app.message_link_tld(text)',
                                 'app.message_ascii_lower(text)', 'app.message_plain_email(text)', 'app.message_local_host(text)', 'app.message_token_link(text, text, text)',
                                 'app.message_type_fields(text)', 'app.message_service_body_max(text)',
                                 'app.message_template_problem_021160_retired(text, text, text, text)',
                                 'app.message_external_link(text, text, text)', 'app.message_domain_suffix(text)',
                                 'app.message_part_link(text, text)', 'app.message_token_link(text, text)',
                                 'app.message_authority_link(text, text)', 'app.message_own_domain_ok(text)',
                                 'app.message_under_shared_host(text)', 'app.message_shared_site_host(text)',
                                 'app.message_url_shortener(text)', 'app.message_file_extension(text)',
                                 'app.message_platform_domain(text)', 'app.message_website_ok(text)',
                                 'app.message_host_own(text, text)', 'app.message_filled_problem(text, text, text, text)',
                                 'app.message_marketing_body_max(text)', 'app.organizations_website_check()',
                                 'app.message_send_refusal_text(text)', 'app.message_send_refused(uuid, uuid, text)']) as f(f)`,
          )
        ).rows,
    );
    expect(rows.filter((r) => r.ok)).toEqual([]);
  });

  it("saving is never refused; the sender gate says why", async () => {
    let n = 0;
    const insert = (type: string, body: string, active = true) =>
      asUser(
        owner.id,
        async (q) =>
          (
            await q<{ id: string }>(
              "insert into public.message_templates (organization_id, name, channel, message_type, body, is_active) values ($1, $2, 'sms', $3, $4, $5) returning id",
              [org, `תבנית ${(n += 1)}`, type, body, active],
            )
          ).rows[0].id,
      );
    const gate = (id: string, orgId = org) =>
      asAdmin(async (q) => (await q<{ p: string | null }>("select app.message_template_sendable($1, $2) as p", [orgId, id])).rows[0].p);
    expect(await gate(await insert("collection", "שלום {שם פרטי}, {סכום}"))).toBeNull();
    expect(await gate(await insert("collection", "בתאריך {תאריך}"))).toBe("field_not_allowed");
    expect(await gate(await insert("collection", "שלמו ב-https://pay.example.com"))).toBe("external_link");
    expect(await gate(await insert("collection", "א".repeat(301)))).toBe("too_long");
    expect(await gate(await insert("marketing", "מבצע https://shop.example.com"))).toBeNull();
    expect(await gate(await insert("collection", "שלום", false))).toBe("inactive");
    // another business's template is not found
    const other = await createOrg(owner.id, "עסק אחר");
    expect(await gate(await insert("collection", "שלום {שם העסק}"), other)).toBe("not_found");
  });

  it("changing a template's type is recorded in the audit log, old and new", async () => {
    const id = await asUser(
      owner.id,
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, 'סוג משתנה', 'sms', 'marketing', 'שלום') returning id",
            [org],
          )
        ).rows[0].id,
    );
    await asUser(owner.id, (q) => q("update public.message_templates set message_type = 'collection' where id = $1", [id]));
    const changes = await asAdmin(
      async (q) =>
        (
          await q<{ c: Record<string, unknown> }>(
            "select changes as c from public.audit_log where entity_type = 'message_templates' and entity_id = $1 and action = 'update'",
            [id],
          )
        ).rows,
    );
    expect(changes).toHaveLength(1);
    expect(JSON.stringify(changes[0].c.message_type)).toContain("marketing");
    expect(JSON.stringify(changes[0].c.message_type)).toContain("collection");
  });

  it("the full rules take the own domain and the business email last; 021160's forms stay as wrappers", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ args: string }>(
            `select pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'app' and p.proname = 'message_template_problem'`,
          )
        ).rows,
    );
    expect(rows.map((r) => r.args).sort()).toEqual([
      "p_channel text, p_message_type text, p_subject text, p_body text, p_own_domain text",
      "p_channel text, p_message_type text, p_subject text, p_body text, p_own_domain text, p_business_email text",
    ]);
    const links = await asAdmin(
      async (q) =>
        (
          await q<{ args: string }>(
            `select pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'app' and p.proname = 'message_external_link'`,
          )
        ).rows,
    );
    expect(links.map((r) => r.args).sort()).toEqual(["p_text text, p_own_domain text", "p_text text, p_own_domain text, p_business_email text"]);
    // the wrappers pass no business email; every call form resolves to one function
    const answers = await asAdmin(
      async (q) =>
        (
          await q<{ a: boolean; b: boolean; c: boolean; d: string | null; e: string | null; f: string | null }>(
            `select app.message_external_link('a@gmail.com') as a, app.message_external_link('a@gmail.com', null) as b,
                    app.message_external_link('a@gmail.com', null, 'a@gmail.com') as c,
                    app.message_template_problem('sms', 'collection', null, 'a@gmail.com') as d,
                    app.message_template_problem('sms', 'collection', null, 'a@gmail.com', null) as e,
                    app.message_template_problem('sms', 'collection', null, 'a@gmail.com', null, 'a@gmail.com') as f`,
          )
        ).rows[0],
    );
    expect(answers).toEqual({ a: true, b: true, c: false, d: "external_link", e: "external_link", f: null });
  });

  it("app.message_filled_problem answers the shared fixture like the TS rule (owner (96))", async () => {
    for (const c of filledCases) {
      const got = await asAdmin(
        async (q) =>
          (
            await q<{ p: string | null }>("select app.message_filled_problem($1, $2, $3, $4) as p", [
              c.channel,
              c.messageType,
              c.subject,
              c.body,
            ])
          ).rows[0].p,
      );
      expect(got, c.note).toBe(c.problem);
    }
  });

  it("owner (98) א: a verification code holds only the business name and the code", async () => {
    const fields = await asAdmin(
      async (q) => (await q<{ f: string[] }>("select app.message_type_fields('verification_code') as f")).rows[0].f,
    );
    expect(fields).toEqual(["שם העסק", "קוד אימות"]);
  });

  it("the business's website: owners write it on the business, a bad or shared one is refused, and the gate allows its domain (owners (97), (104), (105))", async () => {
    const own = await createUser("svc-site-owner");
    const siteOrg = await createOrg(own.id, "עסק עם אתר");
    const template = await asUser(
      own.id,
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, 'עם אתר', 'sms', 'collection', 'פרטים ב-biz.co.il') returning id",
            [siteOrg],
          )
        ).rows[0].id,
    );
    const gate = (orgId = siteOrg, id = template) =>
      asAdmin(async (q) => (await q<{ p: string | null }>("select app.message_template_sendable($1, $2) as p", [orgId, id])).rows[0].p);
    expect(await gate()).toBe("external_link");
    const setSite = (site: string) => asUser(own.id, (q) => q("update public.organizations set website = $1 where id = $2", [site, siteOrg]));
    for (const bad of [
      "לא אתר",
      "co.il",
      "bit.ly",
      "https://wixsite.com",
      "gmail.com",
      "x".repeat(290) + ".co.il",
      "javascript:alert(1)",
      "ftp://biz.co.il",
      "data:text/html,x",
      "facebook.com/mybiz",
      "shop.google.com",
    ]) {
      const refused = await pgError(setSite(bad));
      expect([refused.code, refused.hint], bad).toEqual(["23514", "org:website"]);
    }
    await setSite("https://www.Shop.Biz.co.il/about");
    // the registered domain and its hosts (owner (105))
    expect(await gate()).toBeNull();
    // a member may not write it
    const member = await addMember(siteOrg, own.id, "member", "svc-site-member");
    expect(
      await asUser(member.id, async (q) => (await q("update public.organizations set website = 'other.co.il' where id = $1 returning id", [siteOrg])).rowCount),
    ).toBe(0);
    // another business's website does not allow it
    const other = await createOrg(own.id, "עסק בלי אתר");
    const otherTemplate = await asUser(
      own.id,
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, 'עם אתר', 'sms', 'collection', 'פרטים ב-biz.co.il') returning id",
            [other],
          )
        ).rows[0].id,
    );
    expect(await gate(other, otherTemplate)).toBe("external_link");
  });

  it("owner (111) ב: the gate allows the business's own email from its business details, and an address on its own domain", async () => {
    const own = await createUser("svc-email-owner");
    const mailOrg = await createOrg(own.id, "עסק עם אימייל");
    const template = (body: string) =>
      asUser(
        own.id,
        async (q) =>
          (
            await q<{ id: string }>(
              "insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, $2, 'sms', 'collection', $3) returning id",
              [mailOrg, `אימייל ${randomUUID().slice(0, 8)}`, body],
            )
          ).rows[0].id,
      );
    const gate = (id: string) =>
      asAdmin(async (q) => (await q<{ p: string | null }>("select app.message_template_sendable($1, $2) as p", [mailOrg, id])).rows[0].p);
    const gmail = await template("לשאלות: Biz.Office@gmail.com");
    const onSite = await template("לשאלות: info@biz.co.il");
    const other = await template("לשאלות: other@gmail.com");
    expect([await gate(gmail), await gate(onSite), await gate(other)]).toEqual(["external_link", "external_link", "external_link"]);
    await asAdmin((q) =>
      q(
        "insert into public.org_document_settings (organization_id, email) values ($1, 'biz.office@gmail.com') on conflict (organization_id) do update set email = excluded.email",
        [mailOrg],
      ),
    );
    await asUser(own.id, (q) => q("update public.organizations set website = 'biz.co.il' where id = $1", [mailOrg]));
    expect([await gate(gmail), await gate(onSite), await gate(other)]).toEqual([null, null, "external_link"]);
    // review of 7fe2fa4 (1): an email the constraint accepts but that is shaped like a link never hides it
    const shaped = await template("לשאלות: https://evil.com/x@y.co");
    await asAdmin((q) => q("update public.org_document_settings set email = 'https://evil.com/x@y.co' where organization_id = $1", [mailOrg]));
    expect([await gate(shaped), await gate(gmail)]).toEqual(["external_link", "external_link"]);
    // owner (110) ב: a word.word pair is no longer a link; a listed ending is
    expect(await gate(await template("נפגש עם Mr.Cohen ב-St.Louis"))).toBeNull();
    expect(await gate(await template("ראו a.shop"))).toBe("external_link");
  });

  it("app.message_send_refused tells active owners and admins once a day per template and reason, never raises", async () => {
    const own = await createUser("svc-refused-owner");
    const refusedOrg = await createOrg(own.id, "עסק שהודעה שלו נעצרה");
    const admin = await addMember(refusedOrg, own.id, "admin", "svc-refused-admin");
    const member = await addMember(refusedOrg, own.id, "member", "svc-refused-member");
    const template = await asUser(
      own.id,
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, 'תזכורת ארוכה', 'sms', 'collection', 'שלום {שם פרטי}') returning id",
            [refusedOrg],
          )
        ).rows[0].id,
    );
    const refuse = (reason: string, orgId = refusedOrg, id: string | null = template) =>
      asAdmin(async (q) => (await q<{ n: number }>("select app.message_send_refused($1, $2, $3) as n", [orgId, id, reason])).rows[0].n);
    expect(await refuse("too_long")).toBe(2);
    // once a day, even after it was read; another reason is its own notice
    await asAdmin((q) => q("update public.notifications set read_at = now() where entity_id = $1", [template]));
    expect(await refuse("too_long")).toBe(0);
    expect(await refuse("external_link")).toBe(2);
    expect(await refuse("not_a_reason")).toBe(0);
    // the next business day it is told again
    await asAdmin((q) =>
      q("update app.message_refusal_notices set notified_on = notified_on - 1 where organization_id = $1 and template_key = $2 and reason = 'too_long'", [
        refusedOrg,
        template,
      ]),
    );
    expect(await refuse("too_long")).toBe(2);
    // no template, or another business's: told without a name, once a day
    const other = await createOrg(own.id, "עסק שלישי");
    expect(await refuse("too_long", refusedOrg, null)).toBe(2);
    expect(await refuse("too_long", refusedOrg, null)).toBe(0);
    expect(await refuse("too_long", other, template)).toBe(1);
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ user_id: string; type: string; title: string; body: string }>(
            "select user_id, type, title, body from public.notifications where organization_id = $1 and entity_type = 'message_template' and entity_id = $2",
            [refusedOrg, template],
          )
        ).rows,
    );
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([own.id, admin.id]));
    expect(rows.some((r) => r.user_id === member.id)).toBe(false);
    expect(rows.every((r) => r.type === "system" && r.title === "הודעה ללקוח לא נשלחה")).toBe(true);
    expect(rows.filter((r) => r.body.includes("ארוכה מדי"))).toHaveLength(4);
    expect(rows[0].body).toContain('"תזכורת ארוכה"');
    const unnamed = await asAdmin(
      async (q) =>
        (
          await q<{ body: string }>(
            "select body from public.notifications where organization_id = $1 and entity_type = 'message_template' and entity_id is null",
            [other],
          )
        ).rows,
    );
    expect(unnamed).toHaveLength(1);
    expect(unnamed[0].body).not.toContain("תזכורת ארוכה");
  });

  it("(103): a too-long failure of a queued message tells the owners and admins, once per template a day; a provider's code does not", async () => {
    const own = await createUser("svc-queue-owner");
    const queueOrg = await createOrg(own.id, "עסק עם תור");
    const tpl = (name: string) =>
      asUser(
        own.id,
        async (q) =>
          (
            await q<{ id: string }>(
              "insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, $2, 'sms', 'collection', 'שלום') returning id",
              [queueOrg, name],
            )
          ).rows[0].id,
      );
    const first = await tpl("תור ראשון");
    const second = await tpl("תור שני");
    const job = (template: string) =>
      asAdmin(
        async (q) =>
          (
            await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2, null) as id", [
              queueOrg,
              JSON.stringify({ channel: "sms", lead_id: randomUUID(), message_type: "collection", template_id: template }),
            ])
          ).rows[0].id,
      );
    const fail = (id: string, provider: string | null) =>
      asAdmin((q) =>
        q("update app.jobs set status = 'dead', provider = $2, provider_error_code = 'too_long', message_outcome = 'failed' where id = $1", [id, provider]),
      );
    const notices = (template: string) =>
      asAdmin(
        async (q) =>
          (await q<{ n: number }>("select count(*)::int as n from public.notifications where organization_id = $1 and entity_id = $2", [queueOrg, template]))
            .rows[0].n,
      );
    await fail(await job(first), null);
    expect(await notices(first)).toBe(1);
    await fail(await job(first), null);
    expect(await notices(first)).toBe(1);
    // a provider's error code that reads the same is not the system's refusal
    await fail(await job(second), "fake");
    expect(await notices(second)).toBe(0);
    // the payload's template_id is a uuid or nothing
    const ok = (payload: Record<string, unknown>) =>
      asAdmin(async (q) => (await q<{ ok: boolean }>("select app.job_payload_ok('message.send', $1) as ok", [JSON.stringify(payload)])).rows[0].ok);
    const base = { channel: "sms", lead_id: randomUUID(), message_type: "collection" };
    expect(await ok({ ...base, template_id: first })).toBe(true);
    expect(await ok({ ...base, template_id: "x" })).toBe(false);
    expect(await ok({ ...base, template_id: 5 })).toBe(false);
  });

  it("re-running 021159, 021160 and 021161 leaves one current rule and every old one without grants", async () => {
    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith("_service_template_rule.sql") || f.endsWith("_service_message_send_rules.sql") || f.endsWith("_message_link_tlds.sql"))
      .sort();
    expect(files).toHaveLength(3);
    const answer = await pgError(
      asAdmin(async (q) => {
        for (const f of files) await q(readFileSync(join(MIGRATIONS, f), "utf8"));
        const rows = (
          await q<{ name: string; args: string; g: boolean }>(
            `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
                    has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute') as g
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'app' and (p.proname like 'message_template_problem%' or p.proname like 'message_external_link%') order by 1`,
          )
        ).rows;
        throw new Error(JSON.stringify(rows));
      }),
    );
    const rows = JSON.parse(answer.message) as { name: string; args: string; g: boolean }[];
    expect(rows.map((r) => r.name)).toEqual([
      "message_external_link",
      "message_external_link",
      "message_template_problem",
      "message_template_problem",
      "message_template_problem_021160_retired",
      "message_template_problem_021160_retired_2",
    ]);
    expect(rows.filter((r) => r.args.includes("p_business_email")).map((r) => r.name)).toEqual(["message_external_link", "message_template_problem"]);
    expect(rows.some((r) => r.g)).toBe(false);
  });
});
