import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type DbError = { code?: string; hint?: string; message: string };
const failure = async (promise: Promise<unknown>) => (await pgError(promise)) as DbError;

// FLD-06 part A: rich text, duration and coloured status.
describe("new custom field types (FLD-06 part A)", () => {
  let owner: { id: string }, rep: { id: string };
  let org: string;

  const define = (key: string, type: string, extra: { options?: string[]; colors?: unknown; condition?: unknown; unique?: boolean; object?: string } = {}) =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.field_definitions (organization_id, object_type, key, label, field_type, options, option_colors, condition, is_unique)
           values ($1, $2, $3, $3, $4, $5, $6, $7, $8) returning id`,
          [
            org,
            extra.object ?? "lead",
            key,
            type,
            JSON.stringify(extra.options ?? []),
            JSON.stringify(extra.colors ?? {}),
            extra.condition === undefined ? null : JSON.stringify(extra.condition),
            extra.unique ?? false,
          ],
        )
      ).rows[0].id,
    );
  const valueOk = (type: string, options: unknown[], value: unknown) =>
    asAdmin(async (q) => (await q<{ ok: boolean }>("select app.custom_value_ok($1, $2::jsonb, $3::jsonb) as ok", [type, JSON.stringify(options), JSON.stringify(value)])).rows[0].ok);

  beforeAll(async () => {
    owner = await createUser("fld06-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "fld06-rep");
    await define("notes_rich", "rich_text");
    await define("call_length", "duration");
    await define("stage_status", "status", { options: ["חדש", "בטיפול", "סגור"], colors: { בטיפול: "warning", סגור: "success" } });
  });

  it("the database checks each new type's value as the app does", async () => {
    // rich text: cleaned Markdown is text, up to 5,000 characters
    expect(await valueOk("rich_text", [], "**מודגש**\n- פריט")).toBe(true);
    expect(await valueOk("rich_text", [], "x".repeat(5000))).toBe(true);
    expect(await valueOk("rich_text", [], "x".repeat(5001))).toBe(false);
    expect(await valueOk("rich_text", [], 5)).toBe(false);
    // duration: whole minutes from 0 to a year
    for (const value of [0, 90, 525600]) expect(await valueOk("duration", [], value), String(value)).toBe(true);
    for (const value of [-1, 525601, 1.5, "90"]) expect(await valueOk("duration", [], value), String(value)).toBe(false);
    // status: one of the options
    expect(await valueOk("status", ["חדש", "סגור"], "סגור")).toBe(true);
    expect(await valueOk("status", ["חדש", "סגור"], "אחר")).toBe(false);
    expect(await valueOk("status", ["חדש", "סגור"], ["סגור"])).toBe(false);
    expect(await valueOk("status", [], null)).toBe(true);
  });

  it("a person's lead takes valid values and is refused invalid ones", async () => {
    await insertLead(rep.id, org, { custom_fields: JSON.stringify({ notes_rich: "**שלום**", call_length: 45, stage_status: "בטיפול" }) });
    for (const bad of [{ call_length: 600000 }, { call_length: 2.5 }, { stage_status: "לא קיים" }, { notes_rich: "x".repeat(5001) }]) {
      expect((await failure(insertLead(rep.id, org, { custom_fields: JSON.stringify(bad) }))).hint, JSON.stringify(bad).slice(0, 40)).toBe("custom_field:invalid");
    }
  });

  it("another type is still refused", async () => {
    expect((await failure(define("bad_type", "address"))).code).toBe("23514");
  });

  it("only a status field has colours, from the palette, for its own options", async () => {
    // another type with colours
    expect((await failure(define("dur_colors", "duration", { colors: { x: "accent" } }))).code).toBe("23514");
    // a select field with a colour for its own option: still only status has colours
    expect((await failure(define("sel_colors", "select", { options: ["א"], colors: { א: "accent" } }))).code).toBe("23514");
    // a colour for an option the field does not have
    expect((await failure(define("st_ghost", "status", { options: ["א"], colors: { ב: "accent" } }))).code).toBe("23514");
    // a colour outside the palette (never hex)
    expect((await failure(define("st_hex", "status", { options: ["א"], colors: { א: "#ff0000" } }))).code).toBe("23514");
    expect((await failure(define("st_word", "status", { options: ["א"], colors: { א: "purple" } }))).code).toBe("23514");
    // not an object
    expect((await failure(define("st_array", "status", { options: ["א"], colors: ["accent"] }))).code).toBe("23514");
    // removing an option keeps its colour = refused; the app sends the colours of the kept options only
    const id = await define("st_edit", "status", { options: ["א", "ב"], colors: { א: "accent", ב: "danger" } });
    expect((await failure(asUser(owner.id, (q) => q("update public.field_definitions set options = '[\"א\"]' where id = $1", [id])))).code).toBe("23514");
    await asUser(owner.id, (q) => q(`update public.field_definitions set options = '["א"]', option_colors = '{"א": "success"}' where id = $1`, [id]));
    // a member does not set colours (configuration is for owners and admins)
    const res = await asUser(rep.id, (q) => q(`update public.field_definitions set option_colors = '{"א": "danger"}' where id = $1`, [id]));
    expect(res.rowCount).toBe(0);
    expect(await asAdmin(async (q) => (await q<{ c: unknown }>("select option_colors as c from public.field_definitions where id = $1", [id])).rows[0].c)).toEqual({ א: "success" });
  });

  it("never unique; a default is checked like a value", async () => {
    for (const type of ["rich_text", "duration", "status"]) {
      expect((await failure(define(`u_${type}`, type, { options: type === "status" ? ["א"] : [], unique: true }))).hint, type).toBe("custom_field:unique_type");
    }
    const id = await define("d_status", "status", { options: ["א", "ב"] });
    expect((await failure(asUser(owner.id, (q) => q(`update public.field_definitions set default_value = '"ג"' where id = $1`, [id])))).hint).toBe("custom_field:default");
    await asUser(owner.id, (q) => q(`update public.field_definitions set default_value = '"ב"' where id = $1`, [id]));
    const dur = await define("d_duration", "duration");
    expect((await failure(asUser(owner.id, (q) => q("update public.field_definitions set default_value = '1.5' where id = $1", [dur])))).hint).toBe("custom_field:default");
    await asUser(owner.id, (q) => q("update public.field_definitions set default_value = '30' where id = $1", [dur]));
  });

  it("conditions and score rules take 'filled' / 'empty' on the new types, nothing more (the app mirrors it)", async () => {
    await define("c_filled", "text", { condition: { field: "stage_status", op: "filled", effect: "show" } });
    expect((await failure(define("c_equals", "text", { condition: { field: "stage_status", op: "equals", value: "סגור", effect: "show" } }))).hint).toBe(
      "custom_field:condition",
    );
    expect((await failure(define("c_dur", "text", { condition: { field: "call_length", op: "in", value: [30], effect: "show" } }))).hint).toBe(
      "custom_field:condition",
    );
    const rule = (field: string, op: string, value: string | null) =>
      asUser(owner.id, (q) => q("insert into public.lead_score_rules (organization_id, field, op, value, points) values ($1, $2, $3, $4, 5)", [org, field, op, value]));
    await rule("cf:stage_status", "filled", null);
    await rule("cf:notes_rich", "empty", null);
    expect((await failure(rule("cf:stage_status", "eq", "סגור"))).hint).toBe("lead_score_rule:invalid");
    expect((await failure(rule("cf:call_length", "gte", "30"))).hint).toBe("lead_score_rule:invalid");
  });

  it("the new types count against the existing custom field quota", async () => {
    const quotaOrg = await createOrg(owner.id);
    await asAdmin((q) => q(`update public.subscriptions set limit_overrides = '{"max_custom_fields_per_object": 1}' where organization_id = $1`, [quotaOrg]));
    const add = (key: string, type: string) =>
      asUser(owner.id, (q) =>
        q("insert into public.field_definitions (organization_id, object_type, key, label, field_type, options) values ($1, 'deal', $2, $2, $3, $4)", [
          quotaOrg,
          key,
          type,
          JSON.stringify(type === "status" ? ["א"] : []),
        ]),
      );
    await add("one", "status");
    expect((await failure(add("two", "duration"))).hint).toBe("limit:max_custom_fields_per_object");
    expect((await failure(add("three", "rich_text"))).hint).toBe("limit:max_custom_fields_per_object");
  });

  it("a conversion copies the new types to a field of the same label and type", async () => {
    await define("call_length", "duration", { object: "contact" });
    const lead = await insertLead(rep.id, org, { owner_id: rep.id, full_name: "ממיר", custom_fields: JSON.stringify({ call_length: 75 }) });
    const contact = await asUser(rep.id, async (q) => (await q<{ r: { contact_id: string } }>("select public.convert_lead($1) as r", [lead])).rows[0].r.contact_id);
    const fields = await asAdmin(async (q) => (await q<{ f: Record<string, unknown> }>("select custom_fields as f from public.contacts where id = $1", [contact])).rows[0].f);
    expect(fields.call_length).toBe(75);
  });
});
