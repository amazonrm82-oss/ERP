import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Scan = Record<string, unknown>;

const ALL_WEEK = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "00:00", end: "23:59" }]]));

/**
 * BIZ-03 part one: QR codes that open a form or a booking page, in the approved pattern for public secret-link pages
 * (owner, 13 October 2026): a scan is a counter only (no IP, device or visitor id), it leads only to the stored target,
 * a code that is off or whose target is gone or not open is "not found", rate limited, nothing beyond the path and the
 * campaign tag is returned, and no business reaches another's codes or targets.
 */
describe("QR codes (BIZ-03)", () => {
  let owner: U, admin: U, member: U, rep: U, outsider: U;
  let org: string, otherOrg: string;
  let form: { id: string; token: string };
  let otherForm: string;
  let page: { id: string; token: string };

  const scan = (token: string) => asService(async (q) => (await q<{ r: Scan }>("select public.qr_scan($1) as r", [token])).rows[0].r);
  const makeCode = (who: U, values: Record<string, unknown>, o: string = org) =>
    asUser(who.id, async (q) => {
      const row: Record<string, unknown> = { organization_id: o, name: "שלט", ...values };
      const cols = Object.keys(row);
      return (
        await q<{ id: string; token: string }>(
          `insert into public.qr_codes (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id, token`,
          Object.values(row),
        )
      ).rows[0];
    });
  const counts = (who: U, o: string = org, days = 30) =>
    asUser(who.id, async (q) => (await q<{ r: { qr_code_id: string; total: number; recent: number; last_day: string }[] }>("select public.qr_code_scans($1, $2) as r", [o, days])).rows[0].r);
  const scansOf = (codeId: string) =>
    asAdmin(async (q) => Number((await q<{ n: string }>("select coalesce(sum(scans), 0) as n from app.qr_code_scan_days where qr_code_id = $1", [codeId])).rows[0].n));

  beforeAll(async () => {
    owner = await createUser("qr-owner");
    org = await createOrg(owner.id, "עסק השלטים");
    admin = await addMember(org, owner.id, "admin", "qr-admin");
    member = await addMember(org, owner.id, "member", "qr-member");
    rep = await addMember(org, owner.id, "member", "qr-rep");
    outsider = await createUser("qr-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    form = await asUser(owner.id, async (q) =>
      (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name) values ($1, 'טופס אתר') returning id, token", [org])).rows[0],
    );
    otherForm = await asUser(outsider.id, async (q) =>
      (await q<{ id: string }>("insert into public.forms (organization_id, name) values ($1, 'טופס זר') returning id", [otherOrg])).rows[0].id,
    );
    await asAdmin((q) => q("update public.profiles set working_hours = $2, timezone = null where id = $1", [rep.id, JSON.stringify(ALL_WEEK)]));
    page = await asUser(rep.id, async (q) =>
      (
        await q<{ id: string; token: string }>(
          `insert into public.booking_pages (organization_id, user_id, title, meeting_type_id)
           select $1, $2, 'פגישת ייעוץ', t.id from public.meeting_types t where t.organization_id = $1 and t.is_active order by t.position limit 1
           returning id, token`,
          [org, rep.id],
        )
      ).rows[0],
    );
  });

  it("a scan answers only the stored target's path and the campaign tag, and counts one", async () => {
    const code = await makeCode(owner, { name: "שלט בחנות", target_kind: "form", form_id: form.id });
    const answer = await scan(code.token);
    expect(answer).toEqual({ path: `/f/${form.token}`, campaign: "שלט בחנות" });
    expect(await scansOf(code.id)).toBe(1);
    await scan(code.token);
    const mine = (await counts(owner)).find((c) => c.qr_code_id === code.id);
    expect(mine).toMatchObject({ total: 2, recent: 2 });
    expect(Object.keys(mine!).sort()).toEqual(["last_day", "qr_code_id", "recent", "total"]);
  });

  it("a booking code opens the page while the page is on; an off page is not found", async () => {
    const code = await makeCode(admin, { name: "פלייר", target_kind: "booking", booking_page_id: page.id });
    expect(await scan(code.token)).toEqual({ path: `/f/book/${page.token}`, campaign: "פלייר" });
    await asAdmin((q) => q("update public.booking_pages set is_active = false where id = $1", [page.id]));
    try {
      expect((await pgError(scan(code.token))).code).toBe("P0002");
    } finally {
      await asAdmin((q) => q("update public.booking_pages set is_active = true where id = $1", [page.id]));
    }
    // a rep who left: the page is not shown, so neither is the code's way to it
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, rep.id]));
    try {
      expect((await pgError(scan(code.token))).code).toBe("P0002");
    } finally {
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, rep.id]));
    }
    expect((await scan(code.token)).path).toBe(`/f/book/${page.token}`);
  });

  it("not found: unknown token, a code switched off, an inactive form, a deleted form or page; nothing counted", async () => {
    expect((await pgError(scan("0".repeat(32)))).code).toBe("P0002");
    expect((await pgError(scan(""))).code).toBe("P0002");
    const code = await makeCode(owner, { target_kind: "form", form_id: form.id, is_active: false });
    expect((await pgError(scan(code.token))).code).toBe("P0002");
    expect(await scansOf(code.id)).toBe(0);

    const spare = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.forms (organization_id, name) values ($1, 'טופס זמני') returning id", [org])).rows[0].id,
    );
    const onSpare = await makeCode(owner, { target_kind: "form", form_id: spare });
    await asUser(owner.id, (q) => q("update public.forms set is_active = false where id = $1", [spare]));
    expect((await pgError(scan(onSpare.token))).code).toBe("P0002");
    // the form is deleted: the code stays, with no target, and is not found
    await asUser(owner.id, (q) => q("delete from public.forms where id = $1", [spare]));
    expect(await asAdmin(async (q) => (await q<{ form_id: string | null }>("select form_id from public.qr_codes where id = $1", [onSpare.id])).rows[0].form_id)).toBeNull();
    expect((await pgError(scan(onSpare.token))).code).toBe("P0002");
    expect(await scansOf(onSpare.id)).toBe(0);

    // a booking page deleted by its rep (not an admin): the code loses its target the same way
    const page2 = await asUser(rep.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.booking_pages (organization_id, user_id, title, meeting_type_id)
           select $1, $2, 'דף זמני', t.id from public.meeting_types t where t.organization_id = $1 and t.is_active order by t.position limit 1 returning id`,
          [org, rep.id],
        )
      ).rows[0].id,
    );
    const onPage2 = await makeCode(owner, { target_kind: "booking", booking_page_id: page2 });
    await asUser(rep.id, (q) => q("delete from public.booking_pages where id = $1", [page2]));
    expect((await pgError(scan(onPage2.token))).code).toBe("P0002");
  });

  it("a closed business answers not found; a suspended one still opens its pages (app.org_public_pages_open)", async () => {
    const code = await makeCode(owner, { target_kind: "form", form_id: form.id });
    const setStatus = (status: string) => asAdmin((q) => q("update public.organizations set status = $2 where id = $1", [org, status]));
    await setStatus("cancelled");
    try {
      expect((await pgError(scan(code.token))).code).toBe("P0002");
    } finally {
      await setStatus("active");
    }
    await asAdmin((q) => q("update public.organizations set deleted_at = now() where id = $1", [org]));
    try {
      expect((await pgError(scan(code.token))).code).toBe("P0002");
    } finally {
      await asAdmin((q) => q("update public.organizations set deleted_at = null where id = $1", [org]));
    }
    await setStatus("suspended");
    try {
      expect((await scan(code.token)).path).toBe(`/f/${form.token}`);
    } finally {
      await setStatus("active");
    }
  });

  it("the plan: the flag opens codes and scans; the quota counts every code, switched off ones too", async () => {
    const code = await makeCode(owner, { target_kind: "form", form_id: form.id });
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"qr_codes\": false}' where organization_id = $1", [org]));
    try {
      expect(await pgError(makeCode(owner, { target_kind: "form", form_id: form.id }))).toMatchObject({ code: "P0001", hint: "feature:qr_codes" });
      expect((await pgError(scan(code.token))).code).toBe("P0002");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{}' where organization_id = $1", [org]));
    }
    const existing = await asAdmin((q) => count(q, "select 1 from public.qr_codes where organization_id = $1", [org]));
    await asAdmin((q) => q("update public.qr_codes set is_active = false where organization_id = $1", [org]));
    await asAdmin((q) => q(`update public.subscriptions set limit_overrides = '{"max_qr_codes": ${existing}}' where organization_id = $1`, [org]));
    try {
      expect(await pgError(makeCode(admin, { target_kind: "form", form_id: form.id }))).toMatchObject({ code: "P0001", hint: "limit:max_qr_codes" });
    } finally {
      await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{}' where organization_id = $1", [org]));
      await asAdmin((q) => q("update public.qr_codes set is_active = true where organization_id = $1", [org]));
    }
  });

  it("a code opens a web form or a booking page of its own business, and nothing else", async () => {
    expect(await pgError(makeCode(owner, { target_kind: "form" }))).toMatchObject({ code: "P0001", hint: "qr_code:target" });
    expect(await pgError(makeCode(owner, { target_kind: "booking" }))).toMatchObject({ code: "P0001", hint: "qr_code:target" });
    // the shape: one target column per kind
    expect((await pgError(makeCode(owner, { target_kind: "booking", form_id: form.id }))).code).toBe("23514");
    expect((await pgError(makeCode(owner, { target_kind: "url", form_id: form.id }))).code).toBe("23514");
    // a webhook is not a page
    const hook = await asAdmin(async (q) =>
      (await q<{ id: string }>("insert into public.forms (organization_id, name, kind) values ($1, 'וובהוק', 'webhook') returning id", [org])).rows[0].id,
    );
    expect(await pgError(makeCode(owner, { target_kind: "form", form_id: hook }))).toMatchObject({ code: "P0001", hint: "qr_code:target" });
    const code = await makeCode(owner, { target_kind: "form", form_id: form.id });
    expect(await pgError(asUser(owner.id, (q) => q("update public.qr_codes set form_id = $2 where id = $1", [code.id, hook])))).toMatchObject({ hint: "qr_code:target" });
    // another business's form: not one of this business's web forms (the composite key would refuse it next)
    expect(await pgError(makeCode(owner, { target_kind: "form", form_id: otherForm }))).toMatchObject({ code: "P0001", hint: "qr_code:target" });
    expect(await pgError(asUser(owner.id, (q) => q("update public.qr_codes set form_id = $2 where id = $1", [code.id, otherForm])))).toMatchObject({
      hint: "qr_code:target",
    });
    // another business's booking page: the composite key refuses it
    const otherPage = await asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.booking_pages (organization_id, user_id, title, is_active) values ($1, $2, 'דף זר', false) returning id`,
          [otherOrg, outsider.id],
        )
      ).rows[0].id,
    );
    expect((await pgError(makeCode(owner, { target_kind: "booking", booking_page_id: otherPage }))).code).toBe("23503");
    // the token is the database's
    expect((await pgError(makeCode(owner, { target_kind: "form", form_id: form.id, token: "a".repeat(32) }))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.qr_codes set token = 'x' where id = $1", [code.id])))).code).toBe("42501");
  });

  it("no business reaches another's codes or counts; members and outsiders see none", async () => {
    const code = await makeCode(owner, { target_kind: "form", form_id: form.id });
    await scan(code.token);
    for (const who of [member, outsider]) {
      expect(await asUser(who.id, (q) => count(q, "select 1 from public.qr_codes where id = $1", [code.id]))).toBe(0);
      expect(await asUser(who.id, async (q) => (await q("update public.qr_codes set name = 'נחטף'")).rowCount)).toBe(0);
      expect(await asUser(who.id, async (q) => (await q("delete from public.qr_codes")).rowCount)).toBe(0);
      expect((await pgError(counts(who))).code).toBe("42501");
    }
    // the outsider's own counts list only its own codes
    expect(await counts(outsider, otherOrg)).toEqual([]);
    // an outsider who writes into this business gets RLS's plain refusal (nothing about its plan)
    expect((await pgError(makeCode(outsider, { target_kind: "form", form_id: form.id }))).code).toBe("42501");
    expect((await pgError(counts(owner, org, 0))).code).toBe("22023");
  });

  it("an outsider learns nothing about the plan: RLS's plain refusal, never a feature or limit hint", async () => {
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"qr_codes\": false}' where organization_id = $1", [org]));
    try {
      const refused = await pgError(makeCode(outsider, { target_kind: "form", form_id: form.id }));
      expect(refused.code).toBe("42501");
      expect(refused.hint ?? "").not.toMatch(/^(feature|limit):/);
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{}' where organization_id = $1", [org]));
    }
    const existing = await asAdmin((q) => count(q, "select 1 from public.qr_codes where organization_id = $1", [org]));
    await asAdmin((q) => q(`update public.subscriptions set limit_overrides = '{"max_qr_codes": ${existing}}' where organization_id = $1`, [org]));
    try {
      const refused = await pgError(makeCode(outsider, { target_kind: "form", form_id: form.id }));
      expect(refused.code).toBe("42501");
      expect(refused.hint ?? "").not.toMatch(/^(feature|limit):/);
    } finally {
      await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{}' where organization_id = $1", [org]));
    }
  });

  it("a read-only business: an admin cannot add, change or remove codes", async () => {
    const code = await makeCode(admin, { target_kind: "form", form_id: form.id });
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(makeCode(admin, { target_kind: "form", form_id: form.id }))).code).toBe("42501");
      expect(await asUser(admin.id, async (q) => (await q("update public.qr_codes set name = 'שונה' where id = $1", [code.id])).rowCount)).toBe(0);
      expect(await asUser(admin.id, async (q) => (await q("delete from public.qr_codes where id = $1", [code.id])).rowCount)).toBe(0);
      // the code still opens its page in a read-only business
      expect((await scan(code.token)).path).toBe(`/f/${form.token}`);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("the counts: all time, and only the last N days of the business in 'recent'", async () => {
    const code = await makeCode(owner, { target_kind: "form", form_id: form.id });
    await asAdmin((q) =>
      q("insert into app.qr_code_scan_days (qr_code_id, day, scans) values ($1, (now() at time zone 'Asia/Jerusalem')::date - 40, 5)", [code.id]),
    );
    await scan(code.token);
    const of = async (days: number) => (await counts(owner, org, days)).find((c) => c.qr_code_id === code.id);
    expect(await of(30)).toMatchObject({ total: 6, recent: 1 });
    expect(await of(60)).toMatchObject({ total: 6, recent: 6 });
  });

  it("only the server may scan; a person or a visitor cannot call it", async () => {
    const code = await makeCode(owner, { target_kind: "form", form_id: form.id });
    expect((await pgError(asUser(owner.id, (q) => q("select public.qr_scan($1)", [code.token])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.qr_scan($1)", [code.token])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.qr_code_scans($1)", [org])))).code).toBe("42501");
    // the counters hold a code, a day and a number; nothing about who scanned
    const columns = await asAdmin(async (q) =>
      (
        await q<{ t: string; c: string }>(
          "select table_name as t, column_name as c from information_schema.columns where table_schema = 'app' and table_name in ('qr_code_scan_days', 'qr_scan_windows') order by 1, 2",
        )
      ).rows.map((r) => `${r.t}.${r.c}`),
    );
    expect(columns).toEqual([
      "qr_code_scan_days.day",
      "qr_code_scan_days.qr_code_id",
      "qr_code_scan_days.scans",
      "qr_scan_windows.qr_code_id",
      "qr_scan_windows.scans",
      "qr_scan_windows.window_start",
    ]);
  });

  it("rate limit: at most 60 counted scans a minute per code; past that it still opens, uncounted", async () => {
    const code = await makeCode(owner, { target_kind: "form", form_id: form.id });
    for (let i = 0; i < 65; i++) expect((await scan(code.token)).path).toBe(`/f/${form.token}`);
    expect(await scansOf(code.id)).toBe(60);
    // a new minute counts again
    await asAdmin((q) => q("update app.qr_scan_windows set window_start = now() - interval '2 minutes' where qr_code_id = $1", [code.id]));
    await scan(code.token);
    expect(await scansOf(code.id)).toBe(61);
    // another code has its own minute
    const other = await makeCode(owner, { target_kind: "form", form_id: form.id });
    await scan(other.token);
    expect(await scansOf(other.id)).toBe(1);
  });

  it("changes to codes are in the audit log", async () => {
    const code = await makeCode(admin, { name: "שלט בכניסה", target_kind: "form", form_id: form.id });
    await asUser(admin.id, (q) => q("update public.qr_codes set name = 'שלט ראשי' where id = $1", [code.id]));
    const actions = await asAdmin(async (q) =>
      (await q<{ action: string }>("select action from public.audit_log where organization_id = $1 and entity_id = $2 order by created_at", [org, code.id])).rows.map(
        (r) => r.action,
      ),
    );
    expect(actions).toEqual(["insert", "update"]);
  });
});
