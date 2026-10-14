import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Channel = { preferred_channel: string | null; preferred_channel_source: string | null };

const submit = (token: string, payload: Record<string, unknown>, kind = "form") =>
  asService(async (q) => {
    const res = await q<{ result: { status: string; lead_id?: string; contact_id?: string } }>(
      "select public.intake_submit($1, $2, $3, null, null, false) as result",
      [token, kind, JSON.stringify(payload)],
    );
    return res.rows[0].result;
  });

const channelOf = (table: "leads" | "contacts", id: string) =>
  asAdmin(async (q) => (await q<Channel>(`select preferred_channel, preferred_channel_source from public.${table} where id = $1`, [id])).rows[0]);

// CON-10 follow-up (owner, 14 October 2026): a public form may ask how the person likes to be contacted.
// The answer fills an empty channel or replaces one that came from a form; a person's value stays.
describe("preferred channel from a public form (CON-10)", () => {
  let owner: U, admin: U, member: U, viewer: U;
  let org: string;
  let form: { id: string; token: string };
  let quiet: { id: string; token: string };
  let webhook: { id: string; token: string };

  beforeAll(async () => {
    owner = await createUser("pcf-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "pcf-admin");
    member = await addMember(org, owner.id, "member", "pcf-member");
    viewer = await addMember(org, owner.id, "viewer", "pcf-viewer");
    await asUser(owner.id, async (q) => {
      form = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name, owner_id) values ($1, 'שואל ערוץ', $2) returning id, token", [org, member.id])).rows[0];
      quiet = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name, owner_id) values ($1, 'לא שואל', $2) returning id, token", [org, member.id])).rows[0];
      webhook = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, kind, name, channel_choice) values ($1, 'webhook', 'Zapier', true) returning id, token", [org])).rows[0];
    });
  });

  describe("grants and the source rule", () => {
    it("owners and admins switch the question on; a member or viewer cannot", async () => {
      expect((await asUser(admin.id, (q) => q("update public.forms set channel_choice = true where id = $1 returning id", [form.id]))).rowCount).toBe(1);
      for (const who of [member, viewer]) {
        expect((await asUser(who.id, (q) => q("update public.forms set channel_choice = false where id = $1 returning id", [form.id]))).rowCount).toBe(0);
      }
      expect(await asAdmin(async (q) => (await q<{ c: boolean }>("select channel_choice as c from public.forms where id = $1", [form.id])).rows[0].c)).toBe(true);
      expect(await asAdmin(async (q) => (await q<{ c: boolean }>("select channel_choice as c from public.forms where id = $1", [quiet.id])).rows[0].c)).toBe(false);
    });

    it("a client writes a lead's channel (only the four values) but never the source", async () => {
      const lead = await insertLead(member.id, org, { full_name: "ליד ידני", preferred_channel: "sms" });
      expect(await channelOf("leads", lead)).toEqual({ preferred_channel: "sms", preferred_channel_source: "manual" });
      const bad = await pgError(asUser(member.id, (q) => q("update public.leads set preferred_channel = 'fax' where id = $1", [lead])));
      expect(bad.code).toBe("23514");
      for (const table of ["leads", "contacts"]) {
        const forged = await pgError(asUser(owner.id, (q) => q(`update public.${table} set preferred_channel_source = 'form' where organization_id = $1`, [org])));
        expect(forged.code, table).toBe("42501");
      }
      const forgedInsert = await pgError(
        asUser(owner.id, (q) => q("insert into public.contacts (organization_id, first_name, preferred_channel, preferred_channel_source) values ($1, 'x', 'sms', 'form')", [org])),
      );
      expect(forgedInsert.code).toBe("42501");
      // a viewer writes nothing
      expect((await asUser(viewer.id, (q) => q("update public.leads set preferred_channel = 'email' where id = $1 returning id", [lead]))).rowCount).toBe(0);
    });

    it("a person's change marks it manual; an unchanged save keeps the source; clearing empties both", async () => {
      const lead = await insertLead(member.id, org, { full_name: "ליד בלי ערוץ" });
      expect(await channelOf("leads", lead)).toEqual({ preferred_channel: null, preferred_channel_source: null });
      // a server write (as a form would) leaves its own source
      await asAdmin((q) => q("update public.leads set preferred_channel = 'phone', preferred_channel_source = 'form' where id = $1", [lead]));
      expect(await channelOf("leads", lead)).toEqual({ preferred_channel: "phone", preferred_channel_source: "form" });
      // the card saved with the same value: still a form's value
      await asUser(member.id, (q) => q("update public.leads set preferred_channel = 'phone', full_name = 'ליד שנשמר' where id = $1", [lead]));
      expect(await channelOf("leads", lead)).toEqual({ preferred_channel: "phone", preferred_channel_source: "form" });
      await asUser(member.id, (q) => q("update public.leads set preferred_channel = 'email' where id = $1", [lead]));
      expect(await channelOf("leads", lead)).toEqual({ preferred_channel: "email", preferred_channel_source: "manual" });
      await asUser(member.id, (q) => q("update public.leads set preferred_channel = null where id = $1", [lead]));
      expect(await channelOf("leads", lead)).toEqual({ preferred_channel: null, preferred_channel_source: null });
      // an empty channel never keeps a source, whoever writes it
      await asAdmin((q) => q("update public.leads set preferred_channel_source = 'form' where id = $1", [lead]));
      expect(await channelOf("leads", lead)).toEqual({ preferred_channel: null, preferred_channel_source: null });
    });
  });

  describe("intake", () => {
    it("intake_form() says whether the form asks", async () => {
      const read = (token: string) => asService(async (q) => (await q<{ f: { channel_choice: boolean } }>("select public.intake_form($1) as f", [token])).rows[0].f.channel_choice);
      expect(await read(form.token)).toBe(true);
      expect(await read(quiet.token)).toBe(false);
    });

    it("a new lead keeps the form's channel with source 'form'; an unknown value or a form that does not ask keeps none", async () => {
      const asked = await submit(form.token, { full_name: "נועה", phone: "050-9100001", preferred_channel: "whatsapp" });
      expect(asked.status).toBe("accepted");
      expect(await channelOf("leads", asked.lead_id!)).toEqual({ preferred_channel: "whatsapp", preferred_channel_source: "form" });
      const unknown = await submit(form.token, { full_name: "רון", phone: "050-9100002", preferred_channel: "fax" });
      expect(await channelOf("leads", unknown.lead_id!)).toEqual({ preferred_channel: null, preferred_channel_source: null });
      const notAsked = await submit(quiet.token, { full_name: "טל", phone: "050-9100003", preferred_channel: "email" });
      expect(await channelOf("leads", notAsked.lead_id!)).toEqual({ preferred_channel: null, preferred_channel_source: null });
      const hook = await submit(webhook.token, { full_name: "גל", phone: "050-9100004", preferred_channel: "email" }, "webhook");
      expect(await channelOf("leads", hook.lead_id!)).toEqual({ preferred_channel: null, preferred_channel_source: null });
    });

    it("a repeat inquiry onto a lead: fills an empty channel, replaces a form's, never a person's", async () => {
      // empty: filled
      const empty = await insertLead(member.id, org, { full_name: "ריק", phone: "050-9200001" });
      const repeat = await submit(form.token, { full_name: "פונה", phone: "050-9200001", preferred_channel: "sms" });
      expect(repeat).toMatchObject({ status: "duplicate", lead_id: empty });
      expect(await channelOf("leads", empty)).toEqual({ preferred_channel: "sms", preferred_channel_source: "form" });
      // from a form: the new choice replaces it
      await submit(form.token, { full_name: "פונה", phone: "050-9200001", preferred_channel: "email" });
      expect(await channelOf("leads", empty)).toEqual({ preferred_channel: "email", preferred_channel_source: "form" });
      // no choice on the repeat: unchanged
      await submit(form.token, { full_name: "פונה", phone: "050-9200001" });
      expect(await channelOf("leads", empty)).toEqual({ preferred_channel: "email", preferred_channel_source: "form" });
      // set by a person: unchanged
      const manual = await insertLead(member.id, org, { full_name: "ידני", phone: "050-9200002", preferred_channel: "phone" });
      await submit(form.token, { full_name: "פונה", phone: "050-9200002", preferred_channel: "whatsapp" });
      expect(await channelOf("leads", manual)).toEqual({ preferred_channel: "phone", preferred_channel_source: "manual" });
      // the inquiry keeps the choice on the timeline
      const meta = await asAdmin(async (q) =>
        (await q<{ m: { preferred_channel?: string } }>("select metadata as m from public.activities where lead_id = $1 and type = 'inquiry' order by created_at desc limit 1", [manual])).rows[0].m,
      );
      expect(meta.preferred_channel).toBe("whatsapp");
    });

    it("a repeat inquiry onto a contact: the same rule, and a value older than its source counts as a person's", async () => {
      const contact = (phone: string, channel: string | null) =>
        asUser(member.id, async (q) =>
          (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, phone, preferred_channel) values ($1, 'איש קשר', $2, $3) returning id", [org, phone, channel])).rows[0].id,
        );
      const empty = await contact("050-9300001", null);
      expect(await submit(form.token, { full_name: "פונה", phone: "050-9300001", preferred_channel: "whatsapp" })).toMatchObject({ status: "duplicate", contact_id: empty });
      expect(await channelOf("contacts", empty)).toEqual({ preferred_channel: "whatsapp", preferred_channel_source: "form" });
      await submit(form.token, { full_name: "פונה", phone: "050-9300001", preferred_channel: "sms" });
      expect(await channelOf("contacts", empty)).toEqual({ preferred_channel: "sms", preferred_channel_source: "form" });
      const manual = await contact("050-9300002", "email");
      expect(await channelOf("contacts", manual)).toEqual({ preferred_channel: "email", preferred_channel_source: "manual" });
      await submit(form.token, { full_name: "פונה", phone: "050-9300002", preferred_channel: "sms" });
      expect(await channelOf("contacts", manual)).toEqual({ preferred_channel: "email", preferred_channel_source: "manual" });
      // a value written before the source existed (no source): kept
      const older = await contact("050-9300003", null);
      await asAdmin((q) => q("update public.contacts set preferred_channel = 'phone' where id = $1", [older]));
      expect(await channelOf("contacts", older)).toEqual({ preferred_channel: "phone", preferred_channel_source: null });
      await submit(form.token, { full_name: "פונה", phone: "050-9300003", preferred_channel: "sms" });
      expect(await channelOf("contacts", older)).toEqual({ preferred_channel: "phone", preferred_channel_source: null });
    });

    it("a converted lead's repeat inquiry updates the lead and the contact it became, each by its own source", async () => {
      const lead = (await submit(form.token, { full_name: "דן לוי", phone: "050-9400001", preferred_channel: "whatsapp" })).lead_id!;
      const converted = await asUser(member.id, async (q) =>
        (await q<{ r: { contact_id: string } }>("select public.convert_lead($1, false) as r", [lead])).rows[0].r,
      );
      // conversion carries the channel and its source
      expect(await channelOf("contacts", converted.contact_id)).toEqual({ preferred_channel: "whatsapp", preferred_channel_source: "form" });
      // a person then sets the contact's channel; the next form choice changes only the lead
      await asUser(member.id, (q) => q("update public.contacts set preferred_channel = 'phone' where id = $1", [converted.contact_id]));
      await submit(form.token, { full_name: "פונה", phone: "050-9400001", preferred_channel: "email" });
      expect(await channelOf("leads", lead)).toEqual({ preferred_channel: "email", preferred_channel_source: "form" });
      expect(await channelOf("contacts", converted.contact_id)).toEqual({ preferred_channel: "phone", preferred_channel_source: "manual" });
    });

    it("conversion carries a person's channel as manual, and nothing when the lead has none", async () => {
      const manual = await insertLead(member.id, org, { full_name: "שירה", phone: "050-9500001", preferred_channel: "sms" });
      const a = await asUser(member.id, async (q) => (await q<{ r: { contact_id: string } }>("select public.convert_lead($1, false) as r", [manual])).rows[0].r);
      expect(await channelOf("contacts", a.contact_id)).toEqual({ preferred_channel: "sms", preferred_channel_source: "manual" });
      const none = await insertLead(member.id, org, { full_name: "עומר", phone: "050-9500002" });
      const b = await asUser(member.id, async (q) => (await q<{ r: { contact_id: string } }>("select public.convert_lead($1, false) as r", [none])).rows[0].r);
      expect(await channelOf("contacts", b.contact_id)).toEqual({ preferred_channel: null, preferred_channel_source: null });
    });
  });
});
