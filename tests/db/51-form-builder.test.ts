import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asService, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type Reply = { status: string; lead_id?: string };

// CAP-01: the form builder. Fields of a form: built-in or custom (cf:<key>),
// required, help text, and "show only when" another field has a value.
describe("form builder: custom fields, help text and conditions (CAP-01)", () => {
  let owner: { id: string };
  let org: string;
  let otherOrg: string;
  let form: { id: string; token: string };

  const define = (orgId: string, key: string, type: string, options: string[] = [], active = true) =>
    asAdmin((q) =>
      q("insert into public.field_definitions (organization_id, object_type, key, label, field_type, options, is_active, help_text) values ($1, 'lead', $2, $2, $3, $4, $5, $6)", [
        orgId,
        key,
        type,
        JSON.stringify(options),
        active,
        key === "budget" ? "בשקלים" : null,
      ]),
    );
  const setFields = (fields: unknown) => asUser(owner.id, (q) => q("update public.forms set fields = $2 where id = $1", [form.id, JSON.stringify(fields)]));
  const submit = (payload: Record<string, unknown>, token = form.token) =>
    asService(async (q) => (await q<{ r: Reply }>("select public.intake_submit($1, 'form', $2) as r", [token, JSON.stringify(payload)])).rows[0].r);
  const customOf = (leadId: string) =>
    asAdmin(async (q) => (await q<{ c: Record<string, unknown> }>("select custom_fields as c from public.leads where id = $1", [leadId])).rows[0].c);
  const intakeForm = (token: string) =>
    asService(async (q) => (await q<{ r: Record<string, unknown> | null }>("select public.intake_form($1) as r", [token])).rows[0].r);

  const FIELDS = [
    { key: "full_name", required: true, help: "שם פרטי ומשפחה" },
    { key: "phone", required: false },
    { key: "cf:service", required: true },
    { key: "cf:budget", required: true, show_if: { field: "cf:service", value: "שיפוץ" } },
    { key: "cf:extras", required: false, show_if: { field: "cf:service", value: null } },
    { key: "message", required: true, show_if: { field: "cf:extras", value: "גג" } },
  ];

  beforeAll(async () => {
    owner = await createUser("fb-owner");
    org = await createOrg(owner.id);
    const other = await createUser("fb-other");
    otherOrg = await createOrg(other.id);
    await define(org, "service", "select", ["שיפוץ", "ניקיון"]);
    await define(org, "budget", "currency");
    await define(org, "extras", "multi_select", ["חלונות", "גג"]);
    await define(org, "agree", "checkbox");
    await define(org, "assignee", "user");
    await define(org, "old", "text", [], false);
    // the same key in another business, as text: never used for this form
    await define(otherOrg, "secret", "text");
    await asUser(owner.id, async (q) => {
      form = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name, title) values ($1, 'בונה', 'בקשת הצעה') returning id, token", [org])).rows[0];
    });
    await setFields(FIELDS);
  });

  it("intake_form gives the hosted form its display settings, with the custom fields' labels, types and choices", async () => {
    const shown = await intakeForm(form.token);
    expect(shown).toMatchObject({ title: "בקשת הצעה", intro: null, submit_label: null });
    const fields = (shown!.fields as Array<Record<string, unknown>>).map((f) => [f.key, f.type ?? null, f.required, f.help ?? null]);
    expect(fields).toEqual([
      ["full_name", null, true, "שם פרטי ומשפחה"],
      ["phone", null, false, null],
      ["cf:service", "select", true, null],
      ["cf:budget", "currency", true, "בשקלים"],
      ["cf:extras", "multi_select", false, null],
      ["message", null, true, null],
    ]);
    expect((shown!.fields as Array<Record<string, unknown>>)[2]).toMatchObject({ label: "service", options: ["שיפוץ", "ניקיון"] });
    // inactive, "user" and unknown fields are not shown
    await setFields([{ key: "phone" }, { key: "cf:old" }, { key: "cf:assignee" }, { key: "cf:secret" }]);
    expect(((await intakeForm(form.token))!.fields as Array<Record<string, unknown>>).map((f) => f.key)).toEqual(["phone"]);
    await setFields(FIELDS);
    // wrong token, webhook token, inactive form: nothing
    expect(await intakeForm("0".repeat(32))).toBeNull();
    await asUser(owner.id, (q) => q("update public.forms set is_active = false where id = $1", [form.id]));
    expect(await intakeForm(form.token)).toBeNull();
    await asUser(owner.id, (q) => q("update public.forms set is_active = true where id = $1", [form.id]));
  });

  it("custom values of shown fields land on the new lead, typed and checked", async () => {
    // extras has גג, so the message is shown and required
    expect((await pgError(submit({ full_name: "דנה", phone: "052-8100001", custom: { service: "שיפוץ", budget: 150000, extras: ["גג"] } }))).message).toBe(
      "required field missing: message",
    );
    const r = await submit({ full_name: "דנה", phone: "052-8100001", message: "גם הגג", custom: { service: "שיפוץ", budget: 150000, extras: ["גג"] } });
    expect(r.status).toBe("accepted");
    expect(await customOf(r.lead_id!)).toEqual({ service: "שיפוץ", budget: 150000, extras: ["גג"] });
  });

  it("a hidden field is not required and loses what was sent for it", async () => {
    const r = await submit({ full_name: "יוסי", phone: "052-8100002", message: "נשלח בלי תנאי", custom: { service: "ניקיון", budget: 5 } });
    expect(r.status).toBe("accepted");
    // budget only for שיפוץ; message only when extras has גג
    expect(await customOf(r.lead_id!)).toEqual({ service: "ניקיון" });
    const message = await asAdmin(async (q) => (await q<{ m: string | null }>("select message as m from public.leads where id = $1", [r.lead_id])).rows[0].m);
    expect(message).toBeNull();
  });

  it("a shown required field must have a value, conditional ones only when shown", async () => {
    expect((await pgError(submit({ full_name: "חסר", phone: "052-8100003", custom: {} }))).message).toBe("required field missing: cf:service");
    const missing = await pgError(submit({ full_name: "חסר", phone: "052-8100003", custom: { service: "שיפוץ" } }));
    expect(missing).toMatchObject({ code: "22023", message: "required field missing: cf:budget" });
    // blank text, false and an empty list are no value
    await setFields([{ key: "email", required: true }, { key: "cf:agree", required: true }, { key: "cf:extras", required: true }]);
    expect((await pgError(submit({ email: "a@b.co", custom: { agree: false, extras: ["גג"] } }))).message).toBe("required field missing: cf:agree");
    expect((await pgError(submit({ email: "a@b.co", custom: { agree: true, extras: [] } }))).message).toBe("required field missing: cf:extras");
    await setFields(FIELDS);
  });

  it("a wrong value is refused; unknown keys, other businesses' fields and fields not on the form are dropped", async () => {
    const bad = await pgError(submit({ full_name: "רע", phone: "052-8100004", custom: { service: "אחר" } }));
    expect(bad).toMatchObject({ code: "22023", message: "invalid custom field: service" });
    expect((await pgError(submit({ full_name: "רע", phone: "052-8100004", custom: { service: "שיפוץ", budget: "הרבה" } }))).message).toBe(
      "invalid custom field: budget",
    );
    const r = await submit({
      full_name: "נקי",
      phone: "052-8100005",
      custom: { service: "ניקיון", agree: true, secret: "x", old: "x", assignee: owner.id, "$merge": { service: "x" }, nope: 1 },
    });
    expect(await customOf(r.lead_id!)).toEqual({ service: "ניקיון" });
    // not an object at all
    expect((await pgError(submit({ full_name: "פשוט", phone: "052-8100006", custom: "service=שיפוץ" }))).message).toBe("required field missing: cf:service");
  });

  it("a condition on a choice of a multiple choice, and on 'has any value'", async () => {
    await setFields([
      { key: "phone", required: true },
      { key: "cf:extras" },
      { key: "cf:service", required: true, show_if: { field: "cf:extras", value: "גג" } },
      { key: "cf:agree", required: true, show_if: { field: "phone" } },
    ]);
    // extras without גג: service is hidden, so not required; agree is shown (phone has a value)
    expect((await pgError(submit({ phone: "052-8100007", custom: { extras: ["חלונות"] } }))).message).toBe("required field missing: cf:agree");
    const r = await submit({ phone: "052-8100007", custom: { extras: ["חלונות"], agree: true, service: "שיפוץ" } });
    expect(await customOf(r.lead_id!)).toEqual({ extras: ["חלונות"], agree: true });
    expect((await pgError(submit({ phone: "052-8100008", custom: { extras: ["גג"], agree: true } }))).message).toBe("required field missing: cf:service");
    await setFields(FIELDS);
  });

  it("a hidden name/phone/email does not count as a way back to the person", async () => {
    await setFields([{ key: "cf:agree" }, { key: "phone", show_if: { field: "cf:agree" } }, { key: "email" }]);
    expect((await pgError(submit({ phone: "052-8100009", custom: {} }))).message).toBe("a name, phone or email is required");
    const r = await submit({ phone: "052-8100009", custom: { agree: true } });
    expect(r.status).toBe("accepted");
    await setFields(FIELDS);
  });

  it("a repeat inquiry leaves the lead's custom fields alone and keeps the new values on the inquiry", async () => {
    const first = await submit({ full_name: "חוזרת", phone: "052-8100010", custom: { service: "ניקיון" } });
    const again = await submit({ full_name: "חוזרת", phone: "052-8100010", custom: { service: "שיפוץ", budget: 900 } });
    expect(again).toMatchObject({ status: "duplicate", lead_id: first.lead_id });
    expect(await customOf(first.lead_id!)).toEqual({ service: "ניקיון" });
    const meta = await asAdmin(async (q) =>
      (await q<{ metadata: Record<string, unknown> }>("select metadata from public.activities where lead_id = $1 and type = 'inquiry'", [first.lead_id])).rows[0].metadata,
    );
    expect(meta.custom_fields).toEqual({ service: "שיפוץ", budget: 900 });
  });

  it("the submission log still keeps only the five fields", async () => {
    await submit({ full_name: "לוג", phone: "052-8100011", custom: { service: "ניקיון" } });
    const payload = await asAdmin(async (q) =>
      (await q<{ payload: Record<string, unknown> }>("select payload from public.form_submissions where form_id = $1 order by created_at desc limit 1", [form.id])).rows[0].payload,
    );
    expect(payload).toEqual({ full_name: "לוג", phone: "052-8100011" });
  });

  it("webhooks take no custom values", async () => {
    const hook = await asUser(owner.id, async (q) =>
      (await q<{ token: string }>("insert into public.forms (organization_id, kind, name) values ($1, 'webhook', 'הוק') returning token", [org])).rows[0],
    );
    const r = await asService(async (q) =>
      (await q<{ r: Reply }>("select public.intake_submit($1, 'webhook', $2) as r", [hook.token, JSON.stringify({ email: "hook@example.com", custom: { service: "שיפוץ" } })])).rows[0].r,
    );
    expect(await customOf(r.lead_id!)).toEqual({});
  });

  it("forms.fields must have the builder's shape", async () => {
    const write = (fields: unknown) => pgError(setFields(fields));
    const bad: unknown[] = [
      {},
      [{ key: "password" }],
      [{ key: "cf:Bad" }],
      [{ key: "phone" }, { key: "phone" }],
      [{ key: "phone", required: "yes" }],
      [{ key: "phone", help: "x".repeat(301) }],
      [{ key: "phone", other: 1 }],
      [{ key: "phone", show_if: { field: "email" } }, { key: "email" }],
      [{ key: "phone", show_if: { field: "phone" } }],
      [{ key: "email" }, { key: "phone", show_if: { field: "email", value: "" } }],
      [{ key: "email" }, { key: "phone", show_if: { field: "email", value: 3 } }],
      [{ key: "email" }, { key: "phone", show_if: { field: "email", extra: 1 } }],
      Array.from({ length: 41 }, (_, i) => ({ key: `cf:f${i}` })),
    ];
    for (const fields of bad) {
      expect((await write(fields)).code, JSON.stringify(fields).slice(0, 80)).toBe("23514");
    }
    await setFields([{ key: "email", required: true, help: null, show_if: null }, { key: "phone", show_if: { field: "email", value: null } }]);
    await setFields(FIELDS);
  });

  it("the new functions are closed to clients (the shape check runs for whoever saves a form); intake_form is for the service role only", async () => {
    const grants = await asAdmin(async (q) =>
      (
        await q<{ fn: string; anon: boolean; auth: boolean; service: boolean }>(
          `select p.oid::regprocedure::text as fn,
                  has_function_privilege('anon', p.oid, 'execute') as anon,
                  has_function_privilege('authenticated', p.oid, 'execute') as auth,
                  has_function_privilege('service_role', p.oid, 'execute') as service
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname, p.proname) in (('app', 'form_fields_ok'), ('app', 'intake_has_value'), ('app', 'intake_condition_met'),
                                             ('public', 'intake_form'), ('public', 'intake_submit'))
            order by 1`,
        )
      ).rows,
    );
    expect(grants).toEqual([
      { fn: "app.form_fields_ok(jsonb)", anon: false, auth: true, service: true },
      { fn: "app.intake_condition_met(jsonb,text)", anon: false, auth: false, service: false },
      { fn: "app.intake_has_value(jsonb)", anon: false, auth: false, service: false },
      { fn: "intake_form(text)", anon: false, auth: false, service: true },
      { fn: "intake_submit(text,text,jsonb,text,text,boolean)", anon: false, auth: false, service: true },
    ]);
    expect((await pgError(asUser(owner.id, (q) => q("select public.intake_form($1)", [form.token])))).code).toBe("42501");
  });
});
