import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COLLECTION_PAUSED_LINE } from "@/features/sending-pause/pause";

import { asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

/** HEB-09: one switch per business; app.customer_sending_paused is the one rule every automatic customer sender asks. */
describe("sending pause (HEB-09)", () => {
  let owner: { id: string };
  let other: { id: string };
  let org: string;
  let otherOrg: string;
  const paused = (o: string) => asAdmin(async (q) => (await q<{ p: boolean }>("select app.customer_sending_paused($1) as p", [o])).rows[0].p);

  beforeAll(async () => {
    owner = await createUser("pause-owner");
    other = await createUser("pause-other");
    org = await createOrg(owner.id);
    otherOrg = await createOrg(other.id);
  });

  it("no row = not paused; a pause holds for its own business only; resuming lifts it", async () => {
    expect(await paused(org)).toBe(false);
    await asUser(owner.id, (q) => q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'יום אבל')", [org]));
    expect(await paused(org)).toBe(true);
    expect(await paused(otherOrg)).toBe(false);
    await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [org]));
    expect(await paused(org)).toBe(false);
  });

  it("nobody but the server asks the rule, and no client reaches it", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const can = await asAdmin(async (q) => (await q<{ c: boolean }>("select has_function_privilege($1, 'app.customer_sending_paused(uuid)', 'execute') as c", [role])).rows[0].c);
      expect(can, role).toBe(false);
    }
    expect((await pgError(asUser(owner.id, (q) => q("select app.customer_sending_paused($1)", [org])))).code).toBe("42501");
  });

  it("an outsider neither reads nor pauses another business", async () => {
    expect(await asUser(other.id, async (q) => (await q("select 1 from public.org_sending_pauses where organization_id = $1", [org])).rowCount)).toBe(0);
    expect((await pgError(asUser(other.id, (q) => q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'x')", [org])))).code).toBe("42501");
    expect(await asUser(other.id, async (q) => (await q("update public.org_sending_pauses set paused = true, reason = 'x' where organization_id = $1", [org])).rowCount)).toBe(0);
    expect(await paused(org)).toBe(false);
  });

  it("every pause and resume is in the audit log with its reason", async () => {
    await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = true, reason = 'חירום' where organization_id = $1", [org]));
    const entries = await asAdmin(async (q) =>
      (await q<{ action: string }>("select action from public.audit_log where organization_id = $1 and entity_type = 'org_sending_pauses' order by created_at", [org])).rows,
    );
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const last = await asAdmin(async (q) =>
      (await q<{ c: unknown }>("select changes as c from public.audit_log where organization_id = $1 and entity_type = 'org_sending_pauses' order by id desc limit 1", [org])).rows[0].c,
    );
    expect(JSON.stringify(last)).toContain("חירום");
  });

  it("owner's answer (45): a collection reminder task made during a pause says so; one made otherwise does not", async () => {
    const boss = await createUser("pause-collect");
    const shop = await createOrg(boss.id);
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [
        shop,
        JSON.stringify({ documents: true, payments: true, balances: true, collection: true }),
      ]),
    );
    // a zone where it is between 08:00 and 23:59 now (the job's 08:00 rule), and no rest days (no moved reminders)
    const zone = await asAdmin(async (q) =>
      (
        await q<{ z: string }>(
          `select z from unnest(array['Asia/Jerusalem', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Pacific/Honolulu']) z
            where extract(hour from now() at time zone z) between 8 and 23 limit 1`,
        )
      ).rows[0].z,
    );
    await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [shop, zone]));
    await asUser(boss.id, (q) =>
      q("insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions) values ($1, '{}', false, false, '{}')", [shop]),
    );
    const contact = await asUser(boss.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'חייב') returning id", [shop])).rows[0].id,
    );
    const due = async (number: string) => {
      const id = await asUser(boss.id, async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', $3, current_date - 10, 1000) returning id",
            [shop, contact, number],
          )
        ).rows[0].id,
      );
      // due today in the business's zone: offset 0 is reached
      await asAdmin((q) => q("update public.accounting_documents set due_date = (now() at time zone $2)::date where id = $1", [id, zone]));
      return id;
    };
    const description = (document: string) =>
      asAdmin(async (q) => (await q<{ d: string | null }>("select description as d from public.tasks where organization_id = $1 and collection_document_id = $2", [shop, document])).rows);
    const job = () => asAdmin((q) => q("select app.send_collection_reminders($1::uuid[])", [[shop]]));

    await asUser(boss.id, (q) => q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'יום אבל')", [shop]));
    const during = await due("P-1");
    await job();
    expect(await description(during)).toEqual([{ d: COLLECTION_PAUSED_LINE }]);

    await asUser(boss.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [shop]));
    const after = await due("P-2");
    await job();
    expect(await description(after)).toEqual([{ d: null }]);
  });
});

