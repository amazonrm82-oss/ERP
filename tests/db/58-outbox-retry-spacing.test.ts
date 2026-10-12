import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, closePool, createOrg, createUser } from "./helpers";

afterAll(async () => {
  await asAdmin((q) => q("drop trigger if exists outbox_test_fail on public.outbox_events"));
  await asAdmin((q) => q("drop function if exists public.test_outbox_fail()"));
  await closePool();
});

// RVW-20: process_outbox_rounds() calls process_outbox() again and again in one
// run. An event that failed was the oldest pending one, so every round picked it
// again and its five attempts were used up within seconds.
describe("a failed outbox event waits for the next run (RVW-20)", () => {
  let org: string;
  let failing: number;

  beforeAll(async () => {
    const owner = await createUser("retry-owner");
    org = await createOrg(owner.id);
    await asAdmin((q) => q("select app.process_outbox_rounds()"));
    // test only: an event whose payload says so fails every time it is handled
    // (the message carries the attempt, so each failure writes a new last_error)
    await asAdmin(async (q) => {
      await q(`create or replace function public.test_outbox_fail() returns trigger language plpgsql as $$
               begin
                 if new.payload ->> 'test_fail' = 'yes' and new.processed_at is not null
                    and new.last_error is not distinct from old.last_error then
                   raise exception 'test failure %', old.attempts;
                 end if;
                 return new;
               end $$`);
      await q(`create or replace trigger outbox_test_fail before update on public.outbox_events
               for each row execute function public.test_outbox_fail()`);
    });
    failing = await asAdmin(async (q) =>
      Number(
        (
          await q<{ id: string }>(
            `insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, payload)
             values ($1, 'lead.created', 'lead', gen_random_uuid(), '{"test_fail": "yes"}') returning id`,
            [org],
          )
        ).rows[0].id,
      ),
    );
  });

  const event = () =>
    asAdmin(async (q) =>
      (
        await q<{ attempts: number; processed: boolean; last_error: string | null }>(
          "select attempts, processed_at is not null as processed, last_error from public.outbox_events where id = $1",
          [failing],
        )
      ).rows[0],
    );
  const queue = (n: number) =>
    asAdmin((q) =>
      q(
        `insert into public.outbox_events (organization_id, event_type, entity_type, entity_id)
         select $1, 'lead.created', 'lead', gen_random_uuid() from generate_series(1, $2)`,
        [org, n],
      ),
    );
  const run = () => asAdmin(async (q) => (await q<{ n: number }>("select app.process_outbox_rounds(100) as n")).rows[0].n);

  it("a long queue is handled in many rounds, and the failed event is tried once", async () => {
    await queue(1000); // ten rounds of 100 behind the failing event
    const done = await run();
    expect(done).toBeGreaterThanOrEqual(1000);
    const e = await event();
    expect(e.attempts).toBe(1);
    expect(e.processed).toBe(false);
    expect(e.last_error).toMatch(/test failure 0/);
  });

  it("each later run tries it once more, and the fifth failure marks it handled", async () => {
    for (let attempt = 2; attempt <= 5; attempt++) {
      await queue(250);
      await run();
      const e = await event();
      expect(e.attempts).toBe(attempt);
      expect(e.processed).toBe(attempt === 5);
    }
  });

  it("an event that failed in an earlier run is handled normally when it succeeds", async () => {
    await queue(1);
    const id = await asAdmin(async (q) =>
      Number(
        (
          await q<{ id: string }>(
            `insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, payload)
             values ($1, 'lead.created', 'lead', gen_random_uuid(), '{"test_fail": "yes"}') returning id`,
            [org],
          )
        ).rows[0].id,
      ),
    );
    await run();
    // the next run: the event no longer fails
    await asAdmin((q) => q("update public.outbox_events set payload = '{}' where id = $1", [id]));
    await run();
    const row = await asAdmin(
      async (q) =>
        (await q<{ attempts: number; processed: boolean }>("select attempts, processed_at is not null as processed from public.outbox_events where id = $1", [id])).rows[0],
    );
    expect(row).toEqual({ attempts: 2, processed: true });
  });
});
