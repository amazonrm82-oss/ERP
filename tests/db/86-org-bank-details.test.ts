import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

const ACCOUNT = "123456789";

/**
 * TAX-02 follow-up (owner, 13 October 2026): bank details are read and written
 * by owners and admins only; everyone else sees them only inside a document,
 * which keeps app.document_bank_snapshot() from when it was made.
 */
describe("bank details of the business", () => {
  let owner: { id: string };
  let admin: { id: string };
  let manager: { id: string };
  let member: { id: string };
  let viewer: { id: string };
  let org: string;

  const notices = () =>
    asAdmin(async (q) =>
      (
        await q<{ user_id: string; type: string; title: string; body: string | null }>(
          "select user_id, type, title, body from public.notifications where organization_id = $1 and title like 'פרטי הבנק%' order by created_at, user_id",
          [org],
        )
      ).rows,
    );

  beforeAll(async () => {
    owner = await createUser("bankowner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "bankadmin");
    manager = await addMember(org, owner.id, "manager", "bankmanager");
    member = await addMember(org, owner.id, "member", "bankmember");
    viewer = await addMember(org, owner.id, "viewer", "bankviewer");
  });

  it("an owner and an admin can write and read the table", async () => {
    await asUser(admin.id, (q) =>
      q(
        "insert into public.org_bank_details (organization_id, bank_name, bank_branch, bank_account, bank_account_name) values ($1, 'בנק לאומי', '800', $2, 'דוגמה בע\"מ')",
        [org, ACCOUNT],
      ),
    );
    for (const u of [owner, admin]) {
      const row = await asUser(u.id, async (q) =>
        (await q<{ bank_account: string }>("select bank_account from public.org_bank_details where organization_id = $1", [org])).rows[0],
      );
      expect(row).toEqual({ bank_account: ACCOUNT });
    }
    expect((await asUser(owner.id, (q) => q("update public.org_bank_details set bank_branch = '801' where organization_id = $1", [org]))).rowCount).toBe(1);
  });

  it("a manager, a member and a viewer can neither read nor write it", async () => {
    for (const u of [manager, member, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.org_bank_details where organization_id = $1", [org])).toBe(0);
        expect(await count(q, "select 1 from public.org_bank_details")).toBe(0);
        expect((await q("update public.org_bank_details set bank_name = 'x' where organization_id = $1", [org])).rowCount).toBe(0);
        expect((await q("delete from public.org_bank_details where organization_id = $1", [org])).rowCount).toBe(0);
      });
      expect(
        (await pgError(asUser(u.id, (q) => q("insert into public.org_bank_details (organization_id, bank_name) values ($1, 'x')", [org])))).code,
      ).toBe("42501");
      // the snapshot function is not theirs to call either
      expect((await pgError(asUser(u.id, (q) => q("select app.document_bank_snapshot($1)", [org])))).code).toBe("42501");
    }
  });

  it("checks: digits only, and an account needs its bank and branch", async () => {
    const set = (assignment: string) => asUser(owner.id, (q) => q(`update public.org_bank_details set ${assignment} where organization_id = $1`, [org]));
    for (const bad of [
      "bank_name = null",
      "bank_branch = null",
      "bank_branch = '12345'",
      "bank_branch = '8a'",
      "bank_account = '12-345'",
      "bank_account = '1'",
      "bank_name = ''",
      "bank_account_name = ' '",
    ]) {
      const err = await pgError(set(bad));
      expect(err.code, bad).toBe("P0001");
      expect(err.hint, bad).toBe("bank:invalid");
      // no value in the error, so the account number cannot reach a log
      expect(`${err.message} ${JSON.stringify(err)}`, bad).not.toMatch(/\d{5,}/);
    }
    // a missing organization is refused by the trigger too, before NOT NULL could print the row
    const noOrg = await pgError(asAdmin((q) => q("insert into public.org_bank_details (bank_name, bank_branch, bank_account) values ('x', '1', '123456789')")));
    expect([noOrg.code, noOrg.hint]).toEqual(["P0001", "bank:invalid"]);
    expect(JSON.stringify(noOrg)).not.toContain("123456789");
    const constraints = await asAdmin(async (q) =>
      (await q<{ conname: string }>("select conname from pg_constraint where conrelid = 'public.org_bank_details'::regclass and contype = 'c'")).rows,
    );
    expect(constraints).toEqual([]);
  });

  it("the audit log keeps who and when, with the account masked to its last 4 digits", async () => {
    await asUser(owner.id, (q) => q("update public.org_bank_details set bank_account = '987654321' where organization_id = $1", [org]));
    const entries = await asAdmin(async (q) =>
      (
        await q<{ action: string; actor_id: string; changes: Record<string, { old: unknown; new: unknown }>; text: string }>(
          "select action, actor_id, changes, changes::text as text from public.audit_log where organization_id = $1 and entity_type = 'org_bank_details' order by created_at, id",
          [org],
        )
      ).rows,
    );
    expect(entries.map((e) => [e.action, e.actor_id])).toEqual([
      ["insert", admin.id],
      ["update", owner.id],
      ["update", owner.id],
    ]);
    expect(entries[0].changes.bank_account).toEqual({ old: null, new: "****6789" });
    expect(entries[2].changes.bank_account).toEqual({ old: "****6789", new: "****4321" });
    for (const e of entries) {
      expect(e.text).not.toContain(ACCOUNT);
      expect(e.text).not.toContain("987654321");
      expect(e.text).not.toMatch(/\d{5,}/);
    }
  });

  it("every change tells every active owner and admin, the actor included, with no number", async () => {
    const rows = await notices();
    // insert by the admin, branch change and account change by the owner: 3 changes x 2 people
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([owner.id, admin.id]));
    expect(rows.every((r) => r.type === "system")).toBe(true);
    expect(rows.filter((r) => r.title === "פרטי הבנק של העסק שונו על ידי bankadmin")).toHaveLength(2);
    // never the email
    expect(rows.some((r) => r.title.includes("@"))).toBe(false);
    expect(rows.filter((r) => r.title === "פרטי הבנק של העסק שונו על ידי bankowner")).toHaveLength(4);
    for (const r of rows) {
      expect(`${r.title} ${r.body ?? ""}`).not.toMatch(/\d/);
    }
    // a no-op update changes nothing and tells nobody
    await asUser(owner.id, (q) => q("update public.org_bank_details set bank_name = bank_name where organization_id = $1", [org]));
    expect(await notices()).toHaveLength(6);
  });

  it("a member and a viewer see the bank details inside a document they may read", async () => {
    // No quote or document table exists yet (QUO, DOC). This stand-in follows the rule they must follow:
    // its insert trigger (security definer) keeps app.document_bank_snapshot() on the document.
    const as = async (q: Query, userId: string) => {
      await q("reset role");
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
      await q("set local role authenticated");
    };
    let seen: unknown[] = [];
    let direct: number[] = [];
    let after: unknown;
    await asAdmin(async (q) => {
      await q(`create table public.standin_document (
                 id uuid primary key default gen_random_uuid(),
                 organization_id uuid not null references public.organizations (id),
                 title text not null,
                 bank jsonb)`);
      await q("alter table public.standin_document enable row level security");
      await q("grant select, insert (organization_id, title) on public.standin_document to authenticated");
      await q("create policy standin_select on public.standin_document for select to authenticated using (app.is_member(organization_id))");
      await q("create policy standin_insert on public.standin_document for insert to authenticated with check (app.can_write(organization_id))");
      await q(`create function app.standin_document_bank() returns trigger language plpgsql security definer set search_path = '' as $$
               begin new.bank := app.document_bank_snapshot(new.organization_id); return new; end; $$`);
      await q("create trigger standin_document_bank before insert on public.standin_document for each row execute function app.standin_document_bank()");

      // a member issues a document: it works, and the bank details come with it
      await as(q, member.id);
      await q("insert into public.standin_document (organization_id, title) values ($1, 'הצעת מחיר')", [org]);
      seen = [];
      direct = [];
      for (const u of [member, viewer]) {
        await as(q, u.id);
        seen.push((await q<{ bank: unknown }>("select bank from public.standin_document where organization_id = $1", [org])).rows[0].bank);
        direct.push(await count(q, "select 1 from public.org_bank_details where organization_id = $1", [org]));
      }
      // a later change of the bank details does not change the document
      await as(q, owner.id);
      await q("update public.org_bank_details set bank_branch = '900' where organization_id = $1", [org]);
      await as(q, viewer.id);
      after = (await q<{ bank: unknown }>("select bank from public.standin_document where organization_id = $1", [org])).rows[0].bank;
      throw new Error("rollback");
    }).catch((error: Error) => {
      if (error.message !== "rollback") throw error;
    });
    const expected = { bank_name: "בנק לאומי", bank_branch: "801", bank_account: "987654321", bank_account_name: 'דוגמה בע"מ' };
    expect(seen).toEqual([expected, expected]);
    expect(direct).toEqual([0, 0]);
    expect(after).toEqual(expected);
  });

  it("server code reads the snapshot; no account means no snapshot", async () => {
    expect(await asService(async (q) => (await q<{ s: { bank_branch: string } }>("select app.document_bank_snapshot($1) as s", [org])).rows[0].s.bank_branch)).toBe("801");
    const other = await createOrg(owner.id, "עסק בלי בנק");
    expect(await asService(async (q) => (await q<{ s: unknown }>("select app.document_bank_snapshot($1) as s", [other])).rows[0].s)).toBeNull();
    const grants = await asAdmin(async (q) =>
      (
        await q<{ anon: boolean; authn: boolean; service: boolean }>(
          `select has_function_privilege('anon', 'app.document_bank_snapshot(uuid)', 'execute') as anon,
                  has_function_privilege('authenticated', 'app.document_bank_snapshot(uuid)', 'execute') as authn,
                  has_function_privilege('service_role', 'app.document_bank_snapshot(uuid)', 'execute') as service`,
        )
      ).rows[0],
    );
    expect(grants).toEqual({ anon: false, authn: false, service: true });
  });

  it("a read-only organization: owners still read, nobody changes", async () => {
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    await asUser(owner.id, async (q) => {
      expect(await count(q, "select 1 from public.org_bank_details where organization_id = $1", [org])).toBe(1);
      expect((await q("update public.org_bank_details set bank_branch = '1' where organization_id = $1", [org])).rowCount).toBe(0);
      expect((await q("delete from public.org_bank_details where organization_id = $1", [org])).rowCount).toBe(0);
    });
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
  });

  it("an admin may remove them; the removal is audited masked and announced", async () => {
    await asUser(admin.id, async (q) => {
      expect((await q("delete from public.org_bank_details where organization_id = $1", [org])).rowCount).toBe(1);
    });
    const entry = await asAdmin(async (q) =>
      (
        await q<{ changes: { bank_account: { old: string; new: unknown } } }>(
          "select changes from public.audit_log where organization_id = $1 and entity_type = 'org_bank_details' and action = 'delete'",
          [org],
        )
      ).rows[0],
    );
    expect(entry.changes.bank_account).toEqual({ old: "****4321", new: null });
    expect(await notices()).toHaveLength(8);
  });

  it("the notice links to the documents settings; without a profile name it says משתמש", async () => {
    const links = await asAdmin(async (q) =>
      (await q<{ entity_type: string }>("select distinct entity_type from public.notifications where organization_id = $1 and title like 'פרטי הבנק%'", [org])).rows,
    );
    expect(links).toEqual([{ entity_type: "org_bank_details" }]);
    await asAdmin((q) => q("update public.profiles set full_name = null where id = $1", [admin.id]));
    await asUser(admin.id, (q) =>
      q("insert into public.org_bank_details (organization_id, bank_name, bank_branch, bank_account) values ($1, 'בנק', '1', '1234567')", [org]),
    );
    const titles = await asAdmin(async (q) =>
      (await q<{ title: string }>("select distinct title from public.notifications where organization_id = $1 and created_at = (select max(created_at) from public.notifications where organization_id = $1)", [org])).rows,
    );
    expect(titles).toEqual([{ title: "פרטי הבנק של העסק שונו על ידי משתמש" }]);
  });

  it("masking: last 4 digits, or the last 2 for a number under 8 digits; no client may call it", async () => {
    const masked = await asAdmin(async (q) =>
      (await q<{ a: string; b: string; c: string; d: null }>("select app.mask_bank_account('123456789') as a, app.mask_bank_account('12345678') as b, app.mask_bank_account('1234567') as c, app.mask_bank_account(null) as d")).rows[0],
    );
    expect(masked).toEqual({ a: "****6789", b: "****5678", c: "****67", d: null });
    // the 7-digit account inserted above is audited with 2 digits only
    const entry = await asAdmin(async (q) =>
      (
        await q<{ changes: { bank_account: { new: string } } }>(
          "select changes from public.audit_log where organization_id = $1 and entity_type = 'org_bank_details' and action = 'insert' order by created_at desc limit 1",
          [org],
        )
      ).rows[0],
    );
    expect(entry.changes.bank_account.new).toBe("****67");
    expect((await pgError(asUser(owner.id, (q) => q("select app.mask_bank_account('123456789')")))).code).toBe("42501");
  });
});
