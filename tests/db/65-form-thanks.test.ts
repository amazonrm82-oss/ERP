import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Thanks = { whatsapp: string | null; whatsapp_text: string | null };

// CAP-05: the hosted form's thank-you state can show a WhatsApp button. The form
// turns it on (owners/admins, like its other settings); the number is the form's
// own or the business phone; intake_form() returns it only when it is valid E.164.
describe("thank-you page WhatsApp button (CAP-05)", () => {
  let owner: U, admin: U, member: U, outsider: U;
  let org: string, otherOrg: string;
  let form: { id: string; token: string };

  beforeAll(async () => {
    owner = await createUser("thanks-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "thanks-admin");
    member = await addMember(org, owner.id, "member", "thanks-member");
    outsider = await createUser("thanks-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    form = await asUser(owner.id, async (q) =>
      (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name, title) values ($1, 'תודה', 'פנייה') returning id, token", [org])).rows[0],
    );
  });

  const thanks = async (token = form.token) =>
    asService(async (q) => (await q<{ r: { thanks: Thanks } }>("select public.intake_form($1) as r", [token])).rows[0].r.thanks);
  const setForm = (user: U, set: string, params: unknown[] = []) =>
    asUser(user.id, async (q) => (await q(`update public.forms set ${set} where id = $1`, [form.id, ...params])).rowCount ?? 0);
  const setOrgPhone = (phone: string | null) =>
    asUser(owner.id, (q) => q("update public.organizations set phone = $2 where id = $1", [org, phone]));

  it("is off by default and returns no number", async () => {
    await setOrgPhone("050-1234567");
    const row = await asAdmin(async (q) =>
      (await q<{ whatsapp_button: boolean; whatsapp_phone: string | null; whatsapp_text: string | null }>(
        "select whatsapp_button, whatsapp_phone, whatsapp_text from public.forms where id = $1",
        [form.id],
      )).rows[0],
    );
    expect(row).toEqual({ whatsapp_button: false, whatsapp_phone: null, whatsapp_text: null });
    expect(await thanks()).toEqual({ whatsapp: null, whatsapp_text: null });
  });

  it("uses the business phone by default, and the form's own number when set", async () => {
    expect(await setForm(owner, "whatsapp_button = true, whatsapp_text = $2", ["  היי, מילאתי את הטופס "])).toBe(1);
    expect(await thanks()).toEqual({ whatsapp: "+972501234567", whatsapp_text: "היי, מילאתי את הטופס" });
    expect(await setForm(admin, "whatsapp_phone = '+972 52-765 4321'")).toBe(1);
    expect(await thanks()).toEqual({ whatsapp: "+972527654321", whatsapp_text: "היי, מילאתי את הטופס" });
    // an empty number falls back to the business phone
    expect(await setForm(owner, "whatsapp_phone = '  '")).toBe(1);
    expect((await thanks()).whatsapp).toBe("+972501234567");
  });

  it("returns no number (and no text) when no valid one exists", async () => {
    await setForm(owner, "whatsapp_phone = null");
    await setOrgPhone(null);
    expect(await thanks()).toEqual({ whatsapp: null, whatsapp_text: null });
    await setOrgPhone("12345");
    expect(await thanks()).toEqual({ whatsapp: null, whatsapp_text: null });
    await setOrgPhone("050-1234567");
    expect((await thanks()).whatsapp).toBe("+972501234567");
    // turned off: nothing, whatever is stored
    await setForm(owner, "whatsapp_button = false");
    expect(await thanks()).toEqual({ whatsapp: null, whatsapp_text: null });
  });

  it("checks the number and the text", async () => {
    for (const bad of ["abc", "050-123<script>", "1".repeat(31)]) {
      expect((await pgError(setForm(owner, "whatsapp_phone = $2", [bad]))).code).toBe("23514");
    }
    expect((await pgError(setForm(owner, "whatsapp_text = $2", ["א".repeat(301)]))).code).toBe("23514");
    expect(await setForm(owner, "whatsapp_text = $2", ["א".repeat(300)])).toBe(1);
  });

  it("only owners and admins of the business change it", async () => {
    expect(await setForm(member, "whatsapp_button = true")).toBe(0);
    expect(await setForm(outsider, "whatsapp_button = true")).toBe(0);
    const inOther = await asUser(outsider.id, async (q) =>
      (await q<{ token: string }>("insert into public.forms (organization_id, name, whatsapp_button, whatsapp_phone) values ($1, 'אחר', true, '0541112222') returning token", [otherOrg])).rows[0],
    );
    expect((await thanks(inOther.token)).whatsapp).toBe("+972541112222");
    const grants = await asAdmin(async (q) =>
      (
        await q<{ privilege_type: string; column_name: string }>(
          `select privilege_type, column_name from information_schema.column_privileges
            where table_schema = 'public' and table_name = 'forms' and grantee = 'authenticated'
              and column_name like 'whatsapp%' order by privilege_type collate "C", column_name collate "C"`,
        )
      ).rows.map((r) => `${r.privilege_type}:${r.column_name}`),
    );
    expect(grants).toEqual([
      "INSERT:whatsapp_button",
      "INSERT:whatsapp_phone",
      "INSERT:whatsapp_text",
      "SELECT:whatsapp_button",
      "SELECT:whatsapp_phone",
      "SELECT:whatsapp_text",
      "UPDATE:whatsapp_button",
      "UPDATE:whatsapp_phone",
      "UPDATE:whatsapp_text",
    ]);
    // intake_form stays closed to clients
    expect((await pgError(asUser(owner.id, (q) => q("select public.intake_form($1)", [form.token])))).code).toBe("42501");
  });
});
