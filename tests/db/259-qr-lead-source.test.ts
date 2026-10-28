import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Reply = Record<string, unknown>;
type Source = { source_id: string | null; campaign: string | null; last_source_id: string | null };

const DAY = 86_400_000;
const ALL_WEEK = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "00:00", end: "23:59" }]]));
const dayAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00Z`).toISOString();
const QR = { utm_source: "qr", utm_campaign: "שלט בחנות" };

/**
 * BIZ-03 follow-up (owner, 18 October 2026, answer (1)): an inquiry that arrives through a QR code (utm_source=qr) gets ONE
 * lead source, "קוד QR" (kind 'qr'), made once per business when first needed. A web form's or booking page's own source
 * wins; the generic defaults ("דף קביעת תור", a card form's "כרטיס ביקור") give way to it.
 */
describe("the QR code lead source (BIZ-03)", () => {
  let owner: U, member: U, outsider: U;
  let org: string, otherOrg: string;
  let fixedSource: string;
  let bare: { id: string; token: string };
  let fixed: { id: string; token: string };
  let otherBare: { id: string; token: string };
  let cardForm: { token: string; source_id: string };
  let page: { id: string; token: string };
  let fixedPage: { id: string; token: string };

  const submit = (token: string, payload: Record<string, unknown>, kind = "form") =>
    asService(async (q) => (await q<{ r: Reply }>("select public.intake_submit($1, $2, $3) as r", [token, kind, JSON.stringify(payload)])).rows[0].r);
  const book = (token: string, startsAt: string, phone: string, attribution: Record<string, string> = {}) =>
    asService(async (q) =>
      (await q<{ r: Reply }>("select public.booking_submit($1, $2, $3, null) as r", [token, startsAt, JSON.stringify({ full_name: "לקוחה", phone, attribution })])).rows[0].r,
    );
  const lead = (id: string) =>
    asAdmin(async (q) => (await q<Source>("select source_id, campaign, last_source_id from public.leads where id = $1", [id])).rows[0]);
  const byPhone = (table: "leads" | "contacts", o: string, e164: string) =>
    asAdmin(async (q) => (await q<Source>(`select source_id, campaign, last_source_id from public.${table} where organization_id = $1 and phone_e164 = $2`, [o, e164])).rows[0]);
  const qrSources = (o: string) =>
    asAdmin(async (q) => (await q<{ id: string; name: string; kind: string }>("select id, name, kind from public.lead_sources where organization_id = $1 and kind = 'qr' order by created_at", [o])).rows);
  const setLeadsOn = (on: boolean) =>
    asAdmin((q) =>
      q(
        `insert into public.org_modules (organization_id, leads_enabled) values ($1, $2)
         on conflict (organization_id) do update set leads_enabled = $2`,
        [org, on],
      ),
    );

  beforeAll(async () => {
    owner = await createUser("qrs-owner");
    org = await createOrg(owner.id, "עסק הסריקות");
    member = await addMember(org, owner.id, "member", "qrs-member");
    outsider = await createUser("qrs-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await asAdmin(async (q) => {
      await q("update public.organizations set timezone = 'UTC' where id = $1", [org]);
      await q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions, working_hours)
         values ($1, '{}', false, false, '{}', $2)
         on conflict (organization_id) do update set rest_weekdays = '{}', holidays_rest = false, holiday_eves_rest = false, rest_occasions = '{}', working_hours = $2`,
        [org, JSON.stringify(ALL_WEEK)],
      );
      fixedSource = (await q<{ id: string }>("select id from public.lead_sources where organization_id = $1 and kind = 'form'", [org])).rows[0].id;
    });
    await asUser(owner.id, async (q) => {
      bare = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name, owner_id) values ($1, 'טופס בלי מקור', $2) returning id, token", [org, member.id])).rows[0];
      fixed = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name, source_id, owner_id) values ($1, 'טופס באתר', $2, $3) returning id, token", [org, fixedSource, member.id])).rows[0];
      const type = (await q<{ id: string }>("insert into public.meeting_types (organization_id, name, duration_minutes) values ($1, 'ייעוץ', 60) returning id", [org])).rows[0].id;
      page = (
        await q<{ id: string; token: string }>(
          "insert into public.booking_pages (organization_id, user_id, title, meeting_type_id, min_notice_minutes, max_days_ahead, slot_step_minutes) values ($1, $2, 'תורים', $3, 0, 30, 60) returning id, token",
          [org, member.id, type],
        )
      ).rows[0];
      fixedPage = (
        await q<{ id: string; token: string }>(
          "insert into public.booking_pages (organization_id, user_id, title, meeting_type_id, min_notice_minutes, max_days_ahead, slot_step_minutes, source_id) values ($1, $2, 'תורים במקור', $3, 0, 30, 60, $4) returning id, token",
          [org, owner.id, type, fixedSource],
        )
      ).rows[0];
      const card = (await q<{ id: string }>("insert into public.business_cards (organization_id, user_id) values ($1, $2) returning id", [org, member.id])).rows[0].id;
      cardForm = (await q<{ token: string; source_id: string }>("select token, source_id from public.forms where organization_id = $1 and business_card_id = $2", [org, card])).rows[0];
    });
    await asUser(outsider.id, async (q) => {
      otherBare = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name, owner_id) values ($1, 'טופס זר', $2) returning id, token", [otherOrg, outsider.id])).rows[0];
    });
  });

  it("is not there before the first QR inquiry: nothing is seeded", async () => {
    expect(await qrSources(org)).toEqual([]);
  });

  it("a QR-tagged inquiry through a form with no source gets 'קוד QR', made once and reused", async () => {
    const first = await submit(bare.token, { full_name: "דנה", phone: "0522000001", attribution: QR });
    const sources = await qrSources(org);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ name: "קוד QR", kind: "qr" });
    expect(await lead(first.lead_id as string)).toMatchObject({ source_id: sources[0].id, campaign: "שלט בחנות", last_source_id: sources[0].id });

    const second = await submit(bare.token, { full_name: "רון", phone: "0522000002", attribution: { utm_source: "qr" } });
    expect((await lead(second.lead_id as string)).source_id).toBe(sources[0].id);
    expect(await qrSources(org)).toHaveLength(1);
  });

  it("a form's own source wins over the QR tag", async () => {
    const r = await submit(fixed.token, { full_name: "שירה", phone: "0522000003", attribution: QR });
    expect(await lead(r.lead_id as string)).toMatchObject({ source_id: fixedSource, campaign: "שלט בחנות", last_source_id: fixedSource });
  });

  it("without utm_source=qr nothing changes", async () => {
    const none = await submit(bare.token, { full_name: "אבי", phone: "0522000004" });
    expect(await lead(none.lead_id as string)).toMatchObject({ source_id: null, last_source_id: null });
    const google = await submit(bare.token, { full_name: "בני", phone: "0522000005", attribution: { utm_source: "google", utm_campaign: "qr" } });
    expect(await lead(google.lead_id as string)).toMatchObject({ source_id: null, last_source_id: null });
    const upper = await submit(bare.token, { full_name: "גיל", phone: "0522000006", attribution: { utm_source: "QR-code" } });
    expect((await lead(upper.lead_id as string)).source_id).toBeNull();
  });

  it("a repeat QR inquiry moves only the last source to 'קוד QR'", async () => {
    const r = await submit(fixed.token, { full_name: "מיה", phone: "0522000007" });
    await submit(bare.token, { full_name: "מיה", phone: "0522000007", attribution: QR });
    const [qr] = await qrSources(org);
    expect(await lead(r.lead_id as string)).toMatchObject({ source_id: fixedSource, last_source_id: qr.id });
  });

  it("a renamed or switched-off source is still the one used, found by its kind", async () => {
    const [qr] = await qrSources(org);
    await asUser(owner.id, (q) => q("update public.lead_sources set name = 'סריקת שלט', is_active = false where id = $1", [qr.id]));
    const r = await submit(bare.token, { full_name: "טל", phone: "0522000008", attribution: QR });
    expect((await lead(r.lead_id as string)).source_id).toBe(qr.id);
    expect(await qrSources(org)).toHaveLength(1);
    await asUser(owner.id, (q) => q("update public.lead_sources set name = 'קוד QR', is_active = true where id = $1", [qr.id]));
  });

  it("a deleted source is made again on the next QR inquiry", async () => {
    const [old] = await qrSources(org);
    await asUser(owner.id, (q) => q("delete from public.lead_sources where id = $1", [old.id]));
    expect(await qrSources(org)).toEqual([]);
    const r = await submit(bare.token, { full_name: "נוי", phone: "0522000009", attribution: QR });
    const now = await qrSources(org);
    expect(now).toHaveLength(1);
    expect(now[0].id).not.toBe(old.id);
    expect(now[0].name).toBe("קוד QR");
    expect((await lead(r.lead_id as string)).source_id).toBe(now[0].id);
  });

  it("a business card's form: 'קוד QR' replaces the card's generic source only for a QR visit", async () => {
    const [qr] = await qrSources(org);
    const tagged = await submit(cardForm.token, { full_name: "עדי", phone: "0522000010", attribution: QR }, "card");
    expect((await lead(tagged.lead_id as string)).source_id).toBe(qr.id);
    const plain = await submit(cardForm.token, { full_name: "עמית", phone: "0522000011" }, "card");
    expect((await lead(plain.lead_id as string)).source_id).toBe(cardForm.source_id);
  });

  it("booking page: no page source + QR = 'קוד QR'; no tag = 'דף קביעת תור'; the page's own source wins", async () => {
    const [qr] = await qrSources(org);
    expect((await book(page.token, at(dayAhead(2), "09:00"), "0522000012", QR)).status).toBe("booked");
    expect(await byPhone("leads", org, "+972522000012")).toMatchObject({ source_id: qr.id, last_source_id: qr.id });

    expect((await book(page.token, at(dayAhead(2), "11:00"), "0522000013")).status).toBe("booked");
    const generic = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.lead_sources where organization_id = $1 and kind = 'booking'", [org])).rows[0].id);
    expect((await byPhone("leads", org, "+972522000013")).source_id).toBe(generic);

    expect((await book(fixedPage.token, at(dayAhead(2), "13:00"), "0522000014", QR)).status).toBe("booked");
    expect((await byPhone("leads", org, "+972522000014")).source_id).toBe(fixedSource);
    expect(await qrSources(org)).toHaveLength(1);
  });

  it("leads off: the new contact gets 'קוד QR' as first and last source, through a form and a booking page", async () => {
    await setLeadsOn(false);
    try {
      const [qr] = await qrSources(org);
      await submit(bare.token, { full_name: "ליה כהן", phone: "0522000015", attribution: QR });
      expect(await byPhone("contacts", org, "+972522000015")).toMatchObject({ source_id: qr.id, last_source_id: qr.id });
      expect((await book(page.token, at(dayAhead(3), "09:00"), "0522000016", QR)).status).toBe("booked");
      expect(await byPhone("contacts", org, "+972522000016")).toMatchObject({ source_id: qr.id, last_source_id: qr.id });
    } finally {
      await setLeadsOn(true);
    }
  });

  it("another business is untouched: its own QR inquiry makes its own source", async () => {
    const before = await qrSources(otherOrg);
    expect(before).toEqual([]);
    const r = await submit(otherBare.token, { full_name: "זר", phone: "0522000017", attribution: QR });
    const theirs = await qrSources(otherOrg);
    expect(theirs).toHaveLength(1);
    const [ours] = await qrSources(org);
    expect(theirs[0].id).not.toBe(ours.id);
    expect((await asAdmin(async (q) => (await q<{ organization_id: string; source_id: string }>("select organization_id, source_id from public.leads where id = $1", [r.lead_id])).rows[0]))).toEqual({
      organization_id: otherOrg,
      source_id: theirs[0].id,
    });
    expect(await qrSources(org)).toHaveLength(1);
  });

  it("the helpers are not callable from the API", async () => {
    const grants = await asAdmin(async (q) =>
      (
        await q<{ fn: string; role: string }>(
          `select p.proname as fn, r.rolname as role from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            cross join pg_roles r
            where n.nspname = 'app' and p.proname in ('qr_lead_source', 'intake_qr_source')
              and r.rolname in ('anon', 'authenticated', 'service_role') and has_function_privilege(r.oid, p.oid, 'execute')`,
        )
      ).rows,
    );
    expect(grants).toEqual([]);
  });
});
