import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Row = Record<string, unknown>;

const DAY = 86_400_000;
const ALL_WEEK = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "09:00", end: "17:00" }]]));
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00Z`).toISOString();
// a zone where it is about noon now, so a slot "tomorrow 09-12" is always offered (SPD-05)
const noon = (() => {
  const offset = 12 - new Date().getUTCHours();
  return offset === 0 ? "UTC" : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
})();

const submit = (token: string, payload: Row, kind = "form") =>
  asService(async (q) =>
    (await q<{ r: Row }>("select public.intake_submit($1, $2, $3, null, null, false) as r", [token, kind, JSON.stringify(payload)])).rows[0].r,
  );

/**
 * LEAD-08 part (b) (owner, 18 October 2026, answer (א)): with the leads module off, every public intake path makes or
 * matches a contact instead of a lead, and asks for a call back ("לחזור ללקוח"); with it on, nothing changes.
 */
describe("public intake with the leads module off (LEAD-08)", () => {
  let owner: U, rep: U, other: U, outsider: U;
  let org: string;
  let source: string;
  let form: { id: string; token: string };
  let unowned: { id: string; token: string };
  let callbackForm: { id: string; token: string };
  let webhook: { id: string; token: string };

  const setLeads = (on: boolean) =>
    asAdmin((q) =>
      q(
        "insert into public.org_modules (organization_id, leads_enabled) values ($1, $2) on conflict (organization_id) do update set leads_enabled = excluded.leads_enabled",
        [org, on],
      ),
    );
  const contactsByPhone = (phone: string) =>
    asAdmin(async (q) => (await q<Row>("select * from public.contacts where organization_id = $1 and phone = $2", [org, phone])).rows);
  const leadsByPhone = (phone: string) => asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and phone = $2", [org, phone]));
  const tasksOf = (contact: string) =>
    asAdmin(async (q) => (await q<Row>("select title, task_type, owner_id, lead_id, due_at, priority from public.tasks where contact_id = $1 order by created_at, id", [contact])).rows);
  const noticesOf = (contact: string) =>
    asAdmin(async (q) =>
      (await q<Row>("select user_id, type, title from public.notifications where entity_type = 'contact' and entity_id = $1 order by user_id", [contact])).rows,
    );
  const taskNotices = (contact: string) =>
    asAdmin((q) =>
      count(q, "select 1 from public.notifications n join public.tasks t on t.id = n.entity_id where n.entity_type = 'task' and t.contact_id = $1", [contact]),
    );

  beforeAll(async () => {
    owner = await createUser("lo-owner");
    org = await createOrg(owner.id, "עסק בלי לידים");
    rep = await addMember(org, owner.id, "member", "lo-rep");
    other = await addMember(org, owner.id, "member", "lo-other");
    outsider = await createUser("lo-outsider");
    await createOrg(outsider.id, "עסק אחר");
    source = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.lead_sources where organization_id = $1 and kind = 'form'", [org])).rows[0].id);
    await asAdmin(async (q) => {
      await q("update public.organizations set timezone = $2 where id = $1", [org, noon]);
      await q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions)
         values ($1, '{}', false, false, '{}')
         on conflict (organization_id) do update set rest_weekdays = '{}', holidays_rest = false, holiday_eves_rest = false, rest_occasions = '{}'`,
        [org],
      );
    });
    [form, unowned, callbackForm, webhook] = await asUser(owner.id, async (q) => {
      const make = async (sql: string, params: unknown[]) => (await q<{ id: string; token: string }>(sql, params)).rows[0];
      return [
        await make(
          "insert into public.forms (organization_id, name, source_id, owner_id, channel_choice, locale_choice) values ($1, 'טופס באתר', $2, $3, true, true) returning id, token",
          [org, source, rep.id],
        ),
        // the form's owner is not a member any more (a viewer): nobody owns what comes in
        await make("insert into public.forms (organization_id, name, assign_mode) values ($1, 'טופס בלי אחראי', 'owner') returning id, token", [org]),
        await make("insert into public.forms (organization_id, name, owner_id, callback_choice) values ($1, 'שיחה חוזרת', $2, true) returning id, token", [org, rep.id]),
        await make("insert into public.forms (organization_id, kind, name, owner_id) values ($1, 'webhook', 'Zapier', $2) returning id, token", [org, rep.id]),
      ];
    });
  });

  it("with leads on, a form still makes a lead, as before", async () => {
    await setLeads(true);
    const r = await submit(form.token, { full_name: "ליד רגיל", phone: "050-6100001" });
    expect(r.status).toBe("accepted");
    expect(typeof r.lead_id).toBe("string");
    expect(await leadsByPhone("050-6100001")).toBe(1);
    expect(await contactsByPhone("050-6100001")).toEqual([]);
  });

  it("with leads off, a new person becomes the form owner's contact, with the inquiry on its timeline and a 'לחזור ללקוח' task", async () => {
    await setLeads(false);
    const r = await submit(form.token, {
      full_name: "רונית לוי",
      phone: "050-6100002",
      email: "Ronit@Example.com",
      company_name: "לוי בע״מ",
      message: "אשמח לשיחה",
      preferred_channel: "whatsapp",
      preferred_locale: "en",
      attribution: { utm_source: "google", utm_campaign: "סתיו" },
    });
    expect(r.status).toBe("accepted");
    expect(r.lead_id).toBeUndefined();
    expect(await leadsByPhone("050-6100002")).toBe(0);
    const [contact] = await contactsByPhone("050-6100002");
    expect(contact).toMatchObject({
      first_name: "רונית",
      last_name: "לוי",
      email: "ronit@example.com",
      owner_id: rep.id,
      source_id: source,
      preferred_channel: "whatsapp",
      preferred_channel_source: "form",
      preferred_locale: "en",
    });
    expect(r.contact_id).toBe(contact.id);
    // what a contact has no field for is on its timeline
    const entry = await asAdmin(async (q) => (await q<Row>("select type, body, metadata from public.activities where contact_id = $1", [contact.id])).rows);
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatchObject({ type: "inquiry", body: "אשמח לשיחה" });
    expect(entry[0].metadata).toMatchObject({ form_id: form.id, company_name: "לוי בע״מ", attribution: { utm_source: "google", utm_campaign: "סתיו" } });
    // one task, due now, for the owner, told once (the inquiry notice; the task itself is quiet)
    const tasks = await tasksOf(String(contact.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "לחזור ללקוח: רונית לוי", task_type: "call", owner_id: rep.id, lead_id: null, priority: 1 });
    expect(Math.abs(new Date(String(tasks[0].due_at)).getTime() - Date.now())).toBeLessThan(DAY);
    expect(await noticesOf(String(contact.id))).toEqual([{ user_id: rep.id, type: "inquiry", title: "פנייה חדשה מטופס" }]);
    expect(await taskNotices(String(contact.id))).toBe(0);
    // the form inquiry is kept, with no lead
    const sub = await asAdmin(async (q) => (await q<Row>("select status, lead_id from public.form_submissions where form_id = $1 order by created_at desc limit 1", [form.id])).rows[0]);
    expect(sub).toEqual({ status: "accepted", lead_id: null });
  });

  it("with leads off, a repeat inquiry from a contact (a further phone) goes onto that contact, with a task for its owner", async () => {
    const contact = await asUser(other.id, async (q) => {
      const id = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'קיים', $2) returning id", [org, other.id])).rows[0].id;
      await q("insert into public.contact_channels (organization_id, contact_id, kind, value) values ($1, $2, 'phone', '050-6100003')", [org, id]);
      return id;
    });
    const r = await submit(form.token, { full_name: "קיים שוב", phone: "050-6100003", message: "שוב אני" });
    expect(r).toMatchObject({ status: "duplicate", contact_id: contact });
    expect(r.lead_id ?? null).toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where organization_id = $1 and phone = '050-6100003'", [org]))).toBe(0);
    expect(await leadsByPhone("050-6100003")).toBe(0);
    const tasks = await tasksOf(contact);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "לחזור ללקוח: קיים שוב", owner_id: other.id });
    // the contact's owner hears once, as a repeat inquiry
    expect(await noticesOf(contact)).toEqual([{ user_id: other.id, type: "inquiry", title: "פנייה חוזרת מלקוח קיים" }]);
    expect(await taskNotices(contact)).toBe(0);
  });

  it("with leads off, an old lead with the same phone is not matched: the person becomes a contact", async () => {
    await insertLead(owner.id, org, { full_name: "ליד ישן", phone: "050-6100004" });
    const r = await submit(form.token, { full_name: "ליד ישן", phone: "050-6100004" });
    expect(r.status).toBe("accepted");
    expect(await contactsByPhone("050-6100004")).toHaveLength(1);
    expect(await leadsByPhone("050-6100004")).toBe(1);
  });

  it("with leads off and nobody to own it, the contact and its task have no owner and the SPD-01 recipients are told", async () => {
    const r = await submit(unowned.token, { full_name: "בלי אחראי", phone: "050-6100005" });
    expect(r.status).toBe("accepted");
    const [contact] = await contactsByPhone("050-6100005");
    expect(contact.owner_id).toBeNull();
    expect(await tasksOf(String(contact.id))).toMatchObject([{ title: "לחזור ללקוח: בלי אחראי", owner_id: null }]);
    // owners and admins (no team on the form)
    expect(await noticesOf(String(contact.id))).toEqual([{ user_id: owner.id, type: "inquiry", title: "פנייה חדשה מחכה למי שייקח אותה" }]);
  });

  it("with leads off and a requested call-back time, the call-back task is the follow-up (no second task)", async () => {
    const day = await asAdmin(async (q) => (await q<{ d: string }>("select to_char((now() at time zone $1)::date + 1, 'YYYY-MM-DD') as d", [noon])).rows[0].d);
    const r = await submit(callbackForm.token, { full_name: "התקשרו מחר", phone: "050-6100006", callback: `${day}-09` });
    expect(r.status).toBe("accepted");
    const [contact] = await contactsByPhone("050-6100006");
    const tasks = await tasksOf(String(contact.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "שיחה חוזרת: התקשרו מחר", owner_id: rep.id, lead_id: null });
    const notices = await noticesOf(String(contact.id));
    expect(notices).toHaveLength(1);
    expect(await taskNotices(String(contact.id))).toBe(0);
  });

  it("with leads off, a round-robin form gives the contacts in turn, by the same distribution as leads (CAP-08)", async () => {
    const rr = await asUser(owner.id, async (q) => {
      const team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3), ($1, $2, $4)", [org, team, rep.id, other.id]);
      return (await q<{ token: string }>("insert into public.forms (organization_id, name, assign_mode, team_id) values ($1, 'סבב', 'round_robin', $2) returning token", [org, team])).rows[0]
        .token;
    });
    for (const [i, phone] of ["050-6100020", "050-6100021", "050-6100022"].entries()) {
      expect((await submit(rr, { full_name: `סבב ${i}`, phone })).status).toBe("accepted");
    }
    const owners = await Promise.all(["050-6100020", "050-6100021", "050-6100022"].map(async (p) => (await contactsByPhone(p))[0].owner_id));
    expect(new Set(owners)).toEqual(new Set([rep.id, other.id]));
    expect(owners[0]).not.toBe(owners[1]);
    expect(owners[2]).toBe(owners[0]);
    for (const [i, p] of ["050-6100020", "050-6100021", "050-6100022"].entries()) {
      const [contact] = await contactsByPhone(p);
      expect(contact.team_id).not.toBeNull();
      expect(await tasksOf(String(contact.id)), `${i}`).toMatchObject([{ owner_id: contact.owner_id }]);
    }
  });

  it("with leads off, the call-back task of a new contact and the task of a repeat inquiry take the contact's team (review)", async () => {
    const [service, support] = await asUser(owner.id, async (q) => [
      (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'שירות') returning id", [org])).rows[0].id,
      (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'תמיכה') returning id", [org])).rows[0].id,
    ]);
    const teamForm = await asUser(owner.id, async (q) =>
      (
        await q<{ token: string }>("insert into public.forms (organization_id, name, owner_id, team_id, callback_choice) values ($1, 'צוות שירות', $2, $3, true) returning token", [
          org,
          rep.id,
          service,
        ])
      ).rows[0].token,
    );
    const day = await asAdmin(async (q) => (await q<{ d: string }>("select to_char((now() at time zone $1)::date + 1, 'YYYY-MM-DD') as d", [noon])).rows[0].d);
    expect((await submit(teamForm, { full_name: "שיחה לצוות", phone: "050-6100030", callback: `${day}-09` })).status).toBe("accepted");
    const [fresh] = await contactsByPhone("050-6100030");
    expect(fresh.team_id).toBe(service);
    expect(await asAdmin(async (q) => (await q<Row>("select team_id from public.tasks where contact_id = $1", [fresh.id])).rows)).toEqual([{ team_id: service }]);

    // a contact of another team asks again through the service team's form: the task follows the contact's team
    const known = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, phone, owner_id, team_id) values ($1, 'צוות אחר', '050-6100031', $2, $3) returning id", [org, other.id, support]))
        .rows[0].id,
    );
    expect((await submit(teamForm, { full_name: "צוות אחר", phone: "050-6100031" })).status).toBe("duplicate");
    expect(await asAdmin(async (q) => (await q<Row>("select team_id, owner_id from public.tasks where contact_id = $1", [known])).rows)).toEqual([
      { team_id: support, owner_id: other.id },
    ]);
  });

  it("with companies off, a person's new contact is not linked to a company by its email domain (CON-09)", async () => {
    const company = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.companies (organization_id, name, website, email) values ($1, 'דומיין בע״מ', 'domain-off-test.co.il', 'info@domain-off-test.co.il') returning id", [org])).rows[0].id,
    );
    const newContact = (email: string) =>
      asUser(owner.id, async (q) => (await q<Row>("insert into public.contacts (organization_id, first_name, email) values ($1, 'דומיין', $2) returning company_id", [org, email])).rows[0]);
    await asAdmin((q) => q("update public.org_modules set companies_enabled = false where organization_id = $1", [org]));
    try {
      expect(await newContact("a@domain-off-test.co.il")).toEqual({ company_id: null });
    } finally {
      await asAdmin((q) => q("update public.org_modules set companies_enabled = true where organization_id = $1", [org]));
    }
    expect(await newContact("b@domain-off-test.co.il")).toEqual({ company_id: company });
  });

  it("with leads off, a webhook, the site widget and the business card make contacts too", async () => {
    expect((await submit(webhook.token, { full_name: "מזאפייר", phone: "050-6100007" }, "webhook")).status).toBe("accepted");
    expect(await contactsByPhone("050-6100007")).toMatchObject([{ owner_id: rep.id }]);

    await asAdmin((q) => q(`update public.subscriptions set limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{"max_site_widgets": 5}' where organization_id = $1`, [org]));
    const widget = await asUser(owner.id, async (q) =>
      (
        await q<{ token: string }>("insert into public.site_widgets (organization_id, name, assign_mode, owner_id) values ($1, 'האתר', 'owner', $2) returning token", [
          org,
          rep.id,
        ])
      ).rows[0].token,
    );
    const w = await asService(async (q) =>
      (await q<{ r: Row }>("select public.site_widget_submit($1, $2, $3, 'test', false) as r", [widget, JSON.stringify({ full_name: "מהכפתור", phone: "050-6100008" }), "1".padStart(64, "0")])).rows[0].r,
    );
    expect(w).toEqual({ status: "accepted" });
    expect(await contactsByPhone("050-6100008")).toMatchObject([{ owner_id: rep.id }]);

    const card = await asUser(rep.id, async (q) =>
      (await q<{ token: string }>("insert into public.business_cards (organization_id, user_id) values ($1, $2) returning token", [org, rep.id])).rows[0].token,
    );
    const c = await asService(async (q) =>
      (await q<{ r: Row }>("select public.business_card_submit($1, $2, $3, 'test', false) as r", [card, JSON.stringify({ full_name: "מהכרטיס", phone: "050-6100009" }), "2".padStart(64, "0")])).rows[0].r,
    );
    expect(c).toEqual({ status: "accepted" });
    expect(await contactsByPhone("050-6100009")).toMatchObject([{ owner_id: rep.id }]);
    for (const phone of ["050-6100007", "050-6100008", "050-6100009"]) expect(await leadsByPhone(phone)).toBe(0);
  });

  it("with leads off, a booking links the meeting to a new contact of the rep, or to the contact with that phone", async () => {
    const target = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
    await asAdmin((q) => q("update public.profiles set working_hours = $2, timezone = null where id = $1", [rep.id, JSON.stringify(ALL_WEEK)]));
    await asAdmin((q) => q("update public.organizations set timezone = 'UTC' where id = $1", [org]));
    try {
      const type = await asUser(owner.id, async (q) =>
        (await q<{ id: string }>("insert into public.meeting_types (organization_id, name, duration_minutes) values ($1, 'פגישה', 60) returning id", [org])).rows[0].id,
      );
      const page = await asUser(rep.id, async (q) =>
        (
          await q<{ token: string }>(
            "insert into public.booking_pages (organization_id, user_id, title, meeting_type_id, min_notice_minutes, max_days_ahead, slot_step_minutes) values ($1, $2, 'תור', $3, 0, 14, 60) returning token",
            [org, rep.id, type],
          )
        ).rows[0].token,
      );
      const book = (startsAt: string, payload: Row, ip: string) =>
        asService(async (q) =>
          (await q<{ r: Row }>("select public.booking_submit($1, $2, $3, $4, null, false) as r", [page, startsAt, JSON.stringify(payload), ip])).rows[0].r,
        );
      expect((await book(at(target, "10:00"), { full_name: "מזמין חדש", phone: "050-6100010" }, "3".padStart(64, "0"))).status).toBe("booked");
      const [contact] = await contactsByPhone("050-6100010");
      expect(contact).toMatchObject({ first_name: "מזמין", last_name: "חדש", owner_id: rep.id });
      expect(await leadsByPhone("050-6100010")).toBe(0);
      const meeting = await asAdmin(async (q) => (await q<Row>("select lead_id, contact_id from public.meetings where contact_id = $1", [contact.id])).rows);
      expect(meeting).toEqual([{ lead_id: null, contact_id: contact.id }]);

      // the person already a contact (from the form above): linked, nothing new
      expect((await book(at(target, "14:00"), { full_name: "רונית", phone: "050-6100002" }, "4".padStart(64, "0"))).status).toBe("booked");
      expect(await contactsByPhone("050-6100002")).toHaveLength(1);
      const [ronit] = await contactsByPhone("050-6100002");
      expect(await asAdmin((q) => count(q, "select 1 from public.meetings where contact_id = $1 and lead_id is null", [ronit.id]))).toBe(1);
    } finally {
      await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org, noon]));
    }
  });

  it("with leads off, a leads import is refused when the job is made; contacts import; another business gets the plain refusal", async () => {
    const start = (user: U, o: string, entity: string) =>
      asUser(user.id, (q) => q("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, $2, 'x.csv', 'skip')", [o, entity]));
    const refused = await pgError(start(owner, org, "lead"));
    expect(refused).toMatchObject({ code: "P0001", hint: "module:leads_off" });
    await start(owner, org, "contact");
    const foreign = await pgError(start(outsider, org, "lead"));
    expect(foreign.code).toBe("42501");
    expect(foreign.hint ?? "").not.toBe("module:leads_off");
  });

  it("switched back on, the next inquiry is a lead again and a leads import starts", async () => {
    await setLeads(true);
    const r = await submit(form.token, { full_name: "חזרנו", phone: "050-6100011" });
    expect(typeof r.lead_id).toBe("string");
    expect(await contactsByPhone("050-6100011")).toEqual([]);
    await asUser(owner.id, (q) => q("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'x.csv', 'skip')", [org]));
  });
});
