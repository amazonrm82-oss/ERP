import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CARD_LAYOUT_BUILT_IN, CARD_LAYOUT_TYPES, defaultLayout } from "@/features/card-layout/layout";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type Group = { title: string; columns: number; fields: string[] };

/** FLD-08: the card layout per organization and record type, and its check. */
describe("card layouts", () => {
  let owner: { id: string };
  let org: string;
  let otherOrg: string;

  const write = (type: string, groups: unknown) =>
    asUser(owner.id, async (q) => {
      const updated = await q("update public.card_layouts set groups = $2 where organization_id = $1 and object_type = $3", [org, JSON.stringify(groups), type]);
      if (updated.rowCount === 0) {
        await q("insert into public.card_layouts (organization_id, object_type, groups) values ($1, $3, $2)", [org, JSON.stringify(groups), type]);
      }
    });
  const read = (type: string) =>
    asAdmin(async (q) => (await q<{ g: Group[] }>("select groups as g from public.card_layouts where organization_id = $1 and object_type = $2", [org, type])).rows[0]?.g);
  const refused = async (type: string, groups: unknown) => {
    const err = await pgError(write(type, groups));
    return `${err.code} ${err.hint ?? ""}`;
  };

  beforeAll(async () => {
    owner = await createUser("layout-owner");
    org = await createOrg(owner.id);
    const other = await createUser("layout-other");
    otherOrg = await createOrg(other.id);
    await asUser(owner.id, (q) =>
      q("insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'size', 'גודל', 'text'), ($1, 'deal', 'size', 'גודל', 'text')", [org]),
    );
    await asUser(other.id, (q) =>
      q("insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'secret', 'סוד', 'text')", [otherOrg]),
    );
  });

  it("the built-in keys are the same on both sides", async () => {
    for (const type of CARD_LAYOUT_TYPES) {
      const keys = await asAdmin(async (q) => (await q<{ k: string[] }>("select app.card_layout_builtin_keys($1) as k", [type])).rows[0].k);
      expect(keys, type).toEqual(CARD_LAYOUT_BUILT_IN[type].map((f) => f.key));
    }
  });

  it("a new organization has no row: the card shows the default layout", async () => {
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.card_layouts where organization_id = $1", [org]))).toBe(0);
  });

  it("stores groups of built-in and custom fields, and the app's default layout passes for every type", async () => {
    const groups = [
      { title: "קשר", columns: 2, fields: ["phone", "email", "cf:size"] },
      { title: "מכירה", columns: 1, fields: ["owner_id", "source_id"] },
    ];
    await write("lead", groups);
    expect(await read("lead")).toEqual(groups);
    for (const type of CARD_LAYOUT_TYPES) {
      const layout = defaultLayout(type, [{ key: "size" }].filter(() => type === "lead" || type === "deal"));
      await write(type, layout);
      expect(await read(type), type).toEqual(layout);
    }
    // one row per type
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.card_layouts (organization_id, object_type) values ($1, 'lead')", [org])))).code).toBe("23505");
  });

  it("refuses a layout of the wrong shape (hint card_layout:invalid)", async () => {
    const ok = { title: "א", columns: 1, fields: [] as string[] };
    const bad: unknown[] = [
      {},
      [1],
      [{ ...ok, title: "" }],
      [{ ...ok, title: " א" }],
      [{ ...ok, title: "א".repeat(61) }],
      [{ ...ok, columns: 3 }],
      [{ ...ok, columns: "1" }],
      [{ title: "א", columns: 1 }],
      [{ ...ok, extra: true }],
      [{ ...ok, fields: [1] }],
      [{ ...ok, fields: ["amount"] }],
      [{ ...ok, fields: ["phone", "phone"] }],
      [ok, { ...ok, fields: [] }, { ...ok, fields: ["phone"] }, { ...ok, fields: ["phone"] }],
      [{ ...ok, fields: ["cf:Bad"] }],
      [{ ...ok, fields: ["cf:nope"] }],
      // a custom field of another type, and one of another organization
      [{ ...ok, fields: ["cf:size"] }],
      Array.from({ length: 21 }, () => ok),
    ];
    for (const groups of bad) {
      const type = JSON.stringify(groups).includes('"cf:size"') ? "contact" : "lead";
      expect(await refused(type, groups), JSON.stringify(groups)).toBe("P0001 card_layout:invalid");
    }
    expect(await refused("lead", [{ ...ok, fields: ["cf:secret"] }])).toBe("P0001 card_layout:invalid");
    // 60 fields in all at most
    for (let i = 0; i < 61; i++) {
      await asUser(owner.id, (q) =>
        q("insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'company', $2, $2, 'text') on conflict do nothing", [org, `k${i}`]),
      );
    }
    const keys = await asAdmin(async (q) => (await q<{ k: string }>("select 'cf:' || key as k from public.field_definitions where organization_id = $1 and object_type = 'company' order by key", [org])).rows.map((r) => r.k));
    expect(keys.length).toBeGreaterThanOrEqual(61);
    expect(await refused("company", [{ ...ok, fields: keys.slice(0, 61) }])).toBe("P0001 card_layout:invalid");
    await write("company", [{ ...ok, fields: keys.slice(0, 60) }]);
    expect(await refused("lead", [{ ...ok, fields: [] }, ...Array.from({ length: 20 }, () => ok)])).toBe("P0001 card_layout:invalid");
    await write("lead", Array.from({ length: 20 }, () => ok));
  });

  it("refuses a title that starts or ends with white space the app trims (the same set as JavaScript's trim)", async () => {
    const spaces = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
    for (const code of spaces) {
      const ch = String.fromCharCode(code);
      expect((ch + "א").trim(), code.toString(16)).toBe("א");
      expect(await refused("contact", [{ title: ch + "א", columns: 1, fields: [] }]), code.toString(16)).toBe("P0001 card_layout:invalid");
      expect(await refused("contact", [{ title: "א" + ch, columns: 1, fields: [] }]), code.toString(16)).toBe("P0001 card_layout:invalid");
      // inside a title it is fine
      await write("contact", [{ title: "א" + ch + "ב", columns: 1, fields: [] }]);
    }
    // a zero-width space is not trimmed by the app, so the database accepts it too
    await write("contact", [{ title: "\u200bא", columns: 1, fields: [] }]);
  });

  it("a custom field hidden or deleted later is not refused when the row already held it", async () => {
    await write("deal", [{ title: "א", columns: 1, fields: ["cf:size", "owner_id"] }]);
    await asUser(owner.id, (q) => q("update public.field_definitions set is_active = false where organization_id = $1 and object_type = 'deal' and key = 'size'", [org]));
    await write("deal", [{ title: "ב", columns: 2, fields: ["owner_id", "cf:size"] }]);
    await asUser(owner.id, (q) => q("delete from public.field_definitions where organization_id = $1 and object_type = 'deal' and key = 'size'", [org]));
    await write("deal", [{ title: "ג", columns: 2, fields: ["cf:size"] }]);
    expect(await read("deal")).toEqual([{ title: "ג", columns: 2, fields: ["cf:size"] }]);
    // but a new key of a field that is gone is refused
    expect(await refused("deal", [{ title: "ג", columns: 2, fields: ["cf:size", "cf:other"] }])).toBe("P0001 card_layout:invalid");
  });

  it("a member cannot write it, and nobody outside the organization reads or writes it", async () => {
    const member = await addMember(org, owner.id, "member", "layout-member");
    await asUser(member.id, async (q) => {
      expect(await count(q, "select 1 from public.card_layouts where organization_id = $1", [org])).toBeGreaterThan(0);
      expect((await q("update public.card_layouts set groups = '[]' where organization_id = $1", [org])).rowCount).toBe(0);
    });
    const stranger = await createUser("layout-stranger");
    await asUser(stranger.id, async (q) => {
      expect(await count(q, "select 1 from public.card_layouts where organization_id = $1", [org])).toBe(0);
    });
    expect((await pgError(asUser(stranger.id, (q) => q("insert into public.card_layouts (organization_id, object_type, groups) values ($1, 'contact', '[]')", [otherOrg])))).code).toBe("42501");
  });

  it("is audited", async () => {
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'card_layouts'", [org]))).toBeGreaterThan(0);
  });
});
