import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, asService, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

describe("a public form stores only what it needs (FXS-02)", () => {
  let org: string;
  let form: { id: string; token: string };

  beforeAll(async () => {
    const owner = await createUser("size-owner");
    org = await createOrg(owner.id);
    form = await asUser(owner.id, async (q) => (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name) values ($1, 'טופס') returning id, token", [org])).rows[0]);
  });

  const submit = (payload: Record<string, unknown>, spam = false) =>
    asService(async (q) => (await q<{ r: { status: string; lead_id?: string } }>("select public.intake_submit($1, 'form', $2, 'ip', null, $3) as r", [form.token, JSON.stringify(payload), spam])).rows[0].r);
  const lastPayload = () =>
    asAdmin(async (q) => (await q<{ payload: Record<string, string> }>("select payload from public.form_submissions where form_id = $1 order by created_at desc limit 1", [form.id])).rows[0].payload);

  it("each field is cut to the lead's length and unknown keys are dropped", async () => {
    await submit({ full_name: "א".repeat(1000), phone: "052".repeat(100), message: "ב".repeat(100_000), extra: "x".repeat(50_000) });
    const payload = await lastPayload();
    expect(Object.keys(payload).sort()).toEqual(["full_name", "message", "phone"]);
    expect(payload.full_name).toHaveLength(200);
    expect(payload.phone).toHaveLength(40);
    expect(payload.message).toHaveLength(5000);
  });

  it("spam is stored the same way", async () => {
    await submit({ email: "a@b.co", junk: "y".repeat(200_000) }, true);
    expect(await lastPayload()).toEqual({ email: "a@b.co" });
  });

  it("even a direct insert by the server is trimmed, and the column has a size check", async () => {
    await asAdmin((q) => q("insert into public.form_submissions (organization_id, form_id, status, payload) values ($1, $2, 'spam', $3)", [org, form.id, JSON.stringify({ blob: "z".repeat(100_000) })]));
    expect(await lastPayload()).toEqual({});
    const check = await asAdmin(async (q) => (await q<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'form_submissions_payload_size'")).rows[0].def);
    expect(check).toContain("16384");
    // the trigger runs first, so the check is a second line of defence; disabling the trigger shows it holds
    const blocked = await pgError(
      // one transaction: it fails, so the disabled trigger is rolled back with it
      asAdmin(async (q) => {
        await q("alter table public.form_submissions disable trigger form_submissions_trim_payload");
        await q("insert into public.form_submissions (organization_id, form_id, status, payload) values ($1, $2, 'spam', $3)", [
          org,
          form.id,
          JSON.stringify({ blob: Array.from({ length: 30_000 }, (_, i) => i.toString(36)).join("") }),
        ]);
      }),
    );
    expect(blocked.code).toBe("23514");
  });
});
