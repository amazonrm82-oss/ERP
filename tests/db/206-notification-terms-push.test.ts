import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asService, asUser, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

type Claimed = { user_id: string; organization_id: string; title: string; terms: { contact_term: string | null; lead_term: string | null; deal_term: string | null } };

// FLD-10 part three: the push dispatcher has no user session, so the claim carries each business's term keys; the app
// redraws the stored text in those words (push-payload.ts). A business without its own words gets nulls (today's words).
describe("a claimed push carries its business's term keys (FLD-10 part three)", () => {
  let worded: { owner: string; org: string };
  let plain: { owner: string; org: string };

  beforeAll(async () => {
    const make = async (label: string) => {
      const owner = (await createUser(label)).id;
      const org = await createOrg(owner, `עסק ${label}`);
      await asAdmin((q) =>
        q("insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, 'k', 'a')", [owner, `https://push.example.test/${owner}`]),
      );
      return { owner, org };
    };
    worded = await make("terms-worded");
    plain = await make("terms-plain");
    await asUser(worded.owner, (q) =>
      q("insert into public.org_terms (organization_id, lead_term, deal_term) values ($1, 'inquiry', 'case')", [worded.org]),
    );
    await asAdmin(async (q) => {
      for (const { org, owner } of [worded, plain]) {
        await q("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'lead_new', 'ליד חדש הוקצה לכם')", [org, owner]);
      }
    });
  });

  it("each row has its own business's keys; no row = nulls; the stored text is unchanged", async () => {
    const batch = await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_push_notifications(500) as r")).rows[0].r);
    const mine = (user: string) => batch.filter((n) => n.user_id === user);
    expect(mine(worded.owner)).toEqual([
      expect.objectContaining({ organization_id: worded.org, title: "ליד חדש הוקצה לכם", terms: { contact_term: null, lead_term: "inquiry", deal_term: "case" } }),
    ]);
    expect(mine(plain.owner)).toEqual([
      expect.objectContaining({ organization_id: plain.org, title: "ליד חדש הוקצה לכם", terms: { contact_term: null, lead_term: null, deal_term: null } }),
    ]);
  });

  it("stays the service role's alone", async () => {
    await expect(asUser(worded.owner, (q) => q("select public.claim_push_notifications(10)"))).rejects.toMatchObject({ code: "42501" });
  });
});
