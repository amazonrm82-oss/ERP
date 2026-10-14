import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// CON-10: a contact's preferred language (the 0002 column) and preferred channel (new), each null or
// one value of a closed list; both written by clients through the column grants (RVW-12).
describe("contact preferred language and channel (CON-10)", () => {
  let owner: U, member: U, viewer: U;
  let org: string, contact: string, memberContact: string;

  beforeAll(async () => {
    owner = await createUser("con10-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "con10-member");
    viewer = await addMember(org, owner.id, "viewer", "con10-viewer");
    contact = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'דנה') returning id", [org])).rows[0].id,
    );
    memberContact = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'רון') returning id", [org])).rows[0].id,
    );
  });

  const read = (id: string) =>
    asAdmin(async (q) =>
      (await q<{ preferred_locale: string | null; preferred_channel: string | null }>("select preferred_locale, preferred_channel from public.contacts where id = $1", [id]))
        .rows[0],
    );

  it("both start empty", async () => {
    expect(await read(contact)).toEqual({ preferred_locale: null, preferred_channel: null });
  });

  it("a client sets every listed value on insert and update, and clears them", async () => {
    for (const locale of ["he", "ar", "en", "ru", "am", "fr", "es"]) {
      const rows = await asUser(owner.id, async (q) => (await q("update public.contacts set preferred_locale = $2 where id = $1 returning id", [contact, locale])).rows);
      expect(rows, locale).toHaveLength(1);
      expect((await read(contact)).preferred_locale).toBe(locale);
    }
    for (const channel of ["phone", "whatsapp", "email", "sms"]) {
      const rows = await asUser(owner.id, async (q) => (await q("update public.contacts set preferred_channel = $2 where id = $1 returning id", [contact, channel])).rows);
      expect(rows, channel).toHaveLength(1);
      expect((await read(contact)).preferred_channel).toBe(channel);
    }
    const inserted = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.contacts (organization_id, first_name, preferred_locale, preferred_channel) values ($1, 'נועה', 'ar', 'sms') returning id",
          [org],
        )
      ).rows[0].id,
    );
    expect(await read(inserted)).toEqual({ preferred_locale: "ar", preferred_channel: "sms" });
    await asUser(owner.id, (q) => q("update public.contacts set preferred_locale = null, preferred_channel = null where id = $1", [contact]));
    expect(await read(contact)).toEqual({ preferred_locale: null, preferred_channel: null });
  });

  it("a value outside the lists is refused, by every writer", async () => {
    for (const [column, value] of [
      ["preferred_locale", "de"],
      ["preferred_locale", "HE"],
      ["preferred_locale", "he-IL"],
      ["preferred_locale", ""],
      ["preferred_channel", "fax"],
      ["preferred_channel", "WhatsApp"],
      ["preferred_channel", ""],
    ]) {
      const err = await pgError(asUser(owner.id, (q) => q(`update public.contacts set ${column} = $2 where id = $1`, [contact, value])));
      expect(err.code, `${column} = ${value}`).toBe("23514");
      const serverErr = await pgError(asAdmin((q) => q(`update public.contacts set ${column} = $2 where id = $1`, [contact, value])));
      expect(serverErr.code, `server ${column} = ${value}`).toBe("23514");
    }
    const insertErr = await pgError(
      asUser(owner.id, (q) => q("insert into public.contacts (organization_id, first_name, preferred_channel) values ($1, 'x', 'telegram')", [org])),
    );
    expect(insertErr.code).toBe("23514");
  });

  it("the constraints and grants are in place", async () => {
    const constraints = await asAdmin(async (q) =>
      (
        await q<{ conname: string }>(
          "select conname from pg_constraint where conrelid = 'public.contacts'::regclass and conname in ('contacts_preferred_locale_check', 'contacts_preferred_channel_check') order by conname",
        )
      ).rows.map((r) => r.conname),
    );
    expect(constraints).toEqual(["contacts_preferred_channel_check", "contacts_preferred_locale_check"]);
    const grants = await asAdmin(async (q) =>
      (
        await q<{ g: string }>(
          `select column_name || ':' || privilege_type as g from information_schema.column_privileges
            where table_schema = 'public' and table_name = 'contacts' and grantee = 'authenticated'
              and column_name in ('preferred_locale', 'preferred_channel') and privilege_type in ('INSERT', 'UPDATE', 'SELECT')
            order by 1`,
        )
      ).rows.map((r) => r.g),
    );
    expect(grants).toEqual([
      "preferred_channel:INSERT",
      "preferred_channel:SELECT",
      "preferred_channel:UPDATE",
      "preferred_locale:INSERT",
      "preferred_locale:SELECT",
      "preferred_locale:UPDATE",
    ]);
    const anon = await asAdmin(async (q) =>
      (
        await q<{ n: number }>(
          `select count(*)::int as n from information_schema.column_privileges
            where table_schema = 'public' and table_name = 'contacts' and grantee = 'anon' and column_name in ('preferred_locale', 'preferred_channel')`,
        )
      ).rows[0].n,
    );
    expect(anon).toBe(0);
  });

  it("the record's rights decide as before: a member edits their own, not someone else's; a viewer edits none", async () => {
    const own = await asUser(member.id, async (q) => (await q("update public.contacts set preferred_channel = 'whatsapp' where id = $1 returning id", [memberContact])).rows);
    expect(own).toHaveLength(1);
    const other = await asUser(member.id, async (q) => (await q("update public.contacts set preferred_channel = 'email' where id = $1 returning id", [contact])).rows);
    expect(other).toHaveLength(0);
    const viewed = await asUser(viewer.id, async (q) => (await q("update public.contacts set preferred_locale = 'en' where id = $1 returning id", [memberContact])).rows);
    expect(viewed).toHaveLength(0);
    expect(await read(memberContact)).toEqual({ preferred_locale: null, preferred_channel: "whatsapp" });
  });

  it("an outsider cannot change them", async () => {
    const stranger = await createUser("con10-stranger");
    await createOrg(stranger.id, "עסק אחר");
    const rows = await asUser(stranger.id, async (q) => (await q("update public.contacts set preferred_locale = 'fr' where id = $1 returning id", [memberContact])).rows);
    expect(rows).toHaveLength(0);
    expect((await read(memberContact)).preferred_locale).toBeNull();
  });

  it("a list export keeps a chosen language or channel in its audit entry", async () => {
    const f = {
      match: "all",
      groups: [
        {
          match: "all",
          conditions: [
            { field: "locale", op: "is", value: "ru" },
            { field: "channel", op: "is_not", value: "whatsapp" },
          ],
        },
      ],
    };
    await asUser(owner.id, (q) => q("select public.log_list_export($1, 'contact', 'csv', 1, 'filtered', $2)", [org, JSON.stringify({ f: JSON.stringify(f) })]));
    const conditions = await asAdmin(async (q) =>
      (
        await q<{ c: Array<{ value: unknown }> }>(
          "select changes #> '{filters,f,groups,0,conditions}' as c from public.audit_log where organization_id = $1 and action = 'export' order by id desc limit 1",
          [org],
        )
      ).rows[0].c,
    );
    expect(conditions.map((c) => c.value)).toEqual(["ru", "whatsapp"]);
  });
});
