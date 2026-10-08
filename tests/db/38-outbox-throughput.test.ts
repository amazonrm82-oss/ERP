import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, closePool, count, createOrg, createUser } from "./helpers";

afterAll(closePool);

describe("the event queue keeps up with large imports (FXD-01)", () => {
  let org: string;

  beforeAll(async () => {
    const owner = await createUser("outbox-owner");
    org = await createOrg(owner.id);
    // start from an empty queue
    await asAdmin((q) => q("select app.process_outbox_rounds()"));
  });

  const insertEvents = (n: number, origin: string | null) =>
    asAdmin((q) =>
      q(
        `insert into public.outbox_events (organization_id, event_type, entity_type, entity_id, payload)
         select $1, 'lead.created', 'lead', gen_random_uuid(), case when $3::text is null then '{}'::jsonb else jsonb_build_object('origin', $3::text) end
           from generate_series(1, $2)`,
        [org, n, origin],
      ),
    );
  const pending = () => asAdmin((q) => count(q, "select 1 from public.outbox_events where organization_id = $1 and processed_at is null", [org]));

  it("events from an import or an automation are written already handled", async () => {
    await insertEvents(300, "import");
    await insertEvents(200, "automation");
    expect(await pending()).toBe(0);
    await insertEvents(3, null);
    expect(await pending()).toBe(3);
    await asAdmin((q) => q("select app.process_outbox_rounds()"));
    expect(await pending()).toBe(0);
  });

  it("the job works in rounds until the queue is empty", async () => {
    await insertEvents(1200, null);
    const done = await asAdmin(async (q) => (await q<{ n: number }>("select app.process_outbox_rounds(500) as n")).rows[0].n);
    expect(done).toBeGreaterThanOrEqual(1200);
    expect(await pending()).toBe(0);
  });

  it("the every-minute job calls the rounds", async () => {
    const job = await asAdmin(async (q) => {
      const has = (await q<{ n: number }>("select count(*)::int as n from pg_extension where extname = 'pg_cron'")).rows[0].n;
      return has ? (await q<{ command: string }>("select command from cron.job where jobname = 'crm-process-outbox'")).rows[0]?.command : "no pg_cron";
    });
    expect(["select app.process_outbox_rounds()", "no pg_cron"]).toContain(job);
  });
});
