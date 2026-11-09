import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupPrefixes,
  exists,
  filePaths,
  keptQuotePdf,
  orphanPaths,
  personExtras,
  personRows,
  rowsOf,
  seed,
  snapshot,
  storageFor,
  verifiedFactors,
  type Snapshot,
} from "./org-cleanup-fixture";
import { addMember, asAdmin, closePool, createOrg, createUser } from "./helpers";

/**
 * Migration 20261006021193_org_delete_cancelled.sql (owner, 9 November 2026; pasted by hand): the cancelled business
 * a415bb9e-… is removed in full, its people's accounts stay, and no other business changes. The fixture businesses get
 * random ids, so the file runs here with its one hard-coded id replaced by the fixture's id: the same text otherwise. The
 * file as committed is also run unchanged, where it finds no such business and must change nothing.
 */

const SQL = readFileSync(path.join(__dirname, "../../supabase/migrations/20261006021193_org_delete_cancelled.sql"), "utf8");
const GONE_ID = "a415bb9e-a965-4ad1-a7e0-85b22637e76f";
const runFor = (gone: string) => SQL.replaceAll(GONE_ID, gone);

// what the removal leaves behind: platform history and reused slots (no foreign key)
const GONE_KEEPS = new Set(["app.platform_log", "app.automation_rule_runs"]);

afterAll(closePool);

describe("removing the cancelled business (owner, 9 November 2026)", () => {
  let owner1: { id: string; email: string };
  let member1: { id: string; email: string };
  let owner2: { id: string; email: string };
  let owner3: { id: string; email: string };
  let gone: string;
  let bystander: string;
  let other: string;
  let files1: string[];
  let bystanderBefore: Snapshot;
  let otherBefore: Snapshot;
  let goneBefore: Snapshot;
  let people1Before: Snapshot;
  const prefixes: string[] = [];

  afterAll(() => cleanupPrefixes(prefixes));

  beforeAll(async () => {
    owner1 = await createUser("gone-owner");
    owner2 = await createUser("bystander-owner");
    owner3 = await createUser("other-owner");
    gone = await createOrg(owner1.id, "עסק שבוטל");
    bystander = await createOrg(owner2.id, "עסק שכן");
    other = await createOrg(owner3.id, "עסק אחר");
    prefixes.push(`${gone}/%`, `${bystander}/%`, `${other}/%`);
    await seed(owner1, gone, "1");
    await seed(owner2, bystander, "2");
    await seed(owner3, other, "3");
    // the gone business's member also belongs to the bystander, so the person outlives one of their two businesses
    member1 = await addMember(gone, owner1.id, "member", "gone-member");
    await asAdmin((q) => q("insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'member')", [bystander, member1.id]));
    await personExtras([owner1.id, member1.id]);
    for (const org of [gone, bystander, other]) await keptQuotePdf(org);
    await storageFor(owner1, gone);
    await storageFor(owner2, bystander);
    await storageFor(owner3, other);
    await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [gone]));
    await verifiedFactors([owner1.id, member1.id]);

    files1 = await filePaths(gone, "true");
    goneBefore = await snapshot(gone);
    bystanderBefore = await snapshot(bystander);
    otherBefore = await snapshot(other);
    people1Before = await personRows([owner1.id, member1.id]);
  });

  it("the fixture holds data in the tables the removal reaches", () => {
    for (const t of [
      "public.leads", "public.contacts", "public.companies", "public.deals", "public.tasks", "public.meetings", "public.activities",
      "public.files", "public.quotes", "public.orders", "public.accounting_documents", "public.payments", "public.punch_cards",
      "public.messages", "public.consents", "public.notifications", "public.audit_log", "public.outbox_events", "public.memberships",
      "public.subscriptions", "public.number_sequences", "public.payment_allocations", "public.privacy_requests",
    ]) {
      expect(rowsOf(goneBefore, t), t).toBeGreaterThan(0);
    }
    expect(files1.length).toBeGreaterThan(3);
  });

  it("the file as committed finds no such business and changes nothing", async () => {
    await asAdmin((q) => q(SQL));
    expect(await snapshot(gone)).toEqual(goneBefore);
    expect(await snapshot(bystander)).toEqual(bystanderBefore);
    expect(await snapshot(other)).toEqual(otherBefore);
  });

  it("refuses a business that is not cancelled, and does nothing", async () => {
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [gone]));
    try {
      const active = await snapshot(gone);
      await expect(asAdmin((q) => q(runFor(gone)))).rejects.toThrow(/not cancelled; nothing was done/);
      expect(await snapshot(gone)).toEqual(active);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [gone]));
    }
  });

  describe("after the run", () => {
    let goneAfter: Snapshot;
    let bystanderAfter: Snapshot;
    let otherAfter: Snapshot;

    beforeAll(async () => {
      await asAdmin((q) => q(runFor(gone)));
      goneAfter = await snapshot(gone);
      bystanderAfter = await snapshot(bystander);
      otherAfter = await snapshot(other);
    });

    it("the business is gone with everything that hung on it", async () => {
      expect(await exists("select 1 from public.organizations where id = $1", [gone])).toBe(false);
      for (const [t, s] of Object.entries(goneAfter)) {
        if (!GONE_KEEPS.has(t)) expect(s, t).toBe("0:");
      }
    });

    it("its people keep their accounts, profiles and everything outside the business", async () => {
      const after = await personRows([owner1.id, member1.id]);
      for (const t of ["auth.users", "auth.sessions", "auth.mfa_factors", "public.profiles", "app.agreement_signatures", "app.mfa_recovery_codes"]) {
        expect(after[t], t).toBe(people1Before[t]);
        expect(rowsOf(after, t), t).toBeGreaterThan(0);
      }
      // only the membership in the removed business went
      expect(rowsOf(after, "public.memberships")).toBe(1);
      expect(await exists("select 1 from public.memberships where organization_id = $1 and user_id = $2", [bystander, member1.id])).toBe(true);
    });

    it("every other business is unchanged, byte for byte", () => {
      expect(bystanderAfter).toEqual(bystanderBefore);
      expect(otherAfter).toEqual(otherBefore);
    });

    it("its file paths and logo folder wait for the nightly cleanup; nothing of the others is queued", async () => {
      const queued = await orphanPaths(gone);
      for (const p of files1) expect(queued, p).toContain(p);
      expect(queued.some((p) => !files1.includes(p))).toBe(true); // the logo folder
      expect(await orphanPaths(bystander)).toEqual([]);
      expect(await orphanPaths(other)).toEqual([]);
      // the objects themselves are removed by the nightly cleanup, not here
      expect(await exists("select 1 from storage.objects where name like $1", [`${gone}/%`])).toBe(true);
    });

    it("running the file a second time changes nothing", async () => {
      const queued = await orphanPaths(gone);
      await asAdmin((q) => q(runFor(gone)));
      expect(await snapshot(gone)).toEqual(goneAfter);
      expect(await snapshot(bystander)).toEqual(bystanderAfter);
      expect(await snapshot(other)).toEqual(otherAfter);
      expect(await orphanPaths(gone)).toEqual(queued);
    });
  });
});
