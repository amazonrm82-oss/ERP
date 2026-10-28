import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * BIZ-03 (owner, 27 October 2026, answer (ג), migration qr_external_block_writes): while the platform has switched off a
 * business's external links, a code that leads to an external site cannot be created, pointed at another link, turned into a
 * link or switched on (hint qr_code:external_off). Switching one off, renaming or deleting it stays allowed; internal targets
 * and other businesses are untouched; an outsider still gets RLS's plain refusal first.
 */
describe("QR codes: no external link writes while the platform's switch is on (BIZ-03)", () => {
  let owner: U, admin: U, outsider: U;
  let org: string, otherOrg: string;
  let formId: string;

  const makeCode = (who: U, values: Record<string, unknown>, o: string = org) =>
    asUser(who.id, async (q) => {
      const row: Record<string, unknown> = { organization_id: o, name: "שלט", ...values };
      const cols = Object.keys(row);
      return (
        await q<{ id: string }>(
          `insert into public.qr_codes (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
          Object.values(row),
        )
      ).rows[0];
    });
  const update = (who: U, id: string, set: string) =>
    asUser(who.id, async (q) => (await q(`update public.qr_codes set ${set} where id = $1`, [id])).rowCount);
  const setOff = (o: string, blocked: boolean) =>
    asAdmin((q) =>
      q(
        `insert into app.qr_external_blocks (organization_id, blocked, reason) values ($1, $2, 'בדיקה')
         on conflict (organization_id) do update set blocked = excluded.blocked`,
        [o, blocked],
      ),
    );
  const refusedOff = async (p: Promise<unknown>) => expect(await pgError(p)).toMatchObject({ code: "P0001", hint: "qr_code:external_off" });

  beforeAll(async () => {
    owner = await createUser("qrw-owner");
    org = await createOrg(owner.id, "עסק עם קודים");
    admin = await addMember(org, owner.id, "admin", "qrw-admin");
    outsider = await createUser("qrw-outsider");
    otherOrg = await createOrg(outsider.id, "עסק שכן");
    formId = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.forms (organization_id, name) values ($1, 'טופס אתר') returning id", [org])).rows[0].id,
    );
  });

  afterAll(async () => {
    await asAdmin((q) => q("delete from app.qr_external_blocks where organization_id = any($1)", [[org, otherOrg]]));
  });

  it("while off: a new link code, a changed link, a code turned into a link and switching a link on are refused", async () => {
    const link = await makeCode(owner, { target_kind: "url", target_url: "https://a.io/" });
    const offLink = await makeCode(owner, { target_kind: "url", target_url: "https://b.io/", is_active: false });
    const onForm = await makeCode(owner, { target_kind: "form", form_id: formId });
    await setOff(org, true);
    try {
      await refusedOff(makeCode(admin, { target_kind: "url", target_url: "https://c.io/" }));
      await refusedOff(makeCode(owner, { target_kind: "url", target_url: "https://c.io/", is_active: false }));
      await refusedOff(update(admin, link.id, "target_url = 'https://d.io/'"));
      await refusedOff(update(owner, offLink.id, "is_active = true"));
      await refusedOff(update(owner, onForm.id, "target_kind = 'url', form_id = null, target_url = 'https://e.io/'"));
      expect(await asAdmin((q) => count(q, "select 1 from public.qr_codes where id = $1 and target_url = 'https://a.io/'", [link.id]))).toBe(1);
    } finally {
      await setOff(org, false);
    }
  });

  it("while off: switching a link code off, renaming it and deleting it stay allowed; internal targets are untouched", async () => {
    const link = await makeCode(owner, { target_kind: "url", target_url: "https://a.io/" });
    const other = await makeCode(owner, { target_kind: "url", target_url: "https://b.io/" });
    const onForm = await makeCode(owner, { target_kind: "form", form_id: formId, is_active: false });
    await setOff(org, true);
    try {
      expect(await update(admin, link.id, "name = 'שלט חדש'")).toBe(1);
      expect(await update(admin, link.id, "is_active = false")).toBe(1);
      // a link code already off may be renamed while it stays off
      expect(await update(admin, link.id, "name = 'שלט ישן'")).toBe(1);
      expect(await asUser(owner.id, async (q) => (await q("delete from public.qr_codes where id = $1", [other.id])).rowCount)).toBe(1);
      // a link turned into an internal target is allowed (it leaves the external site)
      expect(await update(owner, link.id, "target_kind = 'form', target_url = null, form_id = '" + formId + "'")).toBe(1);
      // internal codes: created, changed and switched on as before
      const fresh = await makeCode(admin, { target_kind: "form", form_id: formId });
      expect(fresh.id).toBeTruthy();
      expect(await update(admin, onForm.id, "is_active = true")).toBe(1);
    } finally {
      await setOff(org, false);
    }
  });

  it("only the business that is switched off; with the switch back (or never set) everything is allowed", async () => {
    await setOff(org, true);
    try {
      const elsewhere = await makeCode(outsider, { target_kind: "url", target_url: "https://f.io/" }, otherOrg);
      expect(await update(outsider, elsewhere.id, "target_url = 'https://g.io/'")).toBe(1);
    } finally {
      await setOff(org, false);
    }
    const link = await makeCode(admin, { target_kind: "url", target_url: "https://h.io/", is_active: false });
    expect(await update(admin, link.id, "target_url = 'https://i.io/'")).toBe(1);
    expect(await update(admin, link.id, "is_active = true")).toBe(1);
  });

  it("an outsider still gets RLS's plain refusal first, never the switch's hint", async () => {
    const link = await makeCode(owner, { target_kind: "url", target_url: "https://a.io/" });
    await setOff(org, true);
    try {
      const refused = await pgError(makeCode(outsider, { target_kind: "url", target_url: "https://x.io/" }));
      expect(refused.code).toBe("42501");
      expect(refused.hint ?? "").not.toBe("qr_code:external_off");
      expect(await update(outsider, link.id, "target_url = 'https://x.io/'")).toBe(0);
    } finally {
      await setOff(org, false);
    }
  });
});
