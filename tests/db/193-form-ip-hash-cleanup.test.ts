import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

const MIGRATION = readFileSync(join(process.cwd(), "supabase/migrations/20261006020495_form_ip_hash_cleanup.sql"), "utf8");

const submit = (token: string, name: string, ipHash: string | null) =>
  asService(async (q) =>
    (await q<{ r: { status: string; lead_id?: string } }>("select public.intake_submit($1, 'form', $2, $3, null, false) as r", [token, JSON.stringify({ full_name: name, phone: "050-1234567" }), ipHash])).rows[0].r,
  );
type Sub = { id: string; ip_hash: string | null; status: string; lead_id: string | null; payload: unknown };
const subs = (formId: string) =>
  asAdmin(async (q) => (await q<Sub>("select id, ip_hash, status, lead_id, payload from public.form_submissions where form_id = $1 order by created_at, id", [formId])).rows);
const age = (formId: string, minutes: number) =>
  asAdmin((q) => q("update public.form_submissions set created_at = now() - make_interval(mins => $2) where form_id = $1", [formId, minutes]));
const clear = () => asAdmin(async (q) => (await q<{ n: number }>("select app.clear_form_ip_hashes() as n")).rows[0].n);

// FXS-11 (owner, 13 October 2026): the sender's IP hash is kept only for the rate-limit window.
describe("form IP hashes are cleared after the rate-limit window (FXS-11)", () => {
  let owner: { id: string };
  let org: string;

  const newForm = (name: string) =>
    asUser(owner.id, async (q) => (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name) values ($1, $2) returning id, token", [org, name])).rows[0]);

  beforeAll(async () => {
    owner = await createUser("fxs11-owner");
    org = await createOrg(owner.id);
  });

  it("clears only the hash, and only past 15 minutes; the submission and its lead stay", async () => {
    const old = await newForm("ישן");
    const fresh = await newForm("חדש");
    const a = await submit(old.token, "ישן", "hash-old");
    await submit(fresh.token, "חדש", "hash-fresh");
    await age(old.id, 16);
    await age(fresh.id, 14);
    const before = await subs(old.id);

    expect(await clear()).toBeGreaterThanOrEqual(1);
    const [oldRow] = await subs(old.id);
    expect(oldRow.ip_hash).toBeNull();
    expect({ ...oldRow, ip_hash: before[0].ip_hash }).toEqual(before[0]);
    expect(oldRow.lead_id).toBe(a.lead_id);
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where id = $1", [a.lead_id]))).toBe(1);
    // within the window: kept, so the rate limit still sees it
    expect((await subs(fresh.id))[0].ip_hash).toBe("hash-fresh");
    // again: nothing more to clear for these forms
    await clear();
    expect((await subs(fresh.id))[0].ip_hash).toBe("hash-fresh");
  });

  it("the rate limit still works inside the window after a clearing", async () => {
    const form = await newForm("עמוס");
    for (let i = 0; i < 10; i++) await submit(form.token, `פונה ${i}`, "busy");
    await clear();
    expect((await pgError(submit(form.token, "עוד", "busy"))).hint).toBe("rate_limited");
    // past the window the hashes are gone and the sender may write again
    await age(form.id, 16);
    await clear();
    expect((await subs(form.id)).every((s) => s.ip_hash === null)).toBe(true);
    expect(["accepted", "duplicate"]).toContain((await submit(form.token, "אחרי", "busy")).status);
  });

  it("the migration clears every hash made before it, recent ones too, and nothing else", async () => {
    const form = await newForm("לפני");
    await submit(form.token, "לפני", "hash-before");
    const before = await subs(form.id);
    await asAdmin((q) => q(MIGRATION));
    const after = await subs(form.id);
    expect(after[0].ip_hash).toBeNull();
    expect({ ...after[0], ip_hash: before[0].ip_hash }).toEqual(before[0]);
    expect(await asAdmin((q) => count(q, "select 1 from public.form_submissions where ip_hash is not null"))).toBe(0);
  });

  it("only the server clears; no client can call it", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("select app.clear_form_ip_hashes()")))).code).toBe("42501");
    expect((await pgError(asService((q) => q("select app.clear_form_ip_hashes()")))).code).toBe("42501");
  });

  it("the migration holds no drop statement and no delete", () => {
    const statements = MIGRATION.replace(/--.*$/gm, "").split(";").map((part) => part.trim().toLowerCase());
    expect(statements.filter((part) => part.startsWith("drop"))).toEqual([]);
    expect(MIGRATION).not.toMatch(/delete\s+from/i);
  });
});
