import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asService, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

// OPS-02: the hosted form page (/f/<token>, /f/<token>/qr) had no limit at all. public.intake_form now counts a view when
// our server hands over the sender (the keyed IP hash) in the request header x-crm-sender: app.form_view_limit() = 300 per
// sender per form in 10 minutes (higher than the 60 of cards, widgets and booking pages: the form is the main lead page,
// behind iframes, posters and shared addresses; the lead's interim decision, review M1), then {rate_limited: true};
// counted after the token lookup like the others; only bucket numbers kept.
describe("OPS-02: the hosted form's view limit (public.intake_form)", () => {
  let owner: { id: string };
  let org: string;
  let form: { id: string; token: string };
  let other: { id: string; token: string };

  const sender = (label: string) => createHash("sha256").update(label).digest("hex");
  /** one page view, as the server makes it: the hash in the request header (no header = the submission's own read) */
  const view = (token: string, hash: string | null, header = "x-crm-sender") =>
    asService(async (q) => {
      if (hash !== null) await q("select set_config('request.headers', $1, true)", [JSON.stringify({ [header]: hash })]);
      return (await q<{ r: Record<string, unknown> | null }>("select public.intake_form($1) as r", [token])).rows[0].r;
    });
  const counters = (formId: string) =>
    asAdmin(async (q) => (await q<{ n: string }>("select coalesce(sum(views), 0) as n from app.form_view_counts where form_id = $1", [formId])).rows[0].n);
  const clear = () => asAdmin((q) => q("update app.form_view_counts set window_start = now() - interval '11 minutes' where form_id in ($1, $2)", [form.id, other.id]));

  beforeAll(async () => {
    owner = await createUser("ops02-owner");
    org = await createOrg(owner.id);
    await asUser(owner.id, async (q) => {
      form = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name, title) values ($1, 'א', 'טופס') returning id, token", [org])).rows[0];
      other = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name, title) values ($1, 'ב', 'טופס ב') returning id, token", [org])).rows[0];
    });
  });

  it("the limit is one named number: 300, closed to every client role", async () => {
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select app.form_view_limit() as n")).rows[0].n)).toBe(300);
    const open = await asAdmin(async (q) =>
      (
        await q<{ f: boolean }>(
          "select bool_or(has_function_privilege(r, 'app.form_view_limit()', 'execute')) as f from unnest(array['anon', 'authenticated', 'service_role']) r",
        )
      ).rows[0].f,
    );
    expect(open).toBe(false);
  });

  it("300 views per sender per form in 10 minutes, then rate_limited and nothing of the form", async () => {
    const a = sender("ops02-a");
    for (let i = 0; i < 300; i += 1) expect((await view(form.token, a))?.title).toBe("טופס");
    expect(await view(form.token, a)).toEqual({ rate_limited: true });
    // another sender, and the same sender on another form, are counted apart
    expect((await view(form.token, sender("ops02-b")))?.title).toBe("טופס");
    expect((await view(other.token, a))?.title).toBe("טופס ב");
    // a read without a sender (the submission route, a direct caller) is never counted or refused
    expect((await view(form.token, null))?.title).toBe("טופס");
    // the window passes
    await clear();
    expect((await view(form.token, a))?.title).toBe("טופס");
  });

  it("only a keyed hash in x-crm-sender counts; anything else is ignored", async () => {
    await clear();
    const before = Number(await counters(form.id));
    expect((await view(form.token, "not-a-hash"))?.title).toBe("טופס");
    expect((await view(form.token, sender("x").toUpperCase()))?.title).toBe("טופס");
    expect((await view(form.token, sender("y"), "x-other"))?.title).toBe("טופס");
    expect(Number(await counters(form.id))).toBe(before);
    expect((await view(form.token, sender("z")))?.title).toBe("טופס");
    expect(Number(await counters(form.id))).toBe(before + 1);
  });

  it("not found and a closed business answer as before, and are not counted", async () => {
    const a = sender("ops02-nf");
    expect(await view("0".repeat(32), a)).toBeNull();
    await asUser(owner.id, (q) => q("update public.forms set is_active = false where id = $1", [other.id]));
    const before = Number(await counters(other.id));
    expect(await view(other.token, a)).toBeNull();
    expect(Number(await counters(other.id))).toBe(before);
    await asUser(owner.id, (q) => q("update public.forms set is_active = true where id = $1", [other.id]));
  });

  it("keeps no hash: only form, bucket, window and count; closed to every client role; the counters go with the form", async () => {
    expect(
      await asAdmin(async (q) =>
        (await q<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'app' and table_name = 'form_view_counts' order by 1")).rows.map((r) => r.c),
      ),
    ).toEqual(["bucket", "form_id", "views", "window_start"]);
    const grants = await asAdmin(async (q) =>
      (
        await q<{ r: string; t: boolean; f: boolean }>(
          `select r, has_table_privilege(r, 'app.form_view_counts', 'select') as t,
                  has_function_privilege(r, 'app.public_sender_header()', 'execute') as f
             from unnest(array['anon', 'authenticated', 'service_role']) r`,
        )
      ).rows,
    );
    expect(grants.every((g) => !g.t && !g.f)).toBe(true);
    // intake_form itself stays the service role's only
    expect((await pgError(asUser(owner.id, (q) => q("select public.intake_form($1)", [form.token])))).code).toBe("42501");

    await view(other.token, sender("gone"));
    expect(Number(await counters(other.id))).toBeGreaterThan(0);
    await asAdmin((q) => q("delete from public.forms where id = $1", [other.id]));
    expect(Number(await counters(other.id))).toBe(0);
  });

  it("intake_form is volatile now (it writes a counter), with one signature", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ sig: string; vol: string }>(
          "select p.oid::regprocedure::text as sig, p.provolatile as vol from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'intake_form'",
        )
      ).rows,
    );
    expect(rows).toEqual([{ sig: "intake_form(text)", vol: "v" }]);
  });
});
