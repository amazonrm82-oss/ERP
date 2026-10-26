import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Reply = Record<string, unknown>;

const DAY = 86_400_000;
const ALL_WEEK = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "00:00", end: "23:59" }]]));
const dayAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00Z`).toISOString();

type Source = {
  source_id: string | null;
  campaign: string | null;
  utm: Record<string, unknown> | null;
  last_source_id: string | null;
  last_campaign: string | null;
  last_utm: Record<string, unknown> | null;
  last_source_at: string | null;
};

const COLUMNS = "source_id, campaign, utm, last_source_id, last_campaign, last_utm, last_source_at";

/**
 * SEG-02 + DQL-04 (owner, 18 October 2026): every lead and contact keeps its first source (source, campaign, UTM) and its
 * last source (the latest automatic inquiry: form, business card, site widget, booking page). A manual entry never moves the
 * last source; the first source of a lead is locked once set (owners and admins may change it, audited); conversion carries
 * both to the contact; revenue is reported by first source and campaign.
 */
describe("first and last source (SEG-02, DQL-04)", () => {
  let owner: U, admin: U, manager: U, member: U;
  let org: string, otherOrg: string, outsider: U;
  let formSource: string, adsSource: string, bookingSource: string;
  let form: { id: string; token: string };
  let adsForm: { id: string; token: string };
  let page: { id: string; token: string };

  const submit = (token: string, payload: Record<string, unknown>) =>
    asService(async (q) => (await q<{ r: { status: string; lead_id?: string } }>("select public.intake_submit($1, 'form', $2) as r", [token, JSON.stringify(payload)])).rows[0].r);
  const book = (startsAt: string, phone: string, name = "לקוחה", attribution: Record<string, string> = {}) =>
    asService(async (q) =>
      (await q<{ r: Reply }>("select public.booking_submit($1, $2, $3, null) as r", [page.token, startsAt, JSON.stringify({ full_name: name, phone, attribution })])).rows[0].r,
    );
  const lead = (id: string) => asAdmin(async (q) => (await q<Source>(`select ${COLUMNS} from public.leads where id = $1`, [id])).rows[0]);
  const contact = (id: string) => asAdmin(async (q) => (await q<Source>(`select ${COLUMNS} from public.contacts where id = $1`, [id])).rows[0]);
  const leadByPhone = (e164: string) =>
    asAdmin(async (q) => (await q<{ id: string }>("select id from public.leads where organization_id = $1 and phone_e164 = $2", [org, e164])).rows[0]?.id);
  const contactByPhone = (e164: string) =>
    asAdmin(async (q) => (await q<{ id: string }>("select id from public.contacts where organization_id = $1 and phone_e164 = $2", [org, e164])).rows[0]?.id);
  const setLeadsOn = (on: boolean) =>
    asAdmin((q) =>
      q(
        `insert into public.org_modules (organization_id, leads_enabled) values ($1, $2)
         on conflict (organization_id) do update set leads_enabled = $2`,
        [org, on],
      ),
    );

  beforeAll(async () => {
    owner = await createUser("sa-owner");
    org = await createOrg(owner.id, "עסק המקורות");
    admin = await addMember(org, owner.id, "admin", "sa-admin");
    manager = await addMember(org, owner.id, "manager", "sa-manager");
    member = await addMember(org, owner.id, "member", "sa-member");
    outsider = await createUser("sa-outsider");
    otherOrg = await createOrg(outsider.id, "עסק זר");
    await asAdmin(async (q) => {
      await q("update public.organizations set timezone = 'UTC' where id = $1", [org]);
      await q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions, working_hours)
         values ($1, '{}', false, false, '{}', $2)
         on conflict (organization_id) do update set rest_weekdays = '{}', holidays_rest = false, holiday_eves_rest = false, rest_occasions = '{}', working_hours = $2`,
        [org, JSON.stringify(ALL_WEEK)],
      );
      formSource = (await q<{ id: string }>("select id from public.lead_sources where organization_id = $1 and kind = 'form'", [org])).rows[0].id;
      adsSource = (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'פייסבוק') returning id", [org])).rows[0].id;
      bookingSource = (await q<{ id: string }>("insert into public.lead_sources (organization_id, name, kind) values ($1, 'דף קביעת תור', 'booking') returning id", [org])).rows[0].id;
    });
    await asUser(owner.id, async (q) => {
      form = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name, source_id, owner_id) values ($1, 'טופס באתר', $2, $3) returning id, token", [org, formSource, member.id])).rows[0];
      adsForm = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name, source_id, owner_id) values ($1, 'טופס פייסבוק', $2, $3) returning id, token", [org, adsSource, member.id])).rows[0];
      const type = (await q<{ id: string }>("insert into public.meeting_types (organization_id, name, duration_minutes) values ($1, 'ייעוץ', 60) returning id", [org])).rows[0].id;
      page = (
        await q<{ id: string; token: string }>(
          "insert into public.booking_pages (organization_id, user_id, title, meeting_type_id, min_notice_minutes, max_days_ahead, slot_step_minutes) values ($1, $2, 'תורים באתר', $3, 0, 30, 60) returning id, token",
          [org, member.id, type],
        )
      ).rows[0];
    });
  });

  it("a lead made by a form starts with last = first; a repeat inquiry moves only the last source", async () => {
    const first = await submit(form.token, { full_name: "דנה", phone: "0521000001", attribution: { utm_source: "google", utm_campaign: "חורף" } });
    const id = first.lead_id as string;
    expect(await lead(id)).toMatchObject({
      source_id: formSource,
      campaign: "חורף",
      utm: { utm_source: "google", utm_campaign: "חורף" },
      last_source_id: formSource,
      last_campaign: "חורף",
      last_utm: { utm_source: "google", utm_campaign: "חורף" },
    });
    expect((await lead(id)).last_source_at).not.toBeNull();

    // the same phone again, through the Facebook form with its own campaign
    const again = await submit(adsForm.token, { full_name: "דנה", phone: "0521000001", attribution: { utm_source: "facebook", utm_campaign: "אביב", utm_medium: "cpc" } });
    expect(again.status).toBe("duplicate");
    expect(await lead(id)).toMatchObject({
      source_id: formSource,
      campaign: "חורף",
      utm: { utm_source: "google", utm_campaign: "חורף" },
      last_source_id: adsSource,
      last_campaign: "אביב",
      last_utm: { utm_source: "facebook", utm_campaign: "אביב", utm_medium: "cpc" },
    });
  });

  it("a manual lead has no last source, and a person's edit never moves it", async () => {
    const id = await insertLead(member.id, org, { owner_id: member.id, source_id: adsSource, campaign: "ידני" });
    expect(await lead(id)).toMatchObject({ source_id: adsSource, last_source_id: null, last_campaign: null, last_source_at: null });
    await asUser(member.id, (q) => q("update public.leads set full_name = 'שם חדש' where id = $1", [id]));
    expect((await lead(id)).last_source_at).toBeNull();
    // the last-source columns are server-only
    const write = await pgError(asUser(owner.id, (q) => q("update public.leads set last_source_id = $2 where id = $1", [id, formSource])));
    expect(write.code).toBe("42501");
    const contactWrite = await pgError(
      asUser(owner.id, (q) => q("insert into public.contacts (organization_id, first_name, last_campaign) values ($1, 'x', 'y')", [org])),
    );
    expect(contactWrite.code).toBe("42501");
  });

  it("a lead with no first source gets it from its first automatic inquiry", async () => {
    const id = await insertLead(member.id, org, { owner_id: member.id, phone: "0521000002" });
    await submit(adsForm.token, { full_name: "רון", phone: "0521000002", attribution: { utm_campaign: "קיץ" } });
    expect(await lead(id)).toMatchObject({ source_id: adsSource, campaign: "קיץ", utm: { utm_campaign: "קיץ" }, last_source_id: adsSource, last_campaign: "קיץ" });
  });

  it("DQL-04: once any part is set, a member or a manager cannot change, clear or fill any part; before that anyone fills it", async () => {
    const id = await insertLead(member.id, org, { owner_id: member.id, source_id: formSource, campaign: "חורף", utm: { utm_source: "google" } });
    for (const user of [member, manager]) {
      const target = user === member ? id : await insertLead(manager.id, org, { owner_id: manager.id, source_id: formSource, campaign: "חורף", utm: { utm_source: "google" } });
      for (const sql of [
        "update public.leads set source_id = $2 where id = $1",
        "update public.leads set source_id = null where id = $1 and $2::uuid is not null",
        "update public.leads set campaign = 'אחר' where id = $1 and $2::uuid is not null",
        "update public.leads set utm = jsonb_build_object('$merge', jsonb_build_object('utm_source', 'bing')) where id = $1 and $2::uuid is not null",
        "update public.leads set utm = jsonb_build_object('$merge', jsonb_build_object('utm_source', null)) where id = $1 and $2::uuid is not null",
        // the whole first source is locked: an empty UTM value cannot be filled either
        "update public.leads set utm = jsonb_build_object('$merge', jsonb_build_object('utm_medium', 'cpc')) where id = $1 and $2::uuid is not null",
      ]) {
        const err = await pgError(asUser(user.id, (q) => q(sql, [target, adsSource])));
        expect(err.hint).toBe("lead:first_source_locked");
      }
    }
    // saving the same values (as the form does) is no change
    await asUser(member.id, (q) =>
      q("update public.leads set source_id = $2, campaign = 'חורף', utm = jsonb_build_object('$merge', jsonb_build_object('utm_source', 'google', 'utm_medium', null)) where id = $1", [id, formSource]),
    );
    expect(await lead(id)).toMatchObject({ source_id: formSource, campaign: "חורף", utm: { utm_source: "google" } });
    // a lead with no first source: a member fills it (several parts at once), then it is locked
    const empty = await insertLead(member.id, org, { owner_id: member.id });
    await asUser(member.id, (q) => q("update public.leads set source_id = $2, campaign = 'ידני' where id = $1", [empty, formSource]));
    expect((await pgError(asUser(member.id, (q) => q("update public.leads set source_id = $2 where id = $1", [empty, adsSource])))).hint).toBe("lead:first_source_locked");
    // a campaign alone counts as a first source: the source cannot be added by a member
    const campaignOnly = await insertLead(member.id, org, { owner_id: member.id, campaign: "רק קמפיין" });
    expect((await pgError(asUser(member.id, (q) => q("update public.leads set source_id = $2 where id = $1", [campaignOnly, formSource])))).hint).toBe("lead:first_source_locked");
  });

  it("DQL-04 for contacts: the same lock on source, and owners/admins may change it", async () => {
    const make = (source: string | null) =>
      asUser(owner.id, async (q) =>
        (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id, source_id) values ($1, 'איש', $2, $3) returning id", [org, member.id, source])).rows[0].id,
      );
    const set = await make(formSource);
    for (const [sql, args] of [
      ["update public.contacts set source_id = $2 where id = $1", [set, adsSource]],
      ["update public.contacts set source_id = null where id = $1", [set]],
    ] as const) {
      expect((await pgError(asUser(member.id, (q) => q(sql, [...args])))).hint).toBe("contact:first_source_locked");
    }
    const empty = await make(null);
    await asUser(member.id, (q) => q("update public.contacts set source_id = $2 where id = $1", [empty, adsSource]));
    expect((await pgError(asUser(member.id, (q) => q("update public.contacts set source_id = $2 where id = $1", [empty, formSource])))).hint).toBe("contact:first_source_locked");
    await asUser(admin.id, (q) => q("update public.contacts set source_id = $2 where id = $1", [set, adsSource]));
    expect((await contact(set)).source_id).toBe(adsSource);
    // campaign and utm of a contact are the server's (no client grant)
    expect((await pgError(asUser(owner.id, (q) => q("update public.contacts set campaign = 'x' where id = $1", [empty])))).code).toBe("42501");
  });

  it("a merge pick of a locked first source is for owners and admins only (a manager is refused)", async () => {
    const merge = (user: U, type: string, keep: string, dup: string, picks: Record<string, string>) =>
      asUser(user.id, (q) => q("select public.merge_records($1, $2, $3, $4, $5)", [org, type, keep, dup, JSON.stringify(picks)]));
    const managerLead = (fields: Record<string, unknown>) => insertLead(manager.id, org, { owner_id: manager.id, ...fields });
    // a manager: the kept lead's first source is set, so neither the source nor the campaign may be picked
    let keep = await managerLead({ source_id: formSource, campaign: "חורף" });
    let dup = await managerLead({ source_id: adsSource, campaign: "אביב" });
    expect((await pgError(merge(manager, "lead", keep, dup, { source_id: "merge" }))).hint).toBe("lead:first_source_locked");
    expect((await pgError(merge(manager, "lead", keep, dup, { campaign: "merge" }))).hint).toBe("lead:first_source_locked");
    // an admin may
    await merge(admin, "lead", keep, dup, { source_id: "merge", campaign: "merge" });
    expect(await lead(keep)).toMatchObject({ source_id: adsSource, campaign: "אביב" });
    // an empty first source on the kept lead: the manager fills it from the duplicate
    keep = await managerLead({});
    dup = await managerLead({ source_id: adsSource, campaign: "אביב" });
    await merge(manager, "lead", keep, dup, { source_id: "merge", campaign: "merge" });
    expect(await lead(keep)).toMatchObject({ source_id: adsSource, campaign: "אביב" });
    // contacts: the source
    const managerContact = (source: string | null) =>
      asUser(manager.id, async (q) =>
        (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, owner_id, source_id) values ($1, 'מיזוג', $2, $3) returning id", [org, manager.id, source])).rows[0].id,
      );
    const keepContact = await managerContact(formSource);
    const dupContact = await managerContact(adsSource);
    expect((await pgError(merge(manager, "contact", keepContact, dupContact, { source_id: "merge" }))).hint).toBe("contact:first_source_locked");
    await merge(admin, "contact", keepContact, dupContact, { source_id: "merge" });
    expect((await contact(keepContact)).source_id).toBe(adsSource);
  });

  it("an automation sets the source of a lead or contact only while its first source is empty (warning otherwise)", async () => {
    const run = async (entity: string, recordId: string, value: string) => {
      const rule = await asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'מקור', $2, 'created', $3, false) returning id",
            [org, entity, JSON.stringify([{ type: "set_field", field: "source_id", value }])],
          )
        ).rows[0].id,
      );
      await asUser(owner.id, (q) => q("select public.run_automation_now($1, $2)", [rule, recordId]));
      return asAdmin(async (q) => (await q<{ steps: Array<Record<string, unknown>> }>("select steps from public.automation_runs where automation_id = $1", [rule])).rows[0].steps[0]);
    };
    const emptyLead = await insertLead(member.id, org, { owner_id: member.id });
    expect(await run("lead", emptyLead, adsSource)).toEqual({ action: "set_field", status: "ok" });
    expect((await lead(emptyLead)).source_id).toBe(adsSource);
    expect(await run("lead", emptyLead, formSource)).toEqual({ action: "set_field", status: "ok", warning: "the first source is already set" });
    expect((await lead(emptyLead)).source_id).toBe(adsSource);
    const campaignOnly = await insertLead(member.id, org, { owner_id: member.id, campaign: "רק קמפיין" });
    expect((await run("lead", campaignOnly, formSource)).warning).toBe("the first source is already set");
    expect((await lead(campaignOnly)).source_id).toBeNull();
    const c = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, source_id) values ($1, 'אוטו', $2) returning id", [org, formSource])).rows[0].id,
    );
    expect((await run("contact", c, adsSource)).warning).toBe("the first source is already set");
    expect((await contact(c)).source_id).toBe(formSource);
  });

  it("DQL-04: an owner or admin may change it, and the change is in the audit log with old and new", async () => {
    const id = await insertLead(member.id, org, { owner_id: member.id, source_id: formSource, campaign: "חורף" });
    await asUser(admin.id, (q) => q("update public.leads set source_id = $2, campaign = 'אביב' where id = $1", [id, adsSource]));
    await asUser(owner.id, (q) => q("update public.leads set campaign = 'קיץ' where id = $1", [id]));
    expect(await lead(id)).toMatchObject({ source_id: adsSource, campaign: "קיץ" });
    const entries = await asAdmin(
      async (q) =>
        (
          await q<{ actor_id: string; changes: Record<string, unknown> }>(
            "select actor_id, changes from public.audit_log where entity_id = $1 and action = 'update' order by created_at, id",
            [id],
          )
        ).rows,
    );
    expect(entries).toEqual([
      { actor_id: admin.id, changes: { source_id: { old: formSource, new: adsSource }, campaign: { old: "חורף", new: "אביב" } } },
      { actor_id: owner.id, changes: { campaign: { old: "אביב", new: "קיץ" } } },
    ]);
  });

  it("server writes pass the lock: removing a source empties both first and last", async () => {
    const tmp = await asAdmin(async (q) => (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'זמני') returning id", [org])).rows[0].id);
    const tmpForm = await asUser(owner.id, async (q) =>
      (await q<{ token: string }>("insert into public.forms (organization_id, name, source_id) values ($1, 'זמני', $2) returning token", [org, tmp])).rows[0].token,
    );
    const r = await submit(tmpForm, { full_name: "זמני", phone: "0521000009" });
    await asAdmin(async (q) => {
      await q("update public.forms set source_id = null where source_id = $1", [tmp]);
      await q("delete from public.lead_sources where id = $1", [tmp]);
    });
    expect(await lead(r.lead_id as string)).toMatchObject({ source_id: null, last_source_id: null });
  });

  it("leads off: the form's new contact gets its first and last source, and a repeat inquiry moves the last one", async () => {
    await setLeadsOn(false);
    try {
      await submit(form.token, { full_name: "נטע לוי", phone: "0521000003", attribution: { utm_source: "google", utm_campaign: "חורף" } });
      const id = (await contactByPhone("+972521000003")) as string;
      expect(await contact(id)).toMatchObject({
        source_id: formSource,
        campaign: "חורף",
        utm: { utm_source: "google", utm_campaign: "חורף" },
        last_source_id: formSource,
        last_campaign: "חורף",
      });
      await submit(adsForm.token, { full_name: "נטע לוי", phone: "0521000003", attribution: { utm_campaign: "אביב" } });
      expect(await contact(id)).toMatchObject({ source_id: formSource, campaign: "חורף", last_source_id: adsSource, last_campaign: "אביב", last_utm: { utm_campaign: "אביב" } });
    } finally {
      await setLeadsOn(true);
    }
  });

  it("booking page: a new lead takes the page's source; a repeat booking moves the last source to the page with its title", async () => {
    await book(at(dayAhead(3), "10:00"), "0521000004", "שירה", { utm_campaign: "תורים" });
    const id = (await leadByPhone("+972521000004")) as string;
    expect(await lead(id)).toMatchObject({ source_id: bookingSource, campaign: "תורים", last_source_id: bookingSource, last_campaign: "תורים" });

    const other = await submit(adsForm.token, { full_name: "יעל", phone: "0521000005" });
    await book(at(dayAhead(3), "12:00"), "0521000005", "יעל");
    expect(await lead(other.lead_id as string)).toMatchObject({ source_id: adsSource, last_source_id: bookingSource, last_campaign: "תורים באתר", last_utm: null });
  });

  it("booking page with leads off: the new contact gets the page's source as first and last", async () => {
    await setLeadsOn(false);
    try {
      await book(at(dayAhead(4), "10:00"), "0521000006", "מיכל");
      const id = (await contactByPhone("+972521000006")) as string;
      expect(await contact(id)).toMatchObject({ source_id: bookingSource, campaign: "תורים באתר", last_source_id: bookingSource, last_campaign: "תורים באתר" });
    } finally {
      await setLeadsOn(true);
    }
  });

  it("conversion: the contact gets the lead's first and last source", async () => {
    const first = await submit(form.token, { full_name: "אורי", phone: "0521000007", attribution: { utm_campaign: "חורף", utm_source: "google" } });
    const id = first.lead_id as string;
    await submit(adsForm.token, { full_name: "אורי", phone: "0521000007", attribution: { utm_campaign: "אביב" } });
    const result = await asUser(owner.id, async (q) => (await q<{ r: { contact_id: string } }>("select public.convert_lead($1, false) as r", [id])).rows[0].r);
    expect(await contact(result.contact_id)).toMatchObject({
      source_id: formSource,
      campaign: "חורף",
      utm: { utm_campaign: "חורף", utm_source: "google" },
      last_source_id: adsSource,
      last_campaign: "אביב",
    });
    // after conversion an inquiry reaches both the lead and its contact
    await submit(form.token, { full_name: "אורי", phone: "0521000007", attribution: { utm_campaign: "קיץ" } });
    expect((await lead(id)).last_campaign).toBe("קיץ");
    expect((await contact(result.contact_id)).last_campaign).toBe("קיץ");
  });

  it("revenue by first source and campaign: the converted lead's source, else the contact's, else the deal's own", async () => {
    const from = new Date(Date.now() - DAY).toISOString();
    const to = new Date(Date.now() + DAY).toISOString();
    const pipeline = await asAdmin(async (q) => {
      const p = (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id;
      const won = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'won' limit 1", [p])).rows[0].id;
      const open = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'open' order by position limit 1", [p])).rows[0].id;
      return { id: p, won, open };
    });
    const win = (deal: string) => asUser(owner.id, (q) => q("update public.deals set stage_id = $2 where id = $1", [deal, pipeline.won]));

    // 1: a lead (first: form, חורף) converted into a deal of 1,000, then a later inquiry from Facebook
    const l1 = (await submit(form.token, { full_name: "א", phone: "0521000101", attribution: { utm_campaign: "חורף" } })).lead_id as string;
    await submit(adsForm.token, { full_name: "א", phone: "0521000101", attribution: { utm_campaign: "אביב" } });
    const d1 = await asUser(owner.id, async (q) => (await q<{ r: { deal_id: string } }>("select public.convert_lead($1, true, null, 100000) as r", [l1])).rows[0].r.deal_id);
    await win(d1);
    // 2: a deal on a contact with a source (Facebook, no campaign), 500
    const c2 = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, source_id) values ($1, 'ב', $2) returning id", [org, adsSource])).rows[0].id,
    );
    const d2 = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, contact_id) values ($1, 'עסקה ב', 50000, $2, $4, $3) returning id", [org, pipeline.id, c2, pipeline.open])).rows[0].id,
    );
    await win(d2);
    // 4: a lead with no first source converted into a deal of 300; its new contact got a source later (Facebook): the chain
    // falls to the contact
    const l4 = await insertLead(owner.id, org, { full_name: "ד" });
    const r4 = await asUser(owner.id, async (q) => (await q<{ r: { deal_id: string; contact_id: string } }>("select public.convert_lead($1, true, null, 30000) as r", [l4])).rows[0].r);
    await asUser(owner.id, (q) => q("update public.contacts set source_id = $2 where id = $1", [r4.contact_id, adsSource]));
    await win(r4.deal_id);
    // 3: a deal with no lead or contact, its own source (form), 200
    const d3 = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, source_id) values ($1, 'עסקה ג', 20000, $2, $4, $3) returning id", [org, pipeline.id, formSource, pipeline.open])).rows[0].id,
    );
    await win(d3);

    const report = await asUser(owner.id, async (q) =>
      (await q<{ r: { totals: Record<string, number>; by_source: Array<Record<string, unknown>>; by_campaign: Array<Record<string, unknown>> } }>(
        "select public.report_revenue_by_source($1, $2, $3) as r",
        [org, from, to],
      )).rows[0].r,
    );
    // other tests in this file won nothing, so the report holds exactly these four
    expect(report.totals).toEqual({ deals: 4, amount: 200000, from_lead: 1, from_contact: 2, from_deal: 1, without_source: 0 });
    expect(report.by_source).toEqual([
      { source_id: formSource, source_name: expect.any(String), deals: 2, amount: 120000 },
      { source_id: adsSource, source_name: "פייסבוק", deals: 2, amount: 80000 },
    ]);
    expect(report.by_campaign).toEqual([
      { source_id: formSource, source_name: expect.any(String), campaign: "חורף", deals: 1, amount: 100000 },
      { source_id: adsSource, source_name: "פייסבוק", campaign: null, deals: 2, amount: 80000 },
      { source_id: formSource, source_name: expect.any(String), campaign: null, deals: 1, amount: 20000 },
    ]);
    // RLS decides what is counted: someone outside the business counts nothing
    const outsiderView = await asUser(outsider.id, async (q) =>
      (await q<{ r: { totals: Record<string, number> } }>("select public.report_revenue_by_source($1, $2, $3) as r", [org, from, to])).rows[0].r,
    );
    expect(outsiderView.totals.deals).toBe(0);
  });

  it("another business's inquiries never touch this business's records", async () => {
    const otherForm = await asUser(outsider.id, async (q) =>
      (await q<{ token: string }>("insert into public.forms (organization_id, name) values ($1, 'זר') returning token", [otherOrg])).rows[0].token,
    );
    const id = (await submit(form.token, { full_name: "חן", phone: "0521000201", attribution: { utm_campaign: "שלנו" } })).lead_id as string;
    await submit(otherForm, { full_name: "חן", phone: "0521000201", attribution: { utm_campaign: "שלהם" } });
    expect((await lead(id)).last_campaign).toBe("שלנו");
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and last_campaign = 'שלהם'", [otherOrg]))).toBe(1);
  });

  it("the report key may be exported", async () => {
    await asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'source_revenue', 3, 'csv')", [org]));
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'export' and changes ->> 'report' = 'source_revenue'", [org]))).toBe(1);
  });
});
