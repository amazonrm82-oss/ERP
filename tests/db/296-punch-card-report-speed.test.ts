import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * PKG-07 review: the punch cards report on 3,000 cards with 9,000 used entries stays far under the hosted statement
 * timeout (8 s) for an owner, an admin and a manager (the roles that open it, owner (118) ב). The used entries are
 * counted by app.punch_card_used_counts (one read check per card), not under punch_card_uses' policy (one card policy
 * check per use). The fixture is analyzed first: unanalyzed estimates hide plans that real statistics pick (021144).
 * Measured locally on 4 November 2026: about 7.0-7.7 s before that helper, about 1.3-1.9 s after.
 */
describe("punch cards report on many cards (PKG-07 review)", () => {
  let owner: U, admin: U, manager: U;
  let org: string;
  const BOUND_MS = 3000;

  beforeAll(async () => {
    owner = await createUser("prs-owner");
    org = await createOrg(owner.id, "סטודיו גדול");
    admin = await addMember(org, owner.id, "admin", "prs-admin");
    manager = await addMember(org, owner.id, "manager", "prs-manager");
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ products: true, payments: true, punch_cards: true })]),
    );
    const product = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.products (organization_id, name, kind, price_agorot, punch_entries) values ($1, 'כרטיסייה 10', 'punch_card', 50000, 10) returning id",
          [org],
        )
      ).rows[0].id,
    );
    // fixture rows in bulk: triggers set aside (as server data); 300 contacts with 10 active cards each, 3 entries used
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(
        `insert into public.contacts (organization_id, first_name, owner_id)
         select $1, 'לקוח ' || g, $2 from generate_series(1, 300) g`,
        [org, owner.id],
      );
      await q(
        `insert into public.punch_cards (organization_id, contact_id, product_id, name, entries_total, status, activated_at,
                                         activated_manually, expires_on, price_agorot)
         select $1, c.id, $2, 'כרטיסייה 10', 10, 'active', now(), true, current_date + (g % 60), 50000
           from public.contacts c, generate_series(1, 10) g
          where c.organization_id = $1`,
        [org, product],
      );
      await q(
        `insert into public.punch_card_uses (organization_id, card_id, used_on)
         select $1, c.id, current_date from public.punch_cards c, generate_series(1, 3) g where c.organization_id = $1`,
        [org],
      );
    });
    await asAdmin((q) => q("analyze public.contacts, public.punch_cards, public.punch_card_uses, public.products"));
  });

  it.each([
    ["owner", () => owner],
    ["admin", () => admin],
    ["manager", () => manager],
  ])("%s: 3,000 cards and 9,000 entries counted well within the statement timeout", async (_name, who) => {
    const started = Date.now();
    const r = await asUser(who().id, async (q) =>
      (await q<{ r: { partial: boolean; totals: { active: number; entries_used: number; entries_total: number } } }>("select public.report_punch_cards($1) as r", [org])).rows[0].r,
    );
    const took = Date.now() - started;
    console.info(`PKG-07 report, ${_name}: ${took} ms`);
    expect(r.partial).toBe(false);
    expect(r.totals).toMatchObject({ active: 3000, entries_used: 9000, entries_total: 30000 });
    expect(took).toBeLessThan(BOUND_MS);
  });
});
