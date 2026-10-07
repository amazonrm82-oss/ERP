import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

describe("custom field values are checked in the database", () => {
  let owner: { id: string }, rep: { id: string };
  let org: string, otherOrg: string;

  beforeAll(async () => {
    owner = await createUser("cf-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member");
    const other = await createUser("cf-other");
    otherOrg = await createOrg(other.id);
    await asAdmin(async (q) => {
      const add = (o: string, type: string, key: string, fieldType: string, options: unknown[] = []) =>
        q("insert into public.field_definitions (organization_id, object_type, key, label, field_type, options) values ($1, $2, $3, $3, $4, $5)", [
          o,
          type,
          key,
          fieldType,
          JSON.stringify(options),
        ]);
      await add(org, "lead", "notes", "text");
      await add(org, "lead", "size", "number");
      await add(org, "lead", "vip", "checkbox");
      await add(org, "lead", "meet", "date");
      await add(org, "lead", "mail", "email");
      await add(org, "lead", "tel", "phone");
      await add(org, "lead", "site", "url");
      await add(org, "lead", "kind", "select", ["א", "ב"]);
      await add(org, "lead", "kinds", "multi_select", ["א", "ב"]);
      await add(org, "contact", "hobby", "text");
      // the same key in another organization does not count here
      await add(otherOrg, "lead", "secret", "text");
    });
  });

  const lead = (custom: unknown) => insertLead(rep.id, org, { custom_fields: JSON.stringify(custom) });
  const rejected = async (custom: unknown) => (await pgError(lead(custom))).hint;

  it("accepts values that match their field", async () => {
    await expect(
      lead({
        notes: "טקסט",
        size: 12.5,
        vip: true,
        meet: "2026-10-07",
        mail: "a@b.co",
        tel: "+972 50-123-4567",
        site: "https://example.com/x",
        kind: "ב",
        kinds: ["א", "ב"],
      }),
    ).resolves.toBeTruthy();
    await expect(lead({ notes: null, size: null, kind: null })).resolves.toBeTruthy();
  });

  it("rejects unknown keys, other organizations' keys and other record types' keys", async () => {
    expect(await rejected({ whatever: 1 })).toBe("custom_field:invalid");
    expect(await rejected({ secret: "x" })).toBe("custom_field:invalid");
    expect(await rejected({ hobby: "x" })).toBe("custom_field:invalid");
  });

  it("rejects values of the wrong type or shape", async () => {
    for (const bad of [
      { notes: { nested: true } },
      { notes: "x".repeat(501) },
      { size: "12" },
      { vip: "true" },
      { meet: "2026-02-30" },
      { meet: "07/10/2026" },
      { mail: "not-an-email" },
      { tel: "abc" },
      { site: "javascript:alert(1)" },
      { kind: "ג" },
      { kinds: ["א", "ג"] },
      { kinds: "א" },
    ]) {
      expect(await rejected(bad), JSON.stringify(bad)).toBe("custom_field:invalid");
    }
  });

  it("checks only values that change, so old values survive a changed definition", async () => {
    const id = await lead({ kind: "א", notes: "x" });
    await asAdmin((q) => q("update public.field_definitions set options = '[\"ב\"]' where organization_id = $1 and key = 'kind'", [org]));
    // another field changes; the old option stays
    await asUser(rep.id, (q) =>
      q(`update public.leads set custom_fields = custom_fields || '{"notes": "y"}' where id = $1`, [id]),
    );
    // the same value sent again with the rest of the form is fine; choosing the removed option anew is not
    await asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"kind": "א", "notes": "z"}' where id = $1`, [id]));
    await asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"kind": "ב", "notes": "z"}' where id = $1`, [id]));
    expect(
      (await pgError(asUser(rep.id, (q) => q(`update public.leads set custom_fields = '{"kind": "א", "notes": "z"}' where id = $1`, [id])))).hint,
    ).toBe("custom_field:invalid");
    // updates that do not touch custom_fields are not affected
    await asUser(rep.id, (q) => q("update public.leads set full_name = 'שם חדש' where id = $1", [id]));
  });

  it("checks contacts, companies and deals too", async () => {
    expect(
      (
        await pgError(
          asUser(rep.id, (q) =>
            q(`insert into public.contacts (organization_id, first_name, custom_fields) values ($1, 'א', '{"nope": 1}')`, [org]),
          ),
        )
      ).hint,
    ).toBe("custom_field:invalid");
    await asUser(rep.id, (q) =>
      q(`insert into public.contacts (organization_id, first_name, custom_fields) values ($1, 'א', '{"hobby": "שחייה"}')`, [org]),
    );
    expect(
      (
        await pgError(
          asUser(rep.id, (q) => q(`insert into public.companies (organization_id, name, custom_fields) values ($1, 'חברה', '{"nope": 1}')`, [org])),
        )
      ).hint,
    ).toBe("custom_field:invalid");
    const deal = await asAdmin(async (q) => {
      const p = await q<{ id: string; stage: string }>(
        "select p.id, (select s.id from public.stages s where s.pipeline_id = p.id order by position limit 1) as stage from public.pipelines p where p.organization_id = $1 and p.is_default",
        [org],
      );
      return p.rows[0];
    });
    expect(
      (
        await pgError(
          asUser(rep.id, (q) =>
            q(`insert into public.deals (organization_id, name, pipeline_id, stage_id, custom_fields) values ($1, 'עסקה', $2, $3, '{"nope": 1}')`, [
              org,
              deal.id,
              deal.stage,
            ]),
          ),
        )
      ).hint,
    ).toBe("custom_field:invalid");
  });

  it("server-side writes are trusted (service role, security definer functions)", async () => {
    const id = await lead({ notes: "x" });
    await asService((q) => q(`update public.leads set custom_fields = '{"legacy": 1}' where id = $1`, [id]));
    // the old unknown key does not block later edits of other fields
    await asUser(rep.id, (q) => q(`update public.leads set custom_fields = custom_fields || '{"notes": "z"}' where id = $1`, [id]));
  });
});
