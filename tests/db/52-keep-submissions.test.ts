import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrationFile, rerunClosure, staleRestores } from "./rerun";
import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const submit = (token: string, payload: Record<string, unknown>, ipHash: string) =>
  asService(async (q) => {
    const res = await q<{ result: { status: string; lead_id?: string } }>(
      "select public.intake_submit($1, 'form', $2, $3) as result",
      [token, JSON.stringify(payload), ipHash],
    );
    return res.rows[0].result;
  });

const newForm = (userId: string, org: string, name: string) =>
  asUser(userId, async (q) =>
    (await q<{ id: string; token: string }>("insert into public.forms (organization_id, name) values ($1, $2) returning id, token", [org, name])).rows[0],
  );

describe("the inquiry log outlives its form (CAP-04)", () => {
  let owner: U, admin: U, manager: U, member: U, outsider: U;
  let org: string, otherOrg: string;

  beforeAll(async () => {
    owner = await createUser("keep-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "keep-admin");
    manager = await addMember(org, owner.id, "manager", "keep-manager");
    member = await addMember(org, owner.id, "member", "keep-member");
    outsider = await createUser("keep-outsider");
    otherOrg = await createOrg(outsider.id);
  });

  it("deleting a form keeps its submissions, with the form's name and no form id", async () => {
    const form = await newForm(owner.id, org, "טופס קיץ");
    const first = await submit(form.token, { full_name: "מיכל לוי", phone: "050-1112233" }, "ip-a");
    const second = await submit(form.token, { full_name: "דן כהן", phone: "052-4445566", email: "dan@example.test" }, "ip-b");
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");

    // a live form's submissions are not touched before it is deleted
    expect(await asAdmin((q) => count(q, "select 1 from public.form_submissions where form_id = $1 and form_name is null", [form.id]))).toBe(2);

    const deleted = await asUser(owner.id, (q) => q("delete from public.forms where id = $1 returning id", [form.id]));
    expect(deleted.rowCount).toBe(1);

    const rows = await asAdmin(async (q) =>
      (
        await q<{ form_id: string | null; form_name: string | null; lead_id: string | null; payload: Record<string, string> }>(
          "select form_id, form_name, lead_id, payload from public.form_submissions where lead_id = any ($1) order by created_at",
          [[first.lead_id, second.lead_id]],
        )
      ).rows,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.form_id).toBeNull();
      expect(row.form_name).toBe("טופס קיץ");
      expect(row.lead_id).not.toBeNull();
    }
    expect(rows[0].payload.full_name).toBe("מיכל לוי");
  });

  it("a later form with the same organization does not adopt the kept rows, and a name given later is not overwritten", async () => {
    const form = await newForm(owner.id, org, "שם ראשון");
    await submit(form.token, { full_name: "נוי", phone: "053-0000001" }, "ip-c");
    await asUser(owner.id, (q) => q("update public.forms set name = 'שם אחרון' where id = $1", [form.id]));
    await asUser(owner.id, (q) => q("delete from public.forms where id = $1", [form.id]));
    expect(await asAdmin((q) => count(q, "select 1 from public.form_submissions where organization_id = $1 and form_name = 'שם אחרון'", [org]))).toBe(1);
    // deleting another form does not rename rows already kept
    const other = await newForm(owner.id, org, "טופס אחר");
    await asUser(owner.id, (q) => q("delete from public.forms where id = $1", [other.id]));
    expect(await asAdmin((q) => count(q, "select 1 from public.form_submissions where organization_id = $1 and form_name = 'טופס אחר'", [org]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.form_submissions where organization_id = $1 and form_name = 'שם אחרון'", [org]))).toBe(1);
  });

  it("kept submissions are read only by the organization's owner and admins, as before", async () => {
    const kept = await asAdmin((q) => count(q, "select 1 from public.form_submissions where organization_id = $1 and form_id is null", [org]));
    expect(kept).toBeGreaterThanOrEqual(3);
    for (const user of [owner, admin]) {
      expect(await asUser(user.id, (q) => count(q, "select 1 from public.form_submissions where organization_id = $1 and form_id is null", [org]))).toBe(kept);
    }
    for (const user of [manager, member]) {
      expect(await asUser(user.id, (q) => count(q, "select 1 from public.form_submissions where organization_id = $1", [org]))).toBe(0);
    }
  });

  it("another organization sees none of them and cannot change or delete them", async () => {
    await asUser(outsider.id, async (q) => {
      expect(await count(q, "select 1 from public.form_submissions where organization_id = $1", [org])).toBe(0);
      expect(await count(q, "select 1 from public.form_submissions where form_id is null")).toBe(0);
    });
    // clients have no write rights on the log at all, even the owner
    for (const sql of [
      "update public.form_submissions set form_name = 'x' where organization_id = $1",
      "delete from public.form_submissions where organization_id = $1",
    ]) {
      const err = await asUser(owner.id, (q) => q(sql, [org])).then(
        () => null,
        (e: { code?: string }) => e.code,
      );
      expect(err).toBe("42501");
    }
    // the other organization's own form is deleted without touching ours
    const theirs = await newForm(outsider.id, otherOrg, "טופס שלהם");
    await submit(theirs.token, { full_name: "זר", phone: "054-9999999" }, "ip-z");
    await asUser(outsider.id, (q) => q("delete from public.forms where id = $1", [theirs.id]));
    expect(await asAdmin((q) => count(q, "select 1 from public.form_submissions where organization_id = $1 and form_name = 'טופס שלהם'", [otherOrg]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.form_submissions where organization_id = $1 and form_name = 'טופס שלהם'", [org]))).toBe(0);
  });

  it("purging the lead and privacy erasure still empty kept submissions", async () => {
    const form = await newForm(owner.id, org, "טופס פרטיות");
    const accepted = await submit(form.token, { full_name: "שירה ברק", phone: "055-1231234", email: "shira@example.test" }, "ip-p");
    // a second inquiry of the same person is logged as a duplicate on the same lead
    await submit(form.token, { full_name: "שירה ברק", phone: "055-1231234", email: "shira@example.test" }, "ip-q");
    await asUser(owner.id, (q) => q("delete from public.forms where id = $1", [form.id]));
    const ids = await asAdmin(async (q) =>
      (await q<{ id: string }>("select id from public.form_submissions where organization_id = $1 and form_name = 'טופס פרטיות'", [org])).rows.map((r) => r.id),
    );
    expect(ids.length).toBeGreaterThanOrEqual(1);

    await asUser(owner.id, async (q) => {
      await q("update public.leads set deleted_at = now() where id = $1", [accepted.lead_id]);
      await q("delete from public.leads where id = $1", [accepted.lead_id]);
      await q("select public.audit_erase_record($1, 'leads', $2)", [org, accepted.lead_id]);
    });
    const after = await asAdmin(async (q) =>
      (await q<{ payload: unknown; user_agent: string | null; form_name: string | null }>("select payload, user_agent, form_name from public.form_submissions where id = any ($1)", [ids])).rows,
    );
    expect(after).toHaveLength(ids.length);
    for (const row of after) {
      expect(row.payload).toEqual({});
      expect(row.user_agent).toBeNull();
      expect(row.form_name).toBe("טופס פרטיות");
    }
  });

  it("deleting the organization removes its kept submissions", async () => {
    const user = await createUser("keep-gone");
    const gone = await createOrg(user.id);
    const form = await newForm(user.id, gone, "טופס");
    await submit(form.token, { full_name: "אחד", phone: "050-7777777" }, "ip-g");
    await asUser(user.id, (q) => q("delete from public.forms where id = $1", [form.id]));
    expect(await asAdmin((q) => count(q, "select 1 from public.form_submissions where organization_id = $1", [gone]))).toBe(1);
    await asAdmin((q) => q("delete from public.organizations where id = $1", [gone]));
    expect(await asAdmin((q) => count(q, "select 1 from public.form_submissions where organization_id = $1", [gone]))).toBe(0);
  });

  it("deleting an organization with a live form and a submission linked to a lead works", async () => {
    const user = await createUser("keep-live");
    const gone = await createOrg(user.id);
    const form = await newForm(user.id, gone, "טופס חי");
    const result = await submit(form.token, { full_name: "שתיים", phone: "050-7777778" }, "ip-l");
    expect(result.status).toBe("accepted");
    expect(result.lead_id).toBeTruthy();
    await asAdmin((q) => q("delete from public.organizations where id = $1", [gone]));
    await asAdmin(async (q) => {
      for (const table of ["form_submissions", "forms", "leads"]) {
        expect(await count(q, `select 1 from public.${table} where organization_id = $1`, [gone]), table).toBe(0);
      }
    });
  });

  it("the migration can run twice", async () => {
    const file = migrationFile("_keep_submissions.sql");
    // re-running it puts back its own body of app.keep_form_submissions(); the later migrations that redefine its
    // functions (the closure) run again after it, so the test leaves every body as a fresh build made it
    const rerun = rerunClosure([file]);
    expect(rerun.files[0]).toBe(file);
    expect(staleRestores(rerun.files)).toEqual([]);
    const sql = rerun.sql[0];
    // no statement starts with drop (the hosted connector stops on those)
    const statements = sql.replace(/--.*$/gm, "").split(";").map((part) => part.trim().toLowerCase());
    expect(statements.filter((part) => part.startsWith("drop"))).toEqual([]);
    expect(sql).not.toMatch(/delete\s+from/i);
    await asAdmin(async (q) => {
      for (const text of rerun.sql) await q(text);
    });
    await asAdmin(async (q) => {
      const fks = await q<{ def: string }>(
        "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.form_submissions'::regclass and contype = 'f' order by conname",
      );
      expect(fks.rows.map((r) => r.def).sort()).toEqual([
        "FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE",
        "FOREIGN KEY (organization_id, form_id) REFERENCES forms(organization_id, id) ON DELETE SET NULL (form_id)",
        "FOREIGN KEY (organization_id, lead_id) REFERENCES leads(organization_id, id) ON DELETE SET NULL (lead_id)",
      ]);
    });
  });
});
