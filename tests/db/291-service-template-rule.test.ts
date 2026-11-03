import { afterAll, beforeAll, describe, expect, it } from "vitest";

import cases from "../unit/fixtures/message-template-problems.json";
import { asAdmin, asUser, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

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
            await q<{ p: string | null }>("select app.message_template_problem($1, $2, $3, $4) as p", [
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

  it("no API role may call the rule or the sender gate", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ role: string; f: string; ok: boolean }>(
            `select r.role, f.f, has_function_privilege(r.role, f.f, 'execute') as ok
               from unnest(array['anon', 'authenticated', 'service_role']) as r(role),
                    unnest(array['app.message_template_problem(text, text, text, text)', 'app.message_template_sendable(uuid, uuid)',
                                 'app.message_type_fields(text)', 'app.message_service_body_max(text)']) as f(f)`,
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
});
