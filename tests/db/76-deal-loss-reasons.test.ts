import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_LOSS_REASONS } from "@/features/deal-loss-reasons/schema";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

/** The last statement of the migration: the seed of the organizations that already exist. */
function backfillStatement(): string {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const file = readdirSync(dir).find((f) => f.endsWith("_deal_loss_reasons.sql"));
  if (!file) throw new Error("no migration *_deal_loss_reasons.sql");
  const sql = readFileSync(path.join(dir, file), "utf8");
  return sql.slice(sql.lastIndexOf("\nselect app.seed_deal_loss_reasons") + 1);
}

// DEAL-03: loss reasons are a managed list; a lost deal may carry one, and any deal a competitor.
describe("deal loss reasons (DEAL-03)", () => {
  let owner: U, admin: U, member: U, viewer: U;
  let org: string;
  let openStage: string, wonStage: string, lostStage: string, pipelineId: string;

  const reasonsOf = (o: string) =>
    asAdmin(async (q) =>
      (
        await q<{ id: string; name: string; position: number; is_active: boolean }>(
          'select id, name, position, is_active from public.deal_loss_reasons where organization_id = $1 order by position, name collate "C"',
          [o],
        )
      ).rows,
    );

  const reasonId = async (name: string) => (await reasonsOf(org)).find((r) => r.name === name)!.id;

  const newDeal = (userId: string, name = "עסקה") =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, $2, $3, $4) returning id", [
          org,
          name,
          pipelineId,
          openStage,
        ])
      ).rows[0].id,
    );

  const readDeal = (id: string) =>
    asAdmin(async (q) =>
      (
        await q<{ status: string; lost_reason: string | null; lost_reason_id: string | null; competitor: string | null }>(
          "select status, lost_reason, lost_reason_id, competitor from public.deals where id = $1",
          [id],
        )
      ).rows[0],
    );

  beforeAll(async () => {
    owner = await createUser("loss-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "loss-admin");
    member = await addMember(org, owner.id, "member", "loss-member");
    viewer = await addMember(org, owner.id, "viewer", "loss-viewer");
    const pipeline = await defaultPipeline(org);
    pipelineId = pipeline.pipelineId;
    openStage = pipeline.stages.find((s) => s.kind === "open")!.id;
    wonStage = pipeline.stages.find((s) => s.kind === "won")!.id;
    lostStage = pipeline.stages.find((s) => s.kind === "lost")!.id;
  });

  it("a new organization starts with the default reasons, in order, seeded in the creator's name", async () => {
    const rows = await reasonsOf(org);
    expect(rows.map((r) => r.name)).toEqual([...DEFAULT_LOSS_REASONS]);
    expect(rows.map((r) => r.position)).toEqual(DEFAULT_LOSS_REASONS.map((_, i) => i));
    expect(rows.every((r) => r.is_active)).toBe(true);
    const actors = await asAdmin(
      async (q) =>
        (await q<{ actor_id: string | null }>("select distinct actor_id from public.audit_log where organization_id = $1 and entity_type = 'deal_loss_reasons'", [org]))
          .rows,
    );
    expect(actors).toEqual([{ actor_id: owner.id }]);
  });

  it("the backfill seeds only organizations without any reason, and is safe to run twice", async () => {
    const emptied = await createOrg(owner.id, "עסק שמחק הכול");
    const custom = await createOrg(owner.id, "עסק עם סיבה משלו");
    await asUser(owner.id, async (q) => {
      await q("delete from public.deal_loss_reasons where organization_id = $1", [emptied]);
      await q("delete from public.deal_loss_reasons where organization_id = $1", [custom]);
      await q("insert into public.deal_loss_reasons (organization_id, name, is_active) values ($1, 'שלנו', false)", [custom]);
    });
    const statement = backfillStatement();
    await asAdmin((q) => q(statement));
    await asAdmin((q) => q(statement));
    expect((await reasonsOf(emptied)).map((r) => r.name)).toEqual([...DEFAULT_LOSS_REASONS]);
    expect((await reasonsOf(custom)).map((r) => r.name)).toEqual(["שלנו"]);
    expect((await reasonsOf(org)).length).toBe(DEFAULT_LOSS_REASONS.length);
  });

  it("every member reads the list; only owners and admins change it", async () => {
    for (const u of [member, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.deal_loss_reasons where organization_id = $1", [org])).toBe(DEFAULT_LOSS_REASONS.length);
        expect((await q("update public.deal_loss_reasons set name = name where organization_id = $1", [org])).rowCount).toBe(0);
        expect((await q("delete from public.deal_loss_reasons where organization_id = $1", [org])).rowCount).toBe(0);
      });
      expect((await pgError(asUser(u.id, (q) => q("insert into public.deal_loss_reasons (organization_id, name) values ($1, 'x')", [org])))).code).toBe("42501");
    }
    await asUser(admin.id, async (q) => {
      const id = (await q<{ id: string }>("insert into public.deal_loss_reasons (organization_id, name, position) values ($1, 'זמני', 9) returning id", [org])).rows[0].id;
      expect((await q("update public.deal_loss_reasons set name = 'זמני 2' where id = $1", [id])).rowCount).toBe(1);
      expect((await q("delete from public.deal_loss_reasons where id = $1", [id])).rowCount).toBe(1);
    });
  });

  it("names are unique ignoring case and checked; at most 50 per organization", async () => {
    await asUser(owner.id, (q) => q("insert into public.deal_loss_reasons (organization_id, name) values ($1, 'Budget')", [org]));
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.deal_loss_reasons (organization_id, name) values ($1, 'budget')", [org])))).code).toBe("23505");
    for (const name of ["", " רווח", "x".repeat(81)]) {
      expect((await pgError(asUser(owner.id, (q) => q("insert into public.deal_loss_reasons (organization_id, name) values ($1, $2)", [org, name])))).code, name).toBe("23514");
    }
    await asUser(owner.id, (q) => q("delete from public.deal_loss_reasons where organization_id = $1 and name = 'Budget'", [org]));

    const other = await createOrg(owner.id, "עסק עם הרבה סיבות");
    await asUser(owner.id, (q) =>
      q("insert into public.deal_loss_reasons (organization_id, name) select $1, 'סיבה ' || g from generate_series(1, $2::int) g", [other, 50 - DEFAULT_LOSS_REASONS.length]),
    );
    const error = await pgError(asUser(owner.id, (q) => q("insert into public.deal_loss_reasons (organization_id, name) values ($1, 'עוד אחת')", [other])));
    expect(error.code).toBe("P0001");
    expect(error.hint).toBe("reasons:max");
  });

  it("a move to a lost stage may carry a reason and a competitor; the reason's name is kept on the deal", async () => {
    const deal = await newDeal(member.id);
    const price = await reasonId("מחיר");
    await asUser(member.id, (q) =>
      q("update public.deals set stage_id = $1, lost_reason_id = $2, competitor = 'מתחרה בע\"מ' where id = $3", [lostStage, price, deal]),
    );
    expect(await readDeal(deal)).toEqual({ status: "lost", lost_reason: "מחיר", lost_reason_id: price, competitor: 'מתחרה בע"מ' });

    // back to an open stage: no reason any more, the competitor stays
    await asUser(member.id, (q) => q("update public.deals set stage_id = $1 where id = $2", [openStage, deal]));
    expect(await readDeal(deal)).toEqual({ status: "open", lost_reason: null, lost_reason_id: null, competitor: 'מתחרה בע"מ' });

    // a reason on a deal that is not lost is dropped
    await asUser(member.id, (q) => q("update public.deals set lost_reason_id = $1 where id = $2", [price, deal]));
    expect((await readDeal(deal)).lost_reason_id).toBeNull();
    await asUser(member.id, (q) => q("update public.deals set stage_id = $1, lost_reason_id = $2 where id = $3", [wonStage, price, deal]));
    expect(await readDeal(deal)).toMatchObject({ status: "won", lost_reason: null, lost_reason_id: null });

    // a move without a reason is allowed: the reason is optional
    await asUser(member.id, (q) => q("update public.deals set stage_id = $1 where id = $2", [lostStage, deal]));
    expect(await readDeal(deal)).toMatchObject({ status: "lost", lost_reason: null, lost_reason_id: null });
  });

  it("a person picks only an active reason of the organization", async () => {
    const deal = await newDeal(owner.id);
    await asUser(owner.id, (q) => q("update public.deals set stage_id = $1 where id = $2", [lostStage, deal]));
    const hidden = await reasonId("אחר");
    await asUser(owner.id, (q) => q("update public.deal_loss_reasons set is_active = false where id = $1", [hidden]));
    const error = await pgError(asUser(owner.id, (q) => q("update public.deals set lost_reason_id = $1 where id = $2", [hidden, deal])));
    expect(error.code).toBe("P0001");
    expect(error.hint).toBe("deal:lost_reason");
    await asUser(owner.id, (q) => q("update public.deal_loss_reasons set is_active = true where id = $1", [hidden]));

    // another organization's reason: not in the list for a person, and the composite foreign key refuses it for anyone
    const other = await createOrg(admin.id, "עסק אחר");
    const foreign = (await reasonsOf(other))[0].id;
    expect((await pgError(asUser(owner.id, (q) => q("update public.deals set lost_reason_id = $1 where id = $2", [foreign, deal])))).hint).toBe("deal:lost_reason");
    expect((await pgError(asAdmin((q) => q("update public.deals set lost_reason_id = $1 where id = $2", [foreign, deal])))).code).toBe("23503");

    // the competitor is checked
    for (const competitor of ["", " רווח", "x".repeat(121)]) {
      expect((await pgError(asUser(owner.id, (q) => q("update public.deals set competitor = $1 where id = $2", [competitor, deal])))).code, competitor).toBe("23514");
    }
  });

  it("clearing the reason clears its name; a deleted reason leaves its name on the deal; old free text stays", async () => {
    const deal = await newDeal(owner.id);
    const time = await reasonId("לא בזמן הנכון");
    await asUser(owner.id, (q) => q("update public.deals set stage_id = $1, lost_reason_id = $2 where id = $3", [lostStage, time, deal]));
    await asUser(owner.id, (q) => q("update public.deals set lost_reason_id = null where id = $1", [deal]));
    expect(await readDeal(deal)).toMatchObject({ lost_reason: null, lost_reason_id: null });

    const doomed = await asUser(admin.id, async (q) =>
      (await q<{ id: string }>("insert into public.deal_loss_reasons (organization_id, name) values ($1, 'סיבה שתימחק') returning id", [org])).rows[0].id,
    );
    await asUser(owner.id, (q) => q("update public.deals set lost_reason_id = $1 where id = $2", [doomed, deal]));
    await asUser(admin.id, (q) => q("delete from public.deal_loss_reasons where id = $1", [doomed]));
    expect(await readDeal(deal)).toMatchObject({ status: "lost", lost_reason: "סיבה שתימחק", lost_reason_id: null });

    // a deal lost before the list keeps its free text, and other changes leave it alone
    const old = await newDeal(owner.id, "עסקה ישנה");
    await asUser(owner.id, (q) => q("update public.deals set stage_id = $1, lost_reason = 'הלקוח עבר דירה' where id = $2", [lostStage, old]));
    await asUser(owner.id, (q) => q("update public.deals set competitor = 'אחרים' where id = $1", [old]));
    expect(await readDeal(old)).toMatchObject({ lost_reason: "הלקוח עבר דירה", lost_reason_id: null, competitor: "אחרים" });
  });

  it("the loss report groups by the reason's current name, falls back to the stored text, and counts competitors", async () => {
    const reporter = await createUser("loss-reporter");
    const rep = await createOrg(reporter.id, "עסק לדוח");
    const pipeline = await defaultPipeline(rep);
    const lost = pipeline.stages.find((s) => s.kind === "lost")!.id;
    const open = pipeline.stages.find((s) => s.kind === "open")!.id;
    const reasons = await reasonsOf(rep);
    const price = reasons.find((r) => r.name === "מחיר")!.id;
    await asUser(reporter.id, async (q) => {
      const make = async (name: string) =>
        (
          await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id, amount_agorot) values ($1, $2, $3, $4, 1000) returning id", [
            rep,
            name,
            pipeline.pipelineId,
            open,
          ])
        ).rows[0].id;
      const a = await make("א");
      const b = await make("ב");
      const c = await make("ג");
      await q("update public.deals set stage_id = $1, lost_reason_id = $2, competitor = 'מתחרה א' where id = $3", [lost, price, a]);
      await q("update public.deals set stage_id = $1, lost_reason_id = $2, competitor = 'מתחרה א' where id = $3", [lost, price, b]);
      await q("update public.deals set stage_id = $1, lost_reason = 'טקסט ישן' where id = $2", [lost, c]);
      // renamed after the deals were lost: the report shows the current name
      await q("update public.deal_loss_reasons set name = 'יקר מדי' where id = $1", [price]);
    });
    const data = await asUser(reporter.id, async (q) =>
      (
        await q<{ r: { by_reason: { reason: string | null; deals: number }[]; by_competitor: { competitor: string; deals: number; amount: number }[] } }>(
          "select public.report_lost_reasons($1, now() - interval '1 day', now() + interval '1 day') as r",
          [rep],
        )
      ).rows[0].r,
    );
    expect(data.by_reason).toEqual([
      { reason: "יקר מדי", deals: 2, amount: 2000 },
      { reason: "טקסט ישן", deals: 1, amount: 1000 },
    ]);
    expect(data.by_competitor).toEqual([{ competitor: "מתחרה א", deals: 2, amount: 2000 }]);
  });
  it("a won deal keeps its old free text on an unrelated edit; moving out of lost clears it", async () => {
    const deal = await newDeal(owner.id, "עסקה שנסגרה");
    await asUser(owner.id, (q) => q("update public.deals set stage_id = $1 where id = $2", [wonStage, deal]));
    await asUser(owner.id, (q) => q("update public.deals set lost_reason = 'טקסט ישן' where id = $1", [deal]));
    await asUser(owner.id, (q) => q("update public.deals set name = 'שם חדש' where id = $1", [deal]));
    expect(await readDeal(deal)).toMatchObject({ status: "won", lost_reason: "טקסט ישן", lost_reason_id: null });

    const lost = await newDeal(owner.id, "עסקה שאבדה");
    await asUser(owner.id, (q) => q("update public.deals set stage_id = $1, lost_reason = 'יקר' where id = $2", [lostStage, lost]));
    await asUser(owner.id, (q) => q("update public.deals set stage_id = $1 where id = $2", [wonStage, lost]));
    expect(await readDeal(lost)).toMatchObject({ status: "won", lost_reason: null, lost_reason_id: null });
  });

  describe("sample data (USR-04) created before these columns", () => {
    const sampleDeal = async (label: string) => {
      const o = await createUser(label);
      const id = await createOrg(o.id, `עסק ${label}`);
      await asUser(o.id, (q) => q("select public.sample_data_add($1)", [id]));
      const deal = await asAdmin(
        async (q) => (await q<{ deal_id: string }>("select deal_id from app.sample_records where organization_id = $1 and deal_id is not null", [id])).rows[0].deal_id,
      );
      // as if the sample had been created before the migration: its snapshot lacks the new columns
      await asAdmin((q) =>
        q("update app.sample_records set snapshot = snapshot - array['lost_reason_id', 'competitor'] where organization_id = $1 and deal_id = $2", [id, deal]),
      );
      const snapshot = await asAdmin(
        async (q) => (await q<{ s: Record<string, unknown> }>("select snapshot as s from app.sample_records where deal_id = $1", [deal])).rows[0].s,
      );
      expect(snapshot).not.toHaveProperty("competitor");
      return { o, id, deal };
    };
    const removable = (userId: string, orgId: string, deal: string) =>
      asUser(userId, async (q) =>
        (await q<{ removable: boolean }>("select removable from public.sample_data_records($1) where record_id = $2", [orgId, deal])).rows[0].removable,
      );
    const dealCount = (deal: string) => asAdmin((q) => count(q, "select 1 from public.deals where id = $1", [deal]));

    it("an untouched sample deal is still removable and is removed", async () => {
      const { o, id, deal } = await sampleDeal("loss-sample1");
      expect(await removable(o.id, id, deal)).toBe(true);
      await asUser(o.id, (q) => q("select public.sample_data_remove($1)", [id]));
      expect(await dealCount(deal)).toBe(0);
      expect(await asAdmin((q) => count(q, "select 1 from app.sample_records where organization_id = $1", [id]))).toBe(0);
    });

    it("a sample deal whose new column a person filled is kept", async () => {
      const { o, id, deal } = await sampleDeal("loss-sample3");
      await asUser(o.id, (q) => q("update public.deals set competitor = 'Acme' where id = $1", [deal]));
      expect(await removable(o.id, id, deal)).toBe(false);
      await asUser(o.id, (q) => q("select public.sample_data_remove($1)", [id]));
      expect(await dealCount(deal)).toBe(1);
    });

    it("a sample deal whose existing value changed is kept", async () => {
      const { o, id, deal } = await sampleDeal("loss-sample2");
      await asUser(o.id, (q) => q("update public.deals set name = 'עסקה אמיתית' where id = $1", [deal]));
      expect(await removable(o.id, id, deal)).toBe(false);
      await asUser(o.id, (q) => q("select public.sample_data_remove($1)", [id]));
      expect(await dealCount(deal)).toBe(1);
    });
  });
});
