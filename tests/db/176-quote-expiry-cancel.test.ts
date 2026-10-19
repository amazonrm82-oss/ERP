import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * QUO-11: a sent or viewed quote whose validity date has passed in the business's time zone becomes "expired" by the job
 * (fair per business, batched, one quote's failure never stops the rest), and a person who may edit its record can cancel
 * a sent, viewed or expired quote, never an accepted one. Both leave a system entry on the timeline (never contact), and
 * expiry tells the quote's owner.
 */
describe("quote expiry and cancelling (QUO-11)", () => {
  let owner: U, admin: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];

  const setupOrg = async (who: U, name: string) => {
    const id = await createOrg(who.id, name);
    await asUser(who.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [id]),
    );
    return id;
  };

  // a sent quote on a new deal (with a contact) of the given business, made by `by`
  const sentQuote = async (orgId: string, by: U, title = "שיפוץ") => {
    const pipe = orgId === org ? { pipelineId, stageId } : await defaultPipeline(orgId).then((p) => ({ pipelineId: p.pipelineId, stageId: p.stages[0].id }));
    return asUser(by.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'רונית', $2) returning id", [orgId, by.id])).id;
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id", [
          orgId,
          pipe.pipelineId,
          pipe.stageId,
          contact,
          by.id,
        ])
      ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, $2, $3, $4) returning id", [orgId, title, deal, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 50000)", [orgId, quote]);
      await q("select public.quote_send($1, $2)", [orgId, quote]);
      return { quote, deal, contact };
    });
  };
  // the validity date, as a number of days from the business's own today
  // the validity date, as a number of days from the business's own today (written past the triggers: a sent quote's dates
  // are frozen, and the quote date must not come after it)
  const setDates = (quote: string, validSql: string, params: unknown[] = []) =>
    asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q(
        `update public.quotes q set valid_until = (${validSql}), quote_date = least(q.quote_date, (${validSql}))
           from public.organizations o where o.id = q.organization_id and q.id = $1`,
        [quote, ...params],
      );
    });
  const validFor = (quote: string, days: number) => setDates(quote, "(now() at time zone app.intake_zone(o.timezone))::date + $2::int", [days]);
  const status = (quote: string) => asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.quotes where id = $1", [quote])).s);
  const expire = (settings: Record<string, string> = {}) =>
    asAdmin(async (q) => {
      for (const [key, value] of Object.entries(settings)) await q("select set_config($1, $2, true)", [key, value]);
      return (await one<{ n: number }>(q, "select app.expire_quotes() as n")).n;
    });
  const entries = (quote: string) =>
    asAdmin(
      async (q) =>
        (
          await q<{ type: string; body: string; created_by: string | null; kind: string; deal_id: string | null; contact_id: string | null }>(
            `select type, body, created_by, metadata->>'kind' as kind, deal_id, contact_id from public.activities
              where metadata->>'quote_id' = $1 and metadata->>'kind' in ('quote_expired', 'quote_cancelled') order by created_at, id`,
            [quote],
          )
        ).rows,
    );
  // keep other tests' leftovers from taking the job's slots: everything already past its date is expired first
  const settle = () => expire();

  beforeAll(async () => {
    owner = await createUser("qx-owner");
    org = await setupOrg(owner, "עסק התוקף");
    admin = await addMember(org, owner.id, "admin", "qx-admin");
    member = await addMember(org, owner.id, "member", "qx-member");
    await asAdmin((q) => q("update public.profiles set full_name = 'דנה כהן' where id = $1", [member.id]));
    viewer = await addMember(org, owner.id, "viewer", "qx-viewer");
    outsider = await createUser("qx-outsider");
    otherOrg = await setupOrg(outsider, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
  });

  it("expires a sent or viewed quote after its date in the business's zone, with a system entry and a notice to its owner", async () => {
    await settle();
    const past = await sentQuote(org, member, "הצעה שפגה");
    const today = await sentQuote(org, member);
    const viewed = await sentQuote(org, member);
    const noDate = await sentQuote(org, member);
    await validFor(past.quote, -1);
    await validFor(today.quote, 0);
    await validFor(viewed.quote, -3);
    await asAdmin((q) => q("update public.quotes set status = 'viewed' where id = $1", [viewed.quote]));
    await asAdmin((q) => q("update public.quotes set valid_until = null where id = $1", [noDate.quote]));
    const lastContact = await asAdmin(async (q) => (await one<{ t: Date }>(q, "select last_contacted_at as t from public.contacts where id = $1", [past.contact])).t);

    expect(await expire()).toBe(2);
    expect([await status(past.quote), await status(today.quote), await status(viewed.quote), await status(noDate.quote)]).toEqual(["expired", "sent", "expired", "sent"]);
    // one system entry on the deal and the contact, no author, never contact with the customer
    const [entry, ...rest] = await entries(past.quote);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ type: "system", created_by: null, kind: "quote_expired", deal_id: past.deal, contact_id: past.contact });
    expect(entry.body).toMatch(/פג תוקפה$/);
    expect(await asAdmin(async (q) => (await one<{ t: Date }>(q, "select last_contacted_at as t from public.contacts where id = $1", [past.contact])).t)).toEqual(lastContact);
    // the quote's owner hears of it: kind `quote`, the title and number, no amount
    const notes = await asAdmin(async (q) => (await q<{ user_id: string; type: string; title: string; body: string | null }>("select user_id, type, title, body from public.notifications where entity_id = $1", [past.quote])).rows);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ user_id: member.id, type: "quote", title: "פג תוקפה של הצעת מחיר: הצעה שפגה" });
    expect(JSON.stringify(notes[0])).not.toMatch(/500/);
    // once: the next run finds nothing
    expect(await expire()).toBe(0);
    expect(await entries(past.quote)).toHaveLength(1);
    // the customer's page was already closed for it
    expect(await asAdmin(async (q) => (await one<{ c: number }>(q, "select count(*)::int as c from public.quotes where id = $1 and status = 'expired'", [past.quote])).c)).toBe(1);
    // the quote valid until today would expire at Jerusalem's midnight, inside a later test's count: close it here
    await asAdmin((q) => q("update public.quotes set status = 'cancelled' where id = $1", [today.quote]));
  });

  it("leaves drafts and answered quotes alone, and judges 'today' in each business's own time zone", async () => {
    await settle();
    const accepted = await sentQuote(org, member);
    await validFor(accepted.quote, -5);
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [accepted.quote]));
    // far east and far west, each a business of its own: moving a business that already holds quotes (the earlier tests'
    // quotes valid until Jerusalem's today) to Kiritimati would expire them too for half of every day.
    // Kiritimati (UTC+14) is always 25 hours ahead of Pago Pago (UTC-11), so the date that is already past in
    // Kiritimati is still today in Pago Pago at any hour.
    const eastOwner = await createUser("qx-east");
    const westOwner = await createUser("qx-west");
    const eastOrg = await setupOrg(eastOwner, "עסק במזרח");
    const westOrg = await setupOrg(westOwner, "עסק במערב");
    await asAdmin((q) => q("update public.organizations set timezone = 'Pacific/Kiritimati' where id = $1", [eastOrg]));
    await asAdmin((q) => q("update public.organizations set timezone = 'Pacific/Pago_Pago' where id = $1", [westOrg]));
    const east = await sentQuote(eastOrg, eastOwner);
    const west = await sentQuote(westOrg, westOwner);
    try {
      for (const quote of [east.quote, west.quote]) {
        await setDates(quote, "(now() at time zone 'Pacific/Pago_Pago')::date");
      }
      expect(await expire()).toBe(1);
      expect([await status(east.quote), await status(west.quote), await status(accepted.quote)]).toEqual(["expired", "sent", "accepted"]);
    } finally {
      // the west quote expires on Pago Pago's next day: close it, so no later count in this file can take it
      await asAdmin((q) => q("update public.quotes set status = 'cancelled' where id = $1 and status = 'sent'", [west.quote]));
    }
  });

  it("is fair across businesses and batched, and one failing quote waits while the others go on", async () => {
    await settle();
    const a = [await sentQuote(org, member), await sentQuote(org, member), await sentQuote(org, member)];
    const b = await sentQuote(otherOrg, outsider);
    for (const [i, x] of a.entries()) await validFor(x.quote, -10 + i);
    await validFor(b.quote, -1);
    // two per business: the first business cannot take the second one's turn
    expect(await expire({ "app.quote_expiry_per_org": "2" })).toBe(3);
    expect([await status(a[0].quote), await status(a[1].quote), await status(a[2].quote), await status(b.quote)]).toEqual(["expired", "expired", "sent", "expired"]);
    // and a limit per run
    const c = [await sentQuote(org, member), await sentQuote(org, member)];
    for (const x of c) await validFor(x.quote, -1);
    expect(await expire({ "app.quote_expiry_limit": "1" })).toBe(1);
    expect(await expire()).toBe(2);

    // a quote whose expiry fails is rolled back alone and waits an hour
    const bad = await sentQuote(org, member);
    const good = await sentQuote(org, member);
    await validFor(bad.quote, -2);
    await validFor(good.quote, -1);
    await asAdmin(async (q) => {
      await q(`create function public.qx_fail() returns trigger language plpgsql as $$
               begin if new.id = '${bad.quote}' and new.status = 'expired' then raise exception 'boom'; end if; return new; end $$`);
      await q("create trigger qx_fail before update on public.quotes for each row execute function public.qx_fail()");
    });
    try {
      expect(await expire()).toBe(1);
      expect([await status(bad.quote), await status(good.quote)]).toEqual(["sent", "expired"]);
      expect(await entries(bad.quote)).toEqual([]);
      expect(await asAdmin((q) => count(q, "select 1 from app.quote_expiry_retry where quote_id = $1 and retry_at > now() + interval '50 minutes'", [bad.quote]))).toBe(1);
    } finally {
      await asAdmin(async (q) => {
        await q("drop trigger qx_fail on public.quotes");
        await q("drop function public.qx_fail()");
      });
    }
    // still waiting: the next run skips it; once its hour is up it expires
    expect(await expire()).toBe(0);
    await asAdmin((q) => q("update app.quote_expiry_retry set retry_at = now() - interval '1 minute' where quote_id = $1", [bad.quote]));
    expect(await expire()).toBe(1);
    expect(await status(bad.quote)).toBe("expired");
    // its waiting row is marked done, not left waiting
    expect(await asAdmin((q) => count(q, "select 1 from app.quote_expiry_retry where quote_id = $1 and done_at is not null", [bad.quote]))).toBe(1);
  });

  it("does not tell an owner who is no longer an active member; the owners and admins hear instead (RVW-34)", async () => {
    await settle();
    const gone = await addMember(org, owner.id, "member", "qx-gone");
    const x = await sentQuote(org, gone);
    await validFor(x.quote, -1);
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, gone.id]));
    expect(await expire()).toBe(1);
    expect(await status(x.quote)).toBe("expired");
    // the suspended owner gets nothing; the deal and contact are theirs too, so the owners and admins are told (020435)
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1 and user_id = $2", [x.quote, gone.id]))).toBe(0);
    const told = await asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.notifications where entity_id = $1 order by user_id", [x.quote])).rows.map((r) => r.user_id));
    expect(told).toEqual([owner.id, admin.id].sort());
  });

  it("cancelling: whoever may edit the record, a sent, viewed or expired quote; a system entry naming who cancelled", async () => {
    const sent = await sentQuote(org, member);
    const token = await asUser(member.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, sent.quote])).t);
    // a viewer, an outsider and a stranger quote id are refused alike
    expect((await pgError(asUser(viewer.id, (q) => q("select public.quote_cancel($1, $2)", [org, sent.quote])))).code).toBe("42501");
    expect((await pgError(asUser(outsider.id, (q) => q("select public.quote_cancel($1, $2)", [org, sent.quote])))).code).toBe("42501");
    expect((await pgError(asUser(outsider.id, (q) => q("select public.quote_cancel($1, $2)", [otherOrg, sent.quote])))).code).toBe("42501");
    expect(await status(sent.quote)).toBe("sent");

    await asUser(member.id, (q) => q("select public.quote_cancel($1, $2)", [org, sent.quote]));
    expect(await status(sent.quote)).toBe("cancelled");
    const [entry] = await entries(sent.quote);
    expect(entry).toMatchObject({ type: "system", created_by: null, kind: "quote_cancelled", deal_id: sent.deal, contact_id: sent.contact });
    expect(entry.body).toMatch(/בוטלה על ידי דנה כהן$/);
    // the customer's page closes
    expect((await pgError(asService((q) => q("select public.quote_public($1)", [token])))).code).toBe("P0002");
    // once cancelled, it stays so
    expect((await pgError(asUser(member.id, (q) => q("select public.quote_cancel($1, $2)", [org, sent.quote])))).hint).toBe("quote_cancel:closed");

    const viewed = await sentQuote(org, member);
    await asAdmin((q) => q("update public.quotes set status = 'viewed' where id = $1", [viewed.quote]));
    await asUser(admin.id, (q) => q("select public.quote_cancel($1, $2)", [org, viewed.quote]));
    const expired = await sentQuote(org, member);
    await asAdmin((q) => q("update public.quotes set status = 'expired' where id = $1", [expired.quote]));
    await asUser(member.id, (q) => q("select public.quote_cancel($1, $2)", [org, expired.quote]));
    expect([await status(viewed.quote), await status(expired.quote)]).toEqual(["cancelled", "cancelled"]);
  });

  it("cancelling refuses a draft, an accepted or a declined quote, and a business without quotes", async () => {
    const draft = await asUser(member.id, async (q) => {
      const deal = (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [org, pipelineId, stageId, member.id])).id;
      return (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'טיוטה', $2) returning id", [org, deal])).id;
    });
    const cancel = (quote: string) => pgError(asUser(member.id, (q) => q("select public.quote_cancel($1, $2)", [org, quote])));
    expect((await cancel(draft)).hint).toBe("quote_cancel:draft");
    const accepted = await sentQuote(org, member);
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [accepted.quote]));
    expect((await cancel(accepted.quote)).hint).toBe("quote_cancel:accepted");
    const rejected = await sentQuote(org, member);
    await asAdmin((q) => q("update public.quotes set status = 'rejected' where id = $1", [rejected.quote]));
    expect((await cancel(rejected.quote)).hint).toBe("quote_cancel:closed");
    expect([await status(draft), await status(accepted.quote), await status(rejected.quote)]).toEqual(["draft", "accepted", "rejected"]);

    const open = await sentQuote(org, member);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"quotes\": false}' where organization_id = $1", [org]));
    try {
      expect((await cancel(open.quote)).hint).toBe("feature:quotes");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides - 'quotes' where organization_id = $1", [org]));
    }
    expect(await status(open.quote)).toBe("sent");
  });

  it("a person can neither write an expiry or cancel entry nor reach the job; only signed-in people may cancel", async () => {
    const { deal } = await sentQuote(org, member);
    for (const kind of ["quote_expired", "quote_cancelled"]) {
      const err = await pgError(
        asUser(owner.id, (q) => q("insert into public.activities (organization_id, type, deal_id, body, metadata) values ($1, 'note', $2, 'x', $3)", [org, deal, JSON.stringify({ kind })])),
      );
      expect(err.hint, kind).toBe("activity:quote_entry");
    }
    for (const [role, fn, expected] of [
      ["authenticated", "public.quote_cancel(uuid, uuid)", true],
      ["anon", "public.quote_cancel(uuid, uuid)", false],
      ["authenticated", "app.expire_quotes()", false],
      ["service_role", "app.expire_quotes()", false],
      ["authenticated", "app.quote_timeline_entry()", false],
    ] as const) {
      expect(await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as c", [role, fn])).c), `${role} ${fn}`).toBe(expected);
    }
  });
});
