import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Notice = { user_id: string; type: string; title: string; body: string; entity_type: string; entity_id: string };

/**
 * PAY-07, the notice part: recording a payment tells the owner of its deal, else of its contact, with the kind `payment`
 * (owner, 21 October 2026, answer 4: it can be muted); an owner who is a viewer or inactive does not count, and with no usable
 * owner the active owners and admins are told (answer 2); never the person who recorded it; the amount and the method only.
 */
describe("a payment received tells the record's owner (PAY-07)", () => {
  let owner: U, admin: U, rep: U, other: U, viewer: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const contactOf = (u: U, ownerId: string) =>
    run(
      u,
      async (q) =>
        (
          await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'דנה', $2) returning id", [
            org,
            ownerId,
          ])
        ).id,
    );
  const dealOf = (u: U, ownerId: string, contact: string | null) =>
    run(
      u,
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id",
            [org, pipelineId, stageId, contact, ownerId],
          )
        ).id,
    );
  const pay = (u: U, f: { deal?: string | null; contact?: string | null; amount?: number; method?: string; status?: string }) =>
    run(
      u,
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            // PAY-04: a person's cheque carries its details
            `insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, method, status,
                                          cheque_number, cheque_bank, cheque_branch, cheque_due_date, cheque_status)
             values ($1, $2, $3, $4, $5, $6,
                     case when $5 = 'cheque' then '100' end, case when $5 = 'cheque' then '12' end, case when $5 = 'cheque' then '601' end,
                     case when $5 = 'cheque' then current_date end, case when $5 = 'cheque' then 'in_hand' end) returning id`,
            [org, f.deal ?? null, f.contact ?? null, f.amount ?? 117000, f.method ?? "transfer", f.status ?? "recorded"],
          )
        ).id,
    );
  const notices = (entity: string) =>
    asAdmin(
      async (q) =>
        (
          await q<Notice>(
            "select user_id, type, title, body, entity_type, entity_id from public.notifications where entity_id = $1 and title = 'התקבל תשלום'",
            [entity],
          )
        ).rows,
    );

  beforeAll(async () => {
    owner = await createUser("pn-owner");
    org = await createOrg(owner.id, "עסק ההתראות");
    admin = await addMember(org, owner.id, "admin", "pn-admin");
    rep = await addMember(org, owner.id, "member", "pn-rep");
    other = await addMember(org, owner.id, "member", "pn-other");
    viewer = await addMember(org, owner.id, "viewer", "pn-viewer");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"payments\": true}' where organization_id = $1", [org]));
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
  });

  it("the deal's owner is told, with the amount and the method only, and the notice leads to the deal", async () => {
    const contact = await contactOf(owner, other.id);
    const deal = await dealOf(owner, rep.id, contact);
    await pay(owner, { deal, contact, amount: 117050, method: "credit" });
    expect(await notices(deal)).toEqual([
      { user_id: rep.id, type: "payment", title: "התקבל תשלום", body: "1,170.50 ₪ · כרטיס אשראי", entity_type: "deal", entity_id: deal },
    ]);
    // the contact's owner is not told when the deal has an owner
    expect(await notices(contact)).toEqual([]);
    // whole shekels without ".00"
    const second = await dealOf(owner, rep.id, null);
    await pay(owner, { deal: second, amount: 50000, method: "cheque" });
    expect((await notices(second))[0].body).toBe("500 ₪ · צ'ק");
  });

  it("without a deal (or a deal with no owner), the contact's owner is told", async () => {
    const contact = await contactOf(owner, other.id);
    await pay(owner, { contact, method: "cash", status: "confirmed" });
    expect(await notices(contact)).toEqual([expect.objectContaining({ user_id: other.id, entity_type: "contact", body: "1,170 ₪ · מזומן" })]);
    const ownerless = await dealOf(owner, rep.id, contact);
    await asAdmin((q) => q("update public.deals set owner_id = null where id = $1", [ownerless]));
    await pay(owner, { deal: ownerless, contact });
    expect(await notices(ownerless)).toEqual([]);
    expect(await notices(contact)).toHaveLength(2);
  });

  it("never the recorder; an owner who is a viewer or inactive does not count; nothing for a later change or a cancel", async () => {
    // the recorder is the owner: nobody is told (they know)
    const mine = await dealOf(owner, owner.id, null);
    await pay(owner, { deal: mine });
    expect(await notices(mine)).toEqual([]);
    // a viewer owns the contact: no usable owner, so the owners and admins, but not the recorder (the business owner)
    const seen = await contactOf(owner, viewer.id);
    await pay(owner, { contact: seen });
    expect(await notices(seen)).toEqual([expect.objectContaining({ user_id: admin.id, type: "payment", entity_type: "contact", entity_id: seen })]);
    // an inactive owner of the deal: the owners and admins again
    const deal = await dealOf(owner, other.id, null);
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, other.id]));
    try {
      await pay(owner, { deal });
      expect((await notices(deal)).map((x) => x.user_id)).toEqual([admin.id]);
    } finally {
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, other.id]));
    }
    // one notice for the recording; confirming, correcting or cancelling tells nobody again
    const told = await dealOf(owner, rep.id, null);
    const id = await pay(owner, { deal: told });
    await run(owner, (q) => q("update public.payments set status = 'confirmed' where id = $1", [id]));
    await run(owner, (q) => q("update public.payments set note = 'תוקן' where id = $1", [id]));
    await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'נרשם פעמיים' where id = $1", [id]));
    expect(await notices(told)).toHaveLength(1);
  });

  it("with no usable owner, the active owners and admins are told, never the recorder (answer 2)", async () => {
    // a second admin, so "the owners and admins" is more than one person
    const admin2 = await addMember(org, owner.id, "admin", "pn-admin2");
    // a deal and a contact with no owner, recorded by an admin: the owner and the other admin, on the deal
    const contact = await contactOf(owner, rep.id);
    await asAdmin((q) => q("update public.contacts set owner_id = null where id = $1", [contact]));
    const deal = await dealOf(owner, rep.id, contact);
    await asAdmin((q) => q("update public.deals set owner_id = null where id = $1", [deal]));
    await pay(admin, { deal, contact });
    const told = await notices(deal);
    expect(told.map((x) => x.user_id).sort()).toEqual([owner.id, admin2.id].sort());
    expect(told.every((x) => x.type === "payment" && x.entity_type === "deal")).toBe(true);
    expect(await notices(contact)).toEqual([]);
    // a suspended admin is not told
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, admin2.id]));
    const second = await contactOf(owner, rep.id);
    await asAdmin((q) => q("update public.contacts set owner_id = null where id = $1", [second]));
    await pay(owner, { contact: second });
    expect((await notices(second)).map((x) => x.user_id)).toEqual([admin.id]);
  });

  it("a person who mutes the payment kind is not told (answer 4)", async () => {
    await run(rep, (q) => q("select public.set_notification_settings($1, $2)", [["payment"], []]));
    try {
      const deal = await dealOf(owner, rep.id, null);
      await pay(owner, { deal });
      expect(await notices(deal)).toEqual([]);
    } finally {
      await run(rep, (q) => q("select public.set_notification_settings($1, $2)", [[], []]));
    }
  });
});
