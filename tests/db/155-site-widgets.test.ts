import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Answer = Record<string, unknown>;

/**
 * SPD-07: the floating button for a business's own website, in the approved pattern for public secret-link pages (owner,
 * 13 October 2026): the script gets public display settings only, no cookies or visitor id, only the page and the campaign
 * keys are kept, the form goes through intake_submit, rate limits, nothing beyond what is needed is returned and no
 * business reaches another's widget or leads.
 */
describe("site widgets (SPD-07)", () => {
  let owner: U, admin: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let widget: { id: string; token: string };
  let hashSeq = 0;
  const hash = () => `sw-${process.pid}-${++hashSeq}`.padStart(64, "0");

  const makeWidget = (who: U, values: Record<string, unknown> = {}, o: string = org) =>
    asUser(who.id, async (q) => {
      const row: Record<string, unknown> = { organization_id: o, name: "האתר", ...values };
      const cols = Object.keys(row);
      return (
        await q<{ id: string; token: string }>(
          `insert into public.site_widgets (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id, token`,
          Object.values(row),
        )
      ).rows[0];
    });
  const view = (token: string, ipHash: string | null = null) =>
    asService(async (q) => (await q<{ r: Answer }>("select public.site_widget_public($1, $2) as r", [token, ipHash])).rows[0].r);
  const submit = (token: string, payload: Record<string, unknown>, ipHash: string | null = hash(), spam = false) =>
    asService(async (q) =>
      (await q<{ r: Answer }>("select public.site_widget_submit($1, $2, $3, 'test', $4) as r", [token, JSON.stringify(payload), ipHash, spam])).rows[0].r,
    );
  const widgetForm = (widgetId: string) =>
    asAdmin(async (q) =>
      (
        await q<{ id: string; token: string; kind: string; name: string; assign_mode: string; owner_id: string | null; source: string; source_kind: string }>(
          `select f.id, f.token, f.kind, f.name, f.assign_mode, f.owner_id, s.name as source, s.kind as source_kind
             from public.forms f join public.lead_sources s on s.organization_id = f.organization_id and s.id = f.source_id
            where f.site_widget_id = $1`,
          [widgetId],
        )
      ).rows[0],
    );
  // a sender whose view bucket on this widget holds no views yet (the database's own bucket rule)
  const freshSender = async (widgetId: string): Promise<string> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = hash();
      const used = await asAdmin(async (q) =>
        (
          await q<{ used: boolean }>(
            `select exists (select 1 from app.site_widget_view_counts c
                             where c.widget_id = $1
                               and c.bucket = ((hashtextextended(app.site_widget_sender($1, $2), 0) % 1024) + 1024) % 1024) as used`,
            [widgetId, candidate],
          )
        ).rows[0].used,
      );
      if (!used) return candidate;
    }
    throw new Error("no free view bucket found");
  };

  beforeAll(async () => {
    owner = await createUser("sw-owner");
    org = await createOrg(owner.id, "עסק הכפתורים");
    admin = await addMember(org, owner.id, "admin", "sw-admin");
    member = await addMember(org, owner.id, "member", "sw-member");
    viewer = await addMember(org, owner.id, "viewer", "sw-viewer");
    outsider = await createUser("sw-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await asAdmin(async (q) => {
      await q("update public.organizations set phone = '03-5551234' where id = $1", [org]);
      await q(`update public.subscriptions set limit_overrides = '{"max_site_widgets": 20}' where organization_id = $1`, [org]);
    });
    widget = await makeWidget(owner, { name: "האתר הראשי", button_label: "צרו קשר", assign_mode: "owner", owner_id: member.id });
  });

  it("a widget comes with its own form: source 'כפתור באתר' (made once), its owner and assignment, kept in step", async () => {
    const form = await widgetForm(widget.id);
    expect(form).toMatchObject({ kind: "widget", name: "כפתור באתר: האתר הראשי", assign_mode: "owner", owner_id: member.id, source: "כפתור באתר", source_kind: "site_widget" });
    const second = await makeWidget(admin, { name: "דף נחיתה" });
    expect(await widgetForm(second.id)).toMatchObject({ assign_mode: "round_robin", owner_id: null, source: "כפתור באתר" });
    expect(await asAdmin((q) => count(q, "select 1 from public.lead_sources where organization_id = $1 and kind = 'site_widget'", [org]))).toBe(1);
    await asUser(admin.id, (q) => q("update public.site_widgets set name = 'דף נחיתה חדש', assign_mode = 'owner', owner_id = $2 where id = $1", [second.id, admin.id]));
    expect(await widgetForm(second.id)).toMatchObject({ name: "כפתור באתר: דף נחיתה חדש", assign_mode: "owner", owner_id: admin.id });
    // the leads go to an active member who is not a viewer
    expect(await pgError(makeWidget(owner, { assign_mode: "owner", owner_id: viewer.id }))).toMatchObject({ code: "P0001", hint: "site_widget:owner" });
  });

  it("a widget form is made and changed only by its widget; it is not a web form", async () => {
    const form = await widgetForm(widget.id);
    expect(
      await pgError(asUser(owner.id, (q) => q("insert into public.forms (organization_id, kind, name) values ($1, 'widget', 'מזויף')", [org]))),
    ).toMatchObject({ hint: "form:widget" });
    expect(await pgError(asUser(owner.id, (q) => q("update public.forms set owner_id = null where id = $1", [form.id])))).toMatchObject({ hint: "form:widget" });
    expect(await pgError(asUser(owner.id, (q) => q("delete from public.forms where id = $1", [form.id])))).toMatchObject({ hint: "form:widget" });
    // not served as a web form, and its token is refused as one
    const asForm = await asService(async (q) => (await q<{ r: Answer | null }>("select public.intake_form($1) as r", [form.token])).rows[0].r);
    expect(asForm === null || (asForm as Answer).inactive === true || Object.keys(asForm as Answer).length === 0).toBe(true);
    expect(
      (await pgError(asService((q) => q("select public.intake_submit($1, 'form', $2)", [form.token, JSON.stringify({ full_name: "x", phone: "050-1111111" })])))).code,
    ).toBe("P0002");
    // a widget form does not count against max_forms
    await asAdmin((q) => q(`update public.subscriptions set limit_overrides = '{"max_forms": 0, "max_site_widgets": 20}' where organization_id = $1`, [org]));
    try {
      const extra = await makeWidget(owner, { name: "בלי טפסים" });
      expect((await widgetForm(extra.id)).kind).toBe("widget");
      // removing the widget removes its form
      await asUser(owner.id, (q) => q("delete from public.site_widgets where id = $1", [extra.id]));
      expect(await asAdmin((q) => count(q, "select 1 from public.forms where site_widget_id = $1", [extra.id]))).toBe(0);
    } finally {
      await asAdmin((q) => q(`update public.subscriptions set limit_overrides = '{"max_site_widgets": 20}' where organization_id = $1`, [org]));
    }
  });

  it("the public answer holds the display settings only: no ids, tokens, owner or counts", async () => {
    const answer = await view(widget.token);
    expect(answer).toEqual({
      label: "צרו קשר",
      position: "left",
      business: "עסק הכפתורים",
      brand: {},
      built_with: expect.any(Boolean),
      whatsapp: "97235551234",
      call: "+97235551234",
      form: true,
    });
    const text = JSON.stringify(answer);
    for (const secret of [widget.id, widget.token, org, member.id, (await widgetForm(widget.id)).token]) expect(text).not.toContain(secret);
    // the widget's own number wins; buttons that are off are left out; an unusable number shows neither
    const own = await makeWidget(owner, { name: "מספר אחר", phone: "052-7654321", show_call: false, position: "right" });
    expect(await view(own.token)).toMatchObject({ whatsapp: "972527654321", position: "right" });
    expect(await view(own.token)).not.toHaveProperty("call");
    const noWhatsapp = await makeWidget(owner, { name: "בלי WhatsApp", show_whatsapp: false });
    expect(await view(noWhatsapp.token)).not.toHaveProperty("whatsapp");
    expect(await view(noWhatsapp.token)).toHaveProperty("call", "+97235551234");
    const bad = await makeWidget(owner, { name: "מספר שגוי", phone: "123" });
    const badAnswer = await view(bad.token);
    expect(badAnswer).not.toHaveProperty("whatsapp");
    expect(badAnswer).not.toHaveProperty("call");
    const noForm = await makeWidget(owner, { name: "בלי טופס", show_form: false });
    expect((await view(noForm.token)).form).toBe(false);
    expect((await pgError(submit(noForm.token, { full_name: "x", phone: "050-1111111" }))).code).toBe("P0002");
  });

  it("not found: unknown token, a widget switched off, no plan flag, a closed or deleted business", async () => {
    expect((await pgError(view("0".repeat(32)))).code).toBe("P0002");
    expect((await pgError(view(""))).code).toBe("P0002");
    const off = await makeWidget(owner, { name: "כבוי", is_active: false });
    expect((await pgError(view(off.token))).code).toBe("P0002");
    expect((await pgError(submit(off.token, { full_name: "x", phone: "050-1111111" }))).code).toBe("P0002");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"site_widget\": false}' where organization_id = $1", [org]));
    try {
      expect((await pgError(view(widget.token))).code).toBe("P0002");
      expect(await pgError(makeWidget(owner))).toMatchObject({ code: "P0001", hint: "feature:site_widget" });
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{}' where organization_id = $1", [org]));
    }
    const setStatus = (status: string) => asAdmin((q) => q("update public.organizations set status = $2 where id = $1", [org, status]));
    await setStatus("cancelled");
    try {
      expect((await pgError(view(widget.token))).code).toBe("P0002");
      expect((await pgError(submit(widget.token, { full_name: "x", phone: "050-1111111" }))).code).toBe("P0002");
    } finally {
      await setStatus("active");
    }
    await asAdmin((q) => q("update public.organizations set deleted_at = now() where id = $1", [org]));
    try {
      expect((await pgError(view(widget.token))).code).toBe("P0002");
    } finally {
      await asAdmin((q) => q("update public.organizations set deleted_at = null where id = $1", [org]));
    }
    // a suspended business still shows its button and takes leads
    await setStatus("suspended");
    try {
      expect((await view(widget.token)).form).toBe(true);
    } finally {
      await setStatus("active");
    }
  });

  it("the short form makes a lead through intake_submit, with the page and campaign only; it answers its status only", async () => {
    const reply = await submit(widget.token, {
      full_name: "לקוח מהאתר",
      phone: "050-7771234",
      email: "site@example.test",
      message: "מעוניין בהצעה",
      attribution: { utm_source: "google", utm_campaign: "חורף", landing_url: "https://shop.example/sale?utm_source=google" },
      // not asked by the widget: dropped
      custom: { anything: "x" },
      callback: "now",
      company_name: "לא נשאל",
      status_id: "00000000-0000-4000-8000-000000000000",
    });
    expect(reply).toEqual({ status: "accepted" });
    const lead = await asAdmin(async (q) =>
      (
        await q<{
          owner_id: string;
          source: string;
          full_name: string;
          company_name: string | null;
          utm: Record<string, unknown>;
          landing_url: string | null;
          custom_fields: Record<string, unknown>;
        }>(
          `select l.owner_id, s.name as source, l.full_name, l.company_name, l.utm, l.landing_url, l.custom_fields
             from public.leads l join public.lead_sources s on s.organization_id = l.organization_id and s.id = l.source_id
            where l.organization_id = $1 and l.phone = '050-7771234'`,
          [org],
        )
      ).rows[0],
    );
    expect(lead).toMatchObject({ owner_id: member.id, source: "כפתור באתר", full_name: "לקוח מהאתר", company_name: null, custom_fields: {} });
    expect(lead.utm).toMatchObject({ utm_source: "google", utm_campaign: "חורף" });
    // the page the inquiry was sent from, kept to its campaign keys (CAP-02)
    expect(lead.landing_url).toBe("https://shop.example/sale?utm_source=google");
    // spam is answered as such, and leaves no lead
    expect(await submit(widget.token, { full_name: "בוט", phone: "050-0000002" }, hash(), true)).toEqual({ status: "spam" });
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and phone = '050-0000002'", [org]))).toBe(0);
    // intake_submit's own checks
    expect((await pgError(submit(widget.token, { message: "בלי פרטים" }))).code).toBe("22023");
    // nothing lands in another business
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1", [otherOrg]))).toBe(0);
  });

  it("rate limits: 60 views per sender in 10 minutes (a view without a sender is not counted), and intake_submit's per sender", async () => {
    const fresh = await makeWidget(owner, { name: "מוגבל" });
    const sender = await freshSender(fresh.id);
    for (let i = 0; i < 60; i += 1) expect((await view(fresh.token, sender)).rate_limited).toBeUndefined();
    expect(await view(fresh.token, sender)).toEqual({ rate_limited: true });
    expect((await view(fresh.token, await freshSender(fresh.id))).label).toBe("דברו איתנו");
    for (let i = 0; i < 70; i += 1) expect((await view(fresh.token)).label).toBe("דברו איתנו");
    const poster = hash();
    for (let i = 0; i < 10; i += 1) await submit(fresh.token, { full_name: `שולח ${i}`, phone: `050-80000${10 + i}` }, poster);
    expect((await pgError(submit(fresh.token, { full_name: "האחד עשר", phone: "050-8000099" }, poster))).hint).toBe("rate_limited");
    // the counters hold a widget, a bucket, a window and a number: no hash, no visitor
    const columns = await asAdmin(async (q) =>
      (await q<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'app' and table_name = 'site_widget_view_counts'")).rows
        .map((r) => r.column_name)
        .sort(),
    );
    expect(columns).toEqual(["bucket", "views", "widget_id", "window_start"]);
  });

  it("owners and admins of a writable business only; outsiders learn nothing about the plan", async () => {
    for (const who of [member, viewer, outsider]) {
      expect(await asUser(who.id, (q) => count(q, "select 1 from public.site_widgets where id = $1", [widget.id]))).toBe(0);
      expect(await asUser(who.id, async (q) => (await q("update public.site_widgets set name = 'נחטף'")).rowCount)).toBe(0);
      expect(await asUser(who.id, async (q) => (await q("delete from public.site_widgets")).rowCount)).toBe(0);
      expect((await pgError(makeWidget(who))).code).toBe("42501");
    }
    // the token is the database's
    expect((await pgError(makeWidget(owner, { token: "a".repeat(32) }))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.site_widgets set token = 'x' where id = $1", [widget.id])))).code).toBe("42501");
    // an outsider at a business with no flag, or at its quota: RLS's plain refusal, never a plan hint
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"site_widget\": false}' where organization_id = $1", [org]));
    try {
      const refused = await pgError(makeWidget(outsider));
      expect(refused.code).toBe("42501");
      expect(refused.hint ?? "").not.toMatch(/^(feature|limit):/);
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{}' where organization_id = $1", [org]));
    }
    const existing = await asAdmin((q) => count(q, "select 1 from public.site_widgets where organization_id = $1", [org]));
    await asAdmin((q) => q(`update public.subscriptions set limit_overrides = '{"max_site_widgets": ${existing}}' where organization_id = $1`, [org]));
    try {
      expect(await pgError(makeWidget(admin))).toMatchObject({ code: "P0001", hint: "limit:max_site_widgets" });
      const refused = await pgError(makeWidget(outsider));
      expect(refused.code).toBe("42501");
      expect(refused.hint ?? "").not.toMatch(/^(feature|limit):/);
    } finally {
      await asAdmin((q) => q(`update public.subscriptions set limit_overrides = '{"max_site_widgets": 20}' where organization_id = $1`, [org]));
    }
    // a read-only business: no changes
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(makeWidget(admin))).code).toBe("42501");
      expect(await asUser(admin.id, async (q) => (await q("update public.site_widgets set name = 'שונה' where id = $1", [widget.id])).rowCount)).toBe(0);
      expect(await asUser(admin.id, async (q) => (await q("delete from public.site_widgets where id = $1", [widget.id])).rowCount)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    // a person of another business is not one of this business's members; a team of another business: the composite key
    expect(await pgError(makeWidget(owner, { assign_mode: "owner", owner_id: outsider.id }))).toMatchObject({ code: "P0001", hint: "site_widget:owner" });
    const otherTeam = await asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צוות זר') returning id", [otherOrg])).rows[0].id,
    );
    expect((await pgError(makeWidget(owner, { team_id: otherTeam }))).code).toBe("23503");
  });

  it("a change of owner, team or assignment reaches the widget's form, and the next lead goes to the new owner", async () => {
    const w = await makeWidget(owner, { name: "החלפת אחראי", assign_mode: "round_robin" });
    const team = await asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צוות האתר') returning id", [org])).rows[0].id,
    );
    expect(await widgetForm(w.id)).toMatchObject({ assign_mode: "round_robin", owner_id: null });
    expect(
      await asUser(admin.id, async (q) =>
        (await q("update public.site_widgets set assign_mode = 'owner', owner_id = $2, team_id = $3 where id = $1", [w.id, admin.id, team])).rowCount,
      ),
    ).toBe(1);
    const form = await asAdmin(async (q) =>
      (
        await q<{ assign_mode: string; owner_id: string | null; team_id: string | null }>(
          "select assign_mode, owner_id, team_id from public.forms where site_widget_id = $1",
          [w.id],
        )
      ).rows[0],
    );
    expect(form).toEqual({ assign_mode: "owner", owner_id: admin.id, team_id: team });
    expect(await submit(w.token, { full_name: "אחרי ההחלפה", phone: "050-6661234" })).toEqual({ status: "accepted" });
    const lead = await asAdmin(async (q) =>
      (await q<{ owner_id: string | null; team_id: string | null }>("select owner_id, team_id from public.leads where organization_id = $1 and phone = '050-6661234'", [org]))
        .rows[0],
    );
    expect(lead).toEqual({ owner_id: admin.id, team_id: team });
  });

  it("the sender is scoped to the widget: the same visitor is a different sender on every widget", async () => {
    const a = await makeWidget(owner, { name: "אתר א" });
    const b = await makeWidget(owner, { name: "אתר ב" });
    const sender = hash();
    // intake_submit's per-sender limit on one widget does not reach the other
    for (let i = 0; i < 10; i += 1) await submit(a.token, { full_name: `שולח ${i}`, phone: `050-55500${10 + i}` }, sender);
    expect((await pgError(submit(a.token, { full_name: "האחד עשר", phone: "050-5550099" }, sender))).hint).toBe("rate_limited");
    expect(await submit(b.token, { full_name: "באתר השני", phone: "050-5550100" }, sender)).toEqual({ status: "accepted" });
    const stored = await asAdmin(async (q) =>
      (
        await q<{ ip_hash: string; widget: string }>(
          `select distinct s.ip_hash, f.site_widget_id as widget from public.form_submissions s
             join public.forms f on f.organization_id = s.organization_id and f.id = s.form_id
            where s.organization_id = $1 and f.site_widget_id in ($2, $3)`,
          [org, a.id, b.id],
        )
      ).rows,
    );
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.ip_hash)).not.toContain(sender);
    const expected = async (widgetId: string) =>
      asAdmin(async (q) => (await q<{ h: string }>("select app.site_widget_sender($1, $2) as h", [widgetId, sender])).rows[0].h);
    expect(stored.find((r) => r.widget === a.id)?.ip_hash).toBe(await expected(a.id));
    expect(stored.find((r) => r.widget === b.id)?.ip_hash).toBe(await expected(b.id));
  });

  it("only the server may call the public functions", async () => {
    const calls = ["select public.site_widget_public($1)", "select public.site_widget_submit($1, '{}'::jsonb)"];
    for (const sql of calls) {
      expect((await pgError(asUser(owner.id, (q) => q(sql, [widget.token])))).code, sql).toBe("42501");
      expect((await pgError(asAnon((q) => q(sql, [widget.token])))).code, sql).toBe("42501");
    }
  });

  it("changes to widgets are in the audit log", async () => {
    const w = await makeWidget(admin, { name: "לבדיקת יומן" });
    await asUser(admin.id, (q) => q("update public.site_widgets set button_label = 'דברו עכשיו' where id = $1", [w.id]));
    const actions = await asAdmin(async (q) =>
      (await q<{ action: string }>("select action from public.audit_log where organization_id = $1 and entity_id = $2 order by created_at", [org, w.id])).rows.map((r) => r.action),
    );
    expect(actions).toEqual(["insert", "update"]);
  });
});
