import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// CON-01: a contact has a primary phone and email on its own row (contacts.phone / email, with a type each)
// and further ones in public.contact_channels, each with a type. Duplicates, search and repeat inquiries
// match on all of them; changes are audited on the contact; a merge keeps the duplicate's ones.
describe("more phones and emails per contact (CON-01)", () => {
  let owner: U, member: U, other: U;
  let org: string;

  const newContact = (u: U, fields: Record<string, unknown>) =>
    asUser(u.id, async (q) => {
      const row = { organization_id: org, ...fields };
      const cols = Object.keys(row);
      return (
        await q<{ id: string }>(
          `insert into public.contacts (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
          Object.values(row),
        )
      ).rows[0].id;
    });
  const addChannel = (u: U, contact: string, kind: string, value: string, label = "other", position = 0) =>
    asUser(u.id, async (q) =>
      (
        await q<{ id: string; value: string; value_e164: string | null }>(
          "insert into public.contact_channels (organization_id, contact_id, kind, label, value, position) values ($1, $2, $3, $4, $5, $6) returning id, value, value_e164",
          [org, contact, kind, label, value, position],
        )
      ).rows[0],
    );
  const channelsOf = (contact: string) =>
    asAdmin(async (q) =>
      (
        await q<{ kind: string; label: string; value: string }>(
          `select kind, label, value from public.contact_channels where contact_id = $1 order by kind collate "C", value collate "C"`,
          [contact],
        )
      ).rows,
    );

  beforeAll(async () => {
    owner = await createUser("ch-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "ch-member");
    other = await addMember(org, owner.id, "member", "ch-other");
  });

  it("normalizes the value; a client cannot write the normalized number", async () => {
    const c = await newContact(member, { first_name: "דנה", phone: "050-1000001", phone_type: "mobile" });
    const phone = await addChannel(member, c, "phone", " 03-555 1234 ", "work");
    expect(phone.value).toBe("03-555 1234");
    expect(phone.value_e164).toBe("+97235551234");
    const email = await addChannel(member, c, "email", " Dana@Work.Example ", "work");
    expect(email.value).toBe("dana@work.example");
    expect(email.value_e164).toBeNull();
    const forged = await pgError(
      asUser(member.id, (q) =>
        q("insert into public.contact_channels (organization_id, contact_id, kind, value, value_e164) values ($1, $2, 'phone', '052-1', '+1')", [org, c]),
      ),
    );
    expect(forged.code).toBe("42501");
    const forgedUpdate = await pgError(asUser(member.id, (q) => q("update public.contact_channels set value_e164 = '+1' where id = $1", [phone.id])));
    expect(forgedUpdate.code).toBe("42501");
  });

  it("checks type, value, repeats and the limit", async () => {
    const c = await newContact(member, { first_name: "רון", phone: "050-2000002", email: "ron@example.test" });
    // an email has no "mobile"; a phone needs digits; an email must look like one
    expect((await pgError(addChannel(member, c, "email", "a@b.example", "mobile"))).code).toBe("23514");
    expect((await pgError(addChannel(member, c, "phone", "אין מספר"))).code).toBe("23514");
    expect((await pgError(addChannel(member, c, "email", "not-an-email"))).code).toBe("23514");
    // the primary again, in another spelling
    const primary = await pgError(addChannel(member, c, "phone", "+972 50 200 0002"));
    expect(primary.hint).toBe("contact_channel:primary");
    expect((await pgError(addChannel(member, c, "email", "RON@example.test"))).hint).toBe("contact_channel:primary");
    // the same further number twice
    await addChannel(member, c, "phone", "052-3000003");
    expect((await pgError(addChannel(member, c, "phone", "0523000003"))).code).toBe("23505");
    // a value changed into the primary is refused too
    const second = await addChannel(member, c, "phone", "052-3000004");
    expect(
      (await pgError(asUser(member.id, (q) => q("update public.contact_channels set value = '050-2000002' where id = $1", [second.id])))).hint,
    ).toBe("contact_channel:primary");
    // at most 10 of a kind
    for (let i = 5; i <= 12; i++) await addChannel(member, c, "phone", `052-30000${String(i).padStart(2, "0")}`);
    expect((await pgError(addChannel(member, c, "phone", "052-3000099"))).hint).toBe("contact_channel:max");
    // the ones already there can still be changed (the cap is on adding)
    await asUser(member.id, async (q) =>
      expect((await q("update public.contact_channels set label = 'home', position = 7 where contact_id = $1 and value = '052-3000012'", [c])).rowCount).toBe(1),
    );
    // emails are counted on their own
    await addChannel(member, c, "email", "ron2@example.test");
  });

  it("the primary's type goes with its value", async () => {
    const c = await newContact(member, { first_name: "טל", phone: "050-4000004", phone_type: "home", email: "tal@example.test", email_type: "home" });
    expect((await pgError(asUser(member.id, (q) => q("update public.contacts set email_type = 'mobile' where id = $1", [c])))).code).toBe("23514");
    await asUser(member.id, (q) => q("update public.contacts set phone = null where id = $1", [c]));
    const row = await asAdmin(async (q) => (await q<{ phone_type: string | null; email_type: string | null }>("select phone_type, email_type from public.contacts where id = $1", [c])).rows[0]);
    expect(row).toEqual({ phone_type: null, email_type: "home" });
  });

  it("a change of a further phone or email is audited on the contact; moving one is not", async () => {
    const c = await newContact(member, { first_name: "יעל" });
    const ch = await addChannel(member, c, "phone", "054-5000005", "mobile");
    await asUser(member.id, (q) => q("update public.contact_channels set position = 3 where id = $1", [ch.id]));
    await asUser(member.id, (q) => q("update public.contact_channels set label = 'work' where id = $1", [ch.id]));
    await asUser(member.id, (q) => q("delete from public.contact_channels where id = $1", [ch.id]));
    const entries = await asAdmin(async (q) =>
      (
        await q<{ actor_id: string; action: string; changes: Record<string, { old: string | null; new: string | null }> }>(
          "select actor_id, action, changes from public.audit_log where entity_type = 'contacts' and entity_id = $1 and changes ? 'extra_phone' order by created_at, id",
          [c],
        )
      ).rows,
    );
    expect(entries.map((e) => e.changes.extra_phone)).toEqual([
      { old: null, new: "054-5000005 (נייד)" },
      { old: "054-5000005 (נייד)", new: "054-5000005 (עבודה)" },
      { old: "054-5000005 (עבודה)", new: null },
    ]);
    expect(entries.every((e) => e.actor_id === member.id && e.action === "update")).toBe(true);
  });

  it("the rows go with the contact when it is purged, without an entry of their own", async () => {
    const c = await newContact(owner, { first_name: "נמחק" });
    await addChannel(owner, c, "email", "gone@example.test");
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [c]));
    // in the recycle bin: no changes
    const blocked = await pgError(
      asUser(owner.id, (q) => q("insert into public.contact_channels (organization_id, contact_id, kind, value) values ($1, $2, 'email', 'x@example.test')", [org, c])),
    );
    expect(blocked.code).toBe("42501");
    await asUser(owner.id, async (q) => {
      expect((await q("update public.contact_channels set label = 'work' where contact_id = $1", [c])).rowCount).toBe(0);
      expect((await q("delete from public.contact_channels where contact_id = $1", [c])).rowCount).toBe(0);
      await q("delete from public.contacts where id = $1", [c]);
    });
    await asAdmin(async (q) => {
      expect(await count(q, "select 1 from public.contact_channels where contact_id = $1", [c])).toBe(0);
      // the entry of the addition stays; the removal with the contact wrote none
      expect(await count(q, "select 1 from public.audit_log where entity_id = $1 and changes ? 'extra_email'", [c])).toBe(1);
    });
    // a privacy erasure of the contact covers its further phones and emails
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, c]));
    await asAdmin(async (q) => {
      expect(await count(q, "select 1 from public.audit_log where entity_id = $1 and changes::text like '%gone@example.test%'", [c])).toBe(0);
    });
  });

  it("a repeat inquiry matches a contact by a further phone or email", async () => {
    const c = await newContact(member, { first_name: "שי", phone: "050-6000006" });
    await addChannel(member, c, "phone", "052-6000007", "work");
    await addChannel(member, c, "email", "shai@work.example", "work");
    const token = await asUser(owner.id, async (q) =>
      (await q<{ token: string }>("insert into public.forms (organization_id, name, fields) values ($1, 'טופס', '[]') returning token", [org])).rows[0].token,
    );
    const submit = (payload: Record<string, string>) =>
      asService(async (q) => (await q<{ r: { status: string; contact_id?: string } }>("select public.intake_submit($1, 'form', $2) as r", [token, JSON.stringify(payload)])).rows[0].r);
    const byPhone = await submit({ full_name: "שי", phone: "+972-52-600-0007" });
    expect(byPhone.status).toBe("duplicate");
    expect(byPhone.contact_id).toBe(c);
    const byEmail = await submit({ full_name: "שי", email: "SHAI@work.example" });
    expect(byEmail.status).toBe("duplicate");
    expect(byEmail.contact_id).toBe(c);
    // the primary still matches, and a stranger is a new lead
    expect((await submit({ phone: "0506000006" })).contact_id).toBe(c);
    expect((await submit({ phone: "0509999999" })).status).toBe("accepted");
  });

  it("global search and the duplicate lookup find a contact by any of them, within what the user may see", async () => {
    const c = await newContact(member, { first_name: "אורי", phone: "050-7000007" });
    await addChannel(member, c, "phone", "053-7123456", "home");
    await addChannel(member, c, "email", "uri.private@mail.example", "home");
    const search = (u: U, term: string) =>
      asUser(u.id, async (q) => (await q<{ r: { contacts: { id: string }[] } }>("select public.search_records($1, $2) as r", [org, term])).rows[0].r.contacts.map((x) => x.id));
    expect(await search(member, "053-7123456")).toContain(c);
    expect(await search(member, "7123456")).toContain(c);
    expect(await search(member, "uri.private")).toContain(c);

    const matches = (u: U) =>
      asUser(u.id, async (q) =>
        (
          await q<{ contact_id: string; kind: string; value: string }>("select * from public.contact_channel_matches($1, $2, $3) order by kind collate \"C\"", [
            org,
            ["+972537123456", "+972500000000"],
            ["URI.private@mail.example"],
          ])
        ).rows,
      );
    expect(await matches(member)).toEqual([
      { contact_id: c, kind: "email", value: "uri.private@mail.example" },
      { contact_id: c, kind: "phone", value: "+972537123456" },
    ]);

    // with visibility "own" a colleague finds nothing of it
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect(await search(other, "7123456")).not.toContain(c);
      expect(await matches(other)).toEqual([]);
      expect(await asUser(other.id, (q) => count(q, "select 1 from public.contact_channels where contact_id = $1", [c]))).toBe(0);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    // a contact in the recycle bin is not a duplicate
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [c]));
    expect(await matches(member)).toEqual([]);
  });

  it("a merge keeps the duplicate's phones and emails on the kept contact", async () => {
    const keep = await newContact(member, { first_name: "מיכל", phone: "050-8000008", email: "michal@example.test" });
    await addChannel(member, keep, "phone", "052-8000001", "work");
    const dup = await newContact(member, { first_name: "מיכל", last_name: "ב", phone: "054-8000002", phone_type: "mobile", email: "MICHAL@example.test" });
    await addChannel(member, dup, "phone", "052-8000001", "home"); // the kept one has it already
    await addChannel(member, dup, "phone", "050-8000008", "home"); // the kept one's primary
    await addChannel(member, dup, "email", "michal@work.example", "work");
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}')", [org, keep, dup]));
    expect(await channelsOf(keep)).toEqual([
      { kind: "email", label: "work", value: "michal@work.example" },
      { kind: "phone", label: "work", value: "052-8000001" },
      { kind: "phone", label: "mobile", value: "054-8000002" },
    ]);
    expect(await channelsOf(dup)).toEqual([]);
    // the copies are on the kept contact's history, by the person who merged
    const actors = await asAdmin(async (q) =>
      (await q<{ actor_id: string }>("select actor_id from public.audit_log where entity_id = $1 and (changes ? 'extra_phone' or changes ? 'extra_email') and changes -> 'extra_phone' ->> 'old' is null and created_at > now() - interval '1 minute'", [keep])).rows,
    );
    expect(actors.length).toBeGreaterThanOrEqual(2);
  });

  it("a timeline entry a person writes cannot copy someone's phones", async () => {
    const c = await newContact(member, { first_name: "אבי" });
    const victim = await newContact(other, { first_name: "קורבן", phone: "050-9000009" });
    const blocked = await pgError(
      asUser(member.id, (q) =>
        q("insert into public.activities (organization_id, type, body, contact_id, metadata) values ($1, 'system', 'x', $2, $3)", [
          org,
          c,
          JSON.stringify({ merged_id: victim }),
        ]),
      ),
    );
    // policy activities_insert: the browser may write the six logged types only (0072)
    expect(blocked.code).toBe("42501");
    expect(await channelsOf(c)).toEqual([]);
  });
});
