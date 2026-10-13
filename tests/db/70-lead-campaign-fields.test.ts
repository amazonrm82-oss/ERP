import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

// LEAD-01: campaign, budget and the five UTM values are edited by people; utm.extra and the
// visit's own columns are never lost or written from the browser.
describe("lead campaign fields (LEAD-01)", () => {
  let owner: { id: string }, rep: { id: string }, viewer: { id: string };
  let org: string;
  let lead: string;
  const extra = { utm_id: "123", msclkid: "abc" };

  beforeAll(async () => {
    owner = await createUser("leadcamp-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "leadcamp-rep");
    viewer = await addMember(org, owner.id, "viewer", "leadcamp-viewer");
    lead = await insertLead(owner.id, org, { full_name: "ליד קמפיין" });
    // what the intake stores: classic keys plus utm.extra (written here as the server would)
    await asAdmin((q) =>
      q("update public.leads set utm = $2::jsonb, gclid = 'g-1', referrer_url = 'https://a.example/x' where id = $1", [
        lead,
        JSON.stringify({ utm_source: "facebook", utm_medium: "cpc", extra }),
      ]),
    );
  });

  const row = () =>
    asAdmin(async (q) =>
      (
        await q<{ utm: Record<string, unknown>; campaign: string | null; budget_agorot: string | null; gclid: string | null }>(
          "select utm, campaign, budget_agorot, gclid from public.leads where id = $1",
          [lead],
        )
      ).rows[0],
    );
  const merge = (as: string, patch: Record<string, unknown>) =>
    asUser(as, async (q) => (await q("update public.leads set utm = jsonb_build_object('$merge', $2::jsonb) where id = $1 returning id", [lead, JSON.stringify(patch)])).rowCount);

  it("a merge changes only the keys it names, null removes one, utm.extra stays", async () => {
    expect(await merge(owner.id, { utm_source: "google", utm_medium: null, utm_term: "נעליים" })).toBe(1);
    expect((await row()).utm).toEqual({ utm_source: "google", utm_term: "נעליים", extra });
  });

  it("two editors who saw old values do not overwrite each other's keys", async () => {
    await merge(owner.id, { utm_campaign: "חורף" });
    await merge(owner.id, { utm_content: "ad-7" });
    expect((await row()).utm).toEqual({ utm_source: "google", utm_term: "נעליים", utm_campaign: "חורף", utm_content: "ad-7", extra });
  });

  it("only the five classic keys, as text of up to 200 characters, may be patched", async () => {
    expect((await pgError(merge(owner.id, { extra: {} }))).code).toBe("22023");
    expect((await pgError(merge(owner.id, { gclid: "x" }))).code).toBe("22023");
    expect((await pgError(merge(owner.id, { utm_source: 5 }))).code).toBe("22023");
    expect((await pgError(merge(owner.id, { utm_source: "א".repeat(201) }))).code).toBe("22023");
    expect((await pgError(asUser(owner.id, (q) => q("update public.leads set utm = '{\"$merge\": [1]}' where id = $1", [lead])))).code).toBe("22023");
    expect((await row()).utm).toMatchObject({ utm_source: "google", extra });
  });

  it("campaign and budget are written by whoever may edit the lead; click ids are not", async () => {
    await asUser(owner.id, (q) => q("update public.leads set campaign = 'קיץ', budget_agorot = 1250050 where id = $1", [lead]));
    const after = await row();
    expect(after.campaign).toBe("קיץ");
    expect(Number(after.budget_agorot)).toBe(1250050);
    expect((await pgError(asUser(owner.id, (q) => q("update public.leads set gclid = 'other' where id = $1", [lead])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.leads set referrer_url = null where id = $1", [lead])))).code).toBe("42501");
    expect((await row()).gclid).toBe("g-1");
  });

  it("a member who does not own the lead, and a viewer, change nothing", async () => {
    expect(await merge(rep.id, { utm_source: "rep" })).toBe(0);
    expect(await merge(viewer.id, { utm_source: "viewer" })).toBe(0);
    expect((await row()).utm).toMatchObject({ utm_source: "google" });
  });

  it("a plain object (no $merge) is written as given, as before", async () => {
    const other = await insertLead(owner.id, org, { full_name: "ליד שני", utm: JSON.stringify({ utm_source: "x" }) });
    await asUser(owner.id, (q) => q("update public.leads set utm = '{\"utm_source\": \"y\"}' where id = $1", [other]));
    const utm = await asAdmin(async (q) => (await q<{ utm: unknown }>("select utm from public.leads where id = $1", [other])).rows[0].utm);
    expect(utm).toEqual({ utm_source: "y" });
  });

  it("a browser insert may hold only the five classic values; $merge is refused on insert for every writer", async () => {
    const ins = (utm: unknown) => insertLead(owner.id, org, { full_name: "ליד נוסף", utm: JSON.stringify(utm) });
    expect((await pgError(ins({ utm_source: "a", extra: { utm_id: "1" } }))).code).toBe("22023");
    expect((await pgError(ins({ gclid: "fake" }))).code).toBe("22023");
    expect((await pgError(ins({ utm_source: "א".repeat(201) }))).code).toBe("22023");
    expect((await pgError(ins({ utm_source: 7 }))).code).toBe("22023");
    expect((await pgError(ins({ $merge: { utm_source: "a" } }))).code).toBe("22023");
    expect((await pgError(ins([1]))).code).toBe("22023");
    // 200 code points (emoji are two UTF-16 units each) fit, as in the app
    expect(await ins({ utm_source: "😀".repeat(200), utm_medium: null })).toBeTruthy();
    const status = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.lead_statuses where organization_id = $1 limit 1", [org])).rows[0].id);
    expect(
      (await pgError(asService((q) => q("insert into public.leads (organization_id, status_id, full_name, utm) values ($1, $2, 'x', '{\"$merge\": {}}')", [org, status])))).code,
    ).toBe("22023");
  });

  it("a browser update without $merge may change only the classic values, each valid", async () => {
    const plain = (utm: unknown) => asUser(owner.id, (q) => q("update public.leads set utm = $2::jsonb where id = $1", [lead, JSON.stringify(utm)]));
    const before = (await row()).utm;
    expect((await pgError(plain({ ...before, extra: { utm_id: "changed" } }))).code).toBe("22023");
    expect((await pgError(plain({ utm_source: "google" }))).code).toBe("22023"); // drops extra
    expect((await pgError(plain({ ...before, gclid: "fake" }))).code).toBe("22023");
    expect((await pgError(plain({ ...before, utm_source: "א".repeat(201) }))).code).toBe("22023");
    expect((await row()).utm).toEqual(before);
    await plain({ ...before, utm_source: "bing" });
    expect((await row()).utm).toEqual({ ...before, utm_source: "bing" });
    await merge(owner.id, { utm_source: "google" });
  });

  it("server writers (service role, security definer) still write any object", async () => {
    const other = await insertLead(owner.id, org, { full_name: "ליד שרת" });
    await asService((q) => q("update public.leads set utm = $2::jsonb where id = $1", [other, JSON.stringify({ utm_source: "s", extra: { ttclid: "t1" } })]));
    await asAdmin((q) => q("update public.leads set utm = utm || '{\"note\": \"server\"}' where id = $1", [other]));
    const utm = await asAdmin(async (q) => (await q<{ utm: unknown }>("select utm from public.leads where id = $1", [other])).rows[0].utm);
    expect(utm).toEqual({ utm_source: "s", extra: { ttclid: "t1" }, note: "server" });
  });

  it("the trigger function is not executable by clients", async () => {
    const grants = await asAdmin(async (q) =>
      (
        await q<{ r: string; ok: boolean }>(
          `select r, has_function_privilege(r, 'app.merge_lead_utm()', 'execute') as ok
             from unnest(array['anon', 'authenticated']) r`,
        )
      ).rows,
    );
    expect(grants.every((g) => !g.ok)).toBe(true);
  });

  it("the audit log records the merged object, not the patch", async () => {
    await merge(owner.id, { utm_term: null });
    const changes = await asAdmin(async (q) =>
      (
        await q<{ changes: { utm?: { old: unknown; new: Record<string, unknown> } } }>(
          `select changes from public.audit_log where entity_id = $1 and action = 'update' and changes ? 'utm'
           order by id desc limit 1`,
          [lead],
        )
      ).rows[0].changes,
    );
    expect(changes.utm?.new).not.toHaveProperty("$merge");
    expect(changes.utm?.new).toMatchObject({ utm_source: "google", extra });
    expect(changes.utm?.new).not.toHaveProperty("utm_term");
  });
});
