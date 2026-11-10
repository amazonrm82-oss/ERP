import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asService, asUser, closePool, count, createOrg, createUser, TEST_DB_URL } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Answer = Record<string, unknown>;
type Claimed = { arrival: string; lease: string; integration_id: string };

const envelope = (body: string) => `ps1.1.AAAAAAAAAAAAAAAA.${body}.BBBBBBBBBBBBBBBBBBBBBB`;

/**
 * CAP-11, the lost race (migration _meta_lead_finish_race.sql): an unverified connection whose fetch succeeds after the
 * page was verified by another business meanwhile (that verification skipped this connection's rows because another
 * transaction held them). public.meta_lead_finish used to raise integration:taken there (moving the status through the
 * going-live check), so the arrival stayed pending until the 3-day give-up. It now answers 'refused': the connection ends
 * by its code (page_taken, status kept), every pending arrival of it is refused with page_taken, and no lead is made.
 */
describe("meta_lead_finish: a connection that lost the page race (CAP-11)", () => {
  let winnerOwner: U, loserOwner: U;
  let winnerOrg: string, loserOrg: string;
  let seq = (process.pid % 100000) * 1000 + 700;
  const id = () => String(8300000000 + (seq += 1));

  const makeConnection = (who: U, o: string, page: string, token: string) =>
    asUser(who.id, async (q) => {
      const made = (await q<{ id: string }>("insert into public.integrations (organization_id, provider, external_id, name) values ($1, 'meta_lead_ads', $2, 'הדף') returning id", [o, page])).rows[0].id;
      await q("select public.integration_secret_set($1, $2, $3, 1)", [o, made, envelope(token)]);
      return made;
    });
  const receive = (page: string) =>
    asService(async (q) => (await q<{ r: Answer }>("select public.meta_lead_receive($1, $2) as r", [page, JSON.stringify([{ id: id() }])])).rows[0].r);
  const claim = (ids: string[]) =>
    asService(async (q) => (await q<{ r: Claimed[] }>("select public.meta_lead_claim(20, $1::uuid[]) as r", [ids])).rows[0].r);
  const finish = (c: Claimed, lead: Answer) =>
    asService(async (q) => (await q<{ r: string }>("select public.meta_lead_finish($1, $2, $3, null) as r", [c.arrival, c.lease, JSON.stringify(lead)])).rows[0].r);
  const arrivalOf = (arrival: string) =>
    asAdmin(async (q) => (await q<Answer>("select status, last_error_code, lease, done_at is not null as done from app.meta_lead_arrivals where id = $1", [arrival])).rows[0]);
  const connection = (integration: string) =>
    asAdmin(async (q) => (await q<Answer>("select status, last_error_code, verified_at is not null as verified from public.integrations where id = $1", [integration])).rows[0]);

  beforeAll(async () => {
    winnerOwner = await createUser("metarace-winner");
    winnerOrg = await createOrg(winnerOwner.id, "עסק הדף");
    loserOwner = await createUser("metarace-loser");
    loserOrg = await createOrg(loserOwner.id, "עסק שני");
  });

  it("the loser's finish answers refused, ends its arrivals with page_taken and makes no lead", async () => {
    const page = id();
    const winner = await makeConnection(winnerOwner, winnerOrg, page, "V2lubmVyVG9rZW4");
    const loser = await makeConnection(loserOwner, loserOrg, page, "TG9zZXJUb2tlbg");

    // two leads of the unverified page reach both connections
    const first = (await receive(page)).arrivals as string[];
    const second = (await receive(page)).arrivals as string[];
    const claimed = await claim(first);
    const winnerArrival = claimed.find((c) => c.integration_id === winner) as Claimed;
    const loserArrival = claimed.find((c) => c.integration_id === loser) as Claimed;
    expect(winnerArrival).toBeDefined();
    expect(loserArrival).toBeDefined();
    const loserWaiting = await asAdmin(
      async (q) => (await q<{ id: string }>("select id from app.meta_lead_arrivals where id = any($1::uuid[]) and integration_id = $2", [second, loser])).rows[0].id,
    );

    // another transaction holds the loser's connection row and its arrivals (its own finish in flight, a person's update):
    // the winner's verification skips them, as app.meta_lead_end_connection does
    const holder = new Client({ connectionString: TEST_DB_URL });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from public.integrations where id = $1 for update", [loser]);
      await holder.query("select 1 from app.meta_lead_arrivals where id = any($1::uuid[]) for update", [[loserArrival.arrival, loserWaiting]]);
      expect(await finish(winnerArrival, { full_name: "ליד של בעל הדף", phone: "050-8310001" })).toBe("accepted");
      await holder.query("rollback");
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
    expect(await connection(winner)).toMatchObject({ verified: true });
    // the race: the loser is still open, unverified, its arrivals still pending
    expect(await connection(loser)).toMatchObject({ status: "connected", last_error_code: null, verified: false });
    expect(await arrivalOf(loserWaiting)).toMatchObject({ status: "pending" });

    // the loser's fetch comes back with a lead: refused, never raised
    expect(await finish(loserArrival, { full_name: "ליד שאבד", phone: "050-8310002" })).toBe("refused");
    expect(await arrivalOf(loserArrival.arrival)).toMatchObject({ status: "refused", last_error_code: "page_taken", lease: null, done: true });
    expect(await arrivalOf(loserWaiting)).toMatchObject({ status: "refused", last_error_code: "page_taken", lease: null, done: true });
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1", [loserOrg]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and full_name = 'ליד של בעל הדף'", [winnerOrg]))).toBe(1);

    // ended by its code: the status is kept (moving it would be refused while the page is verified elsewhere)
    expect(await connection(loser)).toMatchObject({ status: "connected", last_error_code: "page_taken", verified: false });
    // receive and claim leave it out from now on
    const next = await receive(page);
    expect(await asAdmin((q) => count(q, "select 1 from app.meta_lead_arrivals where id = any($1::uuid[]) and integration_id = $2", [next.arrivals, loser]))).toBe(0);
    expect((await claim(next.arrivals as string[])).every((c) => c.integration_id === winner)).toBe(true);
    // its business sees the page_taken line and gets the failure notice; the winner's log says nothing about it
    expect(
      await asAdmin((q) => count(q, "select 1 from public.integration_events where connection_id = $1 and kind = 'page_taken'", [loser])),
    ).toBe(1);
    expect(
      await asAdmin((q) =>
        count(q, "select 1 from public.notifications where organization_id = $1 and entity_type = 'integration' and entity_id = $2 and user_id = $3", [
          loserOrg,
          loser,
          loserOwner.id,
        ]),
      ),
    ).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.integration_events where connection_id = $1 and kind = 'page_taken'", [winner]))).toBe(0);
  });
});
