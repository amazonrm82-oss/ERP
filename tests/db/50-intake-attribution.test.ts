import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, asService, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type LeadAttr = {
  campaign: string | null;
  utm: Record<string, string>;
  referrer_url: string | null;
  landing_url: string | null;
  gclid: string | null;
  fbclid: string | null;
  ctwa_clid: string | null;
  meta_lead_id: string | null;
};

describe("a lead keeps where it came from (CAP-02, ADS-01)", () => {
  let owner: { id: string };
  let org: string;
  let form: { id: string; token: string };
  let webhook: { id: string; token: string };

  beforeAll(async () => {
    owner = await createUser("attr-owner");
    org = await createOrg(owner.id);
    await asUser(owner.id, async (q) => {
      form = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name) values ($1, 'טופס') returning id, token", [org])).rows[0];
      webhook = (await q<{ id: string; token: string }>("insert into public.forms (organization_id, kind, name) values ($1, 'webhook', 'Zapier') returning id, token", [org])).rows[0];
    });
  });

  const submit = (token: string, payload: Record<string, unknown>, kind = "form") =>
    asService(async (q) => (await q<{ r: { status: string; lead_id?: string } }>("select public.intake_submit($1, $2, $3) as r", [token, kind, JSON.stringify(payload)])).rows[0].r);
  const leadAttr = (id: string) =>
    asAdmin(async (q) =>
      (await q<LeadAttr>("select campaign, utm, referrer_url, landing_url, gclid, fbclid, ctwa_clid, meta_lead_id from public.leads where id = $1", [id])).rows[0],
    );

  it("a form submission stores UTM, campaign, pages and click ids on the new lead", async () => {
    const r = await submit(form.token, {
      full_name: "דנה",
      phone: "052-7000001",
      attribution: {
        utm_source: "facebook",
        utm_medium: "cpc",
        utm_campaign: "חורף",
        utm_content: "ad-7",
        gclid: "Cj0-abc_1",
        fbclid: "IwAR.2~x",
        ctwa_clid: "ct1",
        referrer_url: "https://l.facebook.com/",
        landing_url: "https://example.co.il/offer?utm_source=facebook",
      },
    });
    expect(r.status).toBe("accepted");
    expect(await leadAttr(r.lead_id!)).toEqual({
      campaign: "חורף",
      utm: { utm_source: "facebook", utm_medium: "cpc", utm_campaign: "חורף", utm_content: "ad-7" },
      referrer_url: "https://l.facebook.com/",
      landing_url: "https://example.co.il/offer?utm_source=facebook",
      gclid: "Cj0-abc_1",
      fbclid: "IwAR.2~x",
      ctwa_clid: "ct1",
      meta_lead_id: null,
    });
  });

  it("the database checks the values again: unknown keys, bad URLs, odd click ids and long text are dropped or cut", async () => {
    const r = await submit(webhook.token, {
      email: "attr2@example.com",
      attribution: {
        utm_source: "א".repeat(500),
        utm_medium: 7,
        utm_term: "  ",
        gclid: "has space",
        fbclid: "<x>",
        ctwa_clid: "c".repeat(501),
        referrer_url: "javascript:alert(1)",
        landing_url: `https://x.co/${"p".repeat(2000)}`,
        meta_lead_id: "999",
        anything: "else",
      },
    }, "webhook");
    expect(await leadAttr(r.lead_id!)).toEqual({
      campaign: null,
      utm: { utm_source: "א".repeat(200) },
      referrer_url: null,
      landing_url: null,
      gclid: null,
      fbclid: null,
      ctwa_clid: null,
      meta_lead_id: null,
    });
    // not an object at all: the lead is still created, with nothing
    const plain = await submit(webhook.token, { email: "attr3@example.com", attribution: "utm_source=x" }, "webhook");
    expect((await leadAttr(plain.lead_id!)).utm).toEqual({});
  });

  it("a repeat inquiry keeps the first touch on the lead and records the new one on the inquiry", async () => {
    const first = await submit(form.token, { full_name: "חוזר", phone: "052-7000009", attribution: { utm_source: "google", gclid: "G-first" } });
    const again = await submit(form.token, { full_name: "חוזר", phone: "052-7000009", attribution: { utm_source: "facebook", fbclid: "F-second", utm_campaign: "חדש" } });
    expect(again).toMatchObject({ status: "duplicate", lead_id: first.lead_id });
    expect(await leadAttr(first.lead_id!)).toMatchObject({ campaign: null, utm: { utm_source: "google" }, gclid: "G-first", fbclid: null });
    const meta = await asAdmin(async (q) =>
      (await q<{ metadata: Record<string, unknown> }>("select metadata from public.activities where lead_id = $1 and type = 'inquiry'", [first.lead_id])).rows[0].metadata,
    );
    expect(meta.attribution).toEqual({ utm_source: "facebook", utm_campaign: "חדש", fbclid: "F-second" });
  });

  it("the landing page keeps only its campaign parameters, whoever calls the function (CAP-02)", async () => {
    const r = await submit(webhook.token, {
      email: "attr-landing@example.com",
      attribution: {
        referrer_url: "https://l.facebook.com/?u=1&h=2",
        landing_url: `https://user:pass@shop.co.il/sale?token=secret&utm_source=fb&email=a%40b.co&gclid=G1&junk=${"j".repeat(3000)}#form`,
      },
    }, "webhook");
    // other parameters and the fragment are gone (a long address made short by that is kept); the referrer is unchanged
    expect(await leadAttr(r.lead_id!)).toMatchObject({
      landing_url: "https://shop.co.il/sale?utm_source=fb&gclid=G1",
      referrer_url: "https://l.facebook.com/?u=1&h=2",
    });
    // a repeat inquiry records the stripped address too
    await submit(webhook.token, { email: "attr-landing@example.com", attribution: { landing_url: "https://shop.co.il/?session=1#x" } }, "webhook");
    const meta = await asAdmin(async (q) =>
      (await q<{ metadata: Record<string, unknown> }>("select metadata from public.activities where lead_id = $1 and type = 'inquiry'", [r.lead_id])).rows[0].metadata,
    );
    expect(meta.attribution).toEqual({ landing_url: "https://shop.co.il/" });
  });

  it("app.campaign_only_url() follows the same rules as the app's campaignOnlyUrl()", async () => {
    // the same cases as tests/unit/intake-embed-script.test.ts
    const cases: Array<[string | null, string | null]> = [
      [null, null],
      ["https://a.co/", "https://a.co/"],
      ["https://a.co/p?x=1", "https://a.co/p"],
      ["https://a.co/p?x=1#h", "https://a.co/p"],
      ["https://a.co/p?", "https://a.co/p"],
      ["https://a.co/p#h?utm_source=a", "https://a.co/p"],
      ["https://a.co/p?utm_source=a&&x=1&gclid=G&utm_source=b", "https://a.co/p?utm_source=a&gclid=G&utm_source=b"],
      ["https://a.co/p?utm_source&ctwa_clid=C1&utm_sourcex=1", "https://a.co/p?utm_source&ctwa_clid=C1"],
      ["https://a.co/p?UTM_SOURCE=a&utm_medium=b", "https://a.co/p?utm_medium=b"],
      ["https://user:pass@a.co/p?utm_source=a&x=1", "https://a.co/p?utm_source=a"],
      ["https://user@a.co:8443/p?gclid=G", "https://a.co:8443/p?gclid=G"],
      ["https://u:p@a.co/p?utm_source=a&x=1#h", "https://a.co/p?utm_source=a"],
      ["https://a@b@a.co/?fbclid=F", "https://a.co/?fbclid=F"],
      ["https://a.co/p?next=https://u:p@b.co", "https://a.co/p"],
      ["https://a.co/@x?utm_term=t", "https://a.co/@x?utm_term=t"],
      ["https://a.co/p?utm_campaign=%D7%90+%D7%91&fbclid=F&ctwa_clid=C&utm_term=t&utm_content=c", "https://a.co/p?utm_campaign=%D7%90+%D7%91&fbclid=F&ctwa_clid=C&utm_term=t&utm_content=c"],
    ];
    for (const [input, expected] of cases) {
      const got = await asAdmin(async (q) => (await q<{ r: string | null }>("select app.campaign_only_url($1) as r", [input])).rows[0].r);
      expect(got, String(input)).toBe(expected);
    }
  });

  it("app.campaign_only_url() is not callable from the API roles", async () => {
    const e = await pgError(asService((q) => q("select app.campaign_only_url('https://a.co/?x=1')")));
    expect(e.code).toBe("42501");
  });

  it("the submission log still keeps only the five fields", async () => {
    await submit(form.token, { full_name: "לוג", phone: "052-7000011", attribution: { utm_source: "x" } });
    const payload = await asAdmin(async (q) => (await q<{ payload: Record<string, unknown> }>("select payload from public.form_submissions where form_id = $1 order by created_at desc limit 1", [form.id])).rows[0].payload);
    expect(payload).toEqual({ full_name: "לוג", phone: "052-7000011" });
  });

  it("members read the new columns but cannot write them; utm and campaign stay writable as before", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ידני" });
    for (const set of ["referrer_url = 'https://a.co'", "landing_url = 'https://a.co'", "gclid = 'x'", "fbclid = 'x'", "ctwa_clid = 'x'", "meta_lead_id = 'x'"]) {
      expect((await pgError(asUser(owner.id, (q) => q(`update public.leads set ${set} where id = $1`, [lead])))).code).toBe("42501");
    }
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.leads (organization_id, full_name, gclid) values ($1, 'x', 'g')", [org])))).code).toBe("42501");
    await asUser(owner.id, (q) => q("update public.leads set campaign = 'ידני', utm = '{\"utm_source\":\"x\"}' where id = $1", [lead]));
    const read = await asUser(owner.id, async (q) => (await q<LeadAttr>("select campaign, gclid from public.leads where id = $1", [lead])).rows[0]);
    expect(read).toEqual({ campaign: "ידני", gclid: null });
  });

  it("the columns have length checks, and the helper and intake_submit stay closed to clients", async () => {
    const lead = await insertLead(owner.id, org, { full_name: "ארוך" });
    expect((await pgError(asAdmin((q) => q("update public.leads set gclid = repeat('g', 501) where id = $1", [lead])))).code).toBe("23514");
    expect((await pgError(asAdmin((q) => q("update public.leads set landing_url = repeat('u', 2001) where id = $1", [lead])))).code).toBe("23514");
    const grants = await asAdmin(async (q) =>
      (
        await q<{ fn: string; anon: boolean; auth: boolean; service: boolean }>(
          `select p.oid::regprocedure::text as fn,
                  has_function_privilege('anon', p.oid, 'execute') as anon,
                  has_function_privilege('authenticated', p.oid, 'execute') as auth,
                  has_function_privilege('service_role', p.oid, 'execute') as service
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname, p.proname) in (('app', 'intake_attribution'), ('public', 'intake_submit'))
            order by 1`,
        )
      ).rows,
    );
    expect(grants).toEqual([
      { fn: "app.intake_attribution(jsonb)", anon: false, auth: false, service: false },
      { fn: "intake_submit(text,text,jsonb,text,text,boolean)", anon: false, auth: false, service: true },
    ]);
    const config = await asAdmin(async (q) =>
      (await q<{ config: string[] }>("select proconfig as config from pg_proc where proname = 'intake_submit'")).rows[0].config,
    );
    expect(config).toContain("search_path=\"\"");
  });
});
