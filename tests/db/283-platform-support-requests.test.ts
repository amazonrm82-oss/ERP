import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asMfaUser, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

// ADM-05: support requests on the platform panel. The platform owner and support (aal2) read them and change the
// status or add an internal note (logged); finance, read-only staff and members cannot. The requester gets one
// 'system' notice per status change that names nothing; nobody else does. Notes never reach the business.

const staffIds: string[] = [];
const makeStaff = (userId: string, role: string) => {
  staffIds.push(userId);
  return asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, $2) on conflict (user_id) do update set role = excluded.role", [userId, role]));
};

afterAll(async () => {
  await asAdmin((q) => q("delete from app.platform_staff where user_id = any($1)", [staffIds]));
  await closePool();
});

type ListAnswer = {
  total: number;
  counts: { open: number; in_progress: number; closed: number };
  rows: { id: string; organization_id: string; organization_name: string; requester_name: string | null; subject: string; status: string; notes: { body: string }[] }[];
};
const list = (userId: string, status: string | null = null) =>
  asMfaUser(userId, async (q) => (await q<{ l: ListAnswer }>("select public.platform_list_support_requests($1, 200, 0) as l", [status])).rows[0].l);

describe("ADM-05: support requests on the platform panel", () => {
  let support: { id: string };
  let finance: { id: string };
  let readonly: { id: string };
  let alice: { id: string };
  let carol: { id: string };
  let orgA: string;
  let requestId: string;

  beforeAll(async () => {
    support = await createUser("adm05-support");
    finance = await createUser("adm05-finance");
    readonly = await createUser("adm05-readonly");
    await makeStaff(support.id, "support");
    await makeStaff(finance.id, "finance");
    await makeStaff(readonly.id, "readonly");
    alice = await createUser("adm05-alice");
    orgA = await createOrg(alice.id, "עסק התמיכה");
    carol = await addMember(orgA, alice.id, "member", "adm05-carol");
    requestId = await asUser(carol.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.support_requests (organization_id, category, subject, message, page_path) values ($1, 'bug', 'adm05 לא נשמר', 'הטופס לא נשמר', '/o/x/leads') returning id",
          [orgA],
        )
      ).rows[0].id,
    );
  });

  it("support reads requests with the business and the requester; finance, read-only, members and no aal2 cannot", async () => {
    const answer = await list(support.id);
    const row = answer.rows.find((r) => r.id === requestId)!;
    expect(row.organization_id).toBe(orgA);
    expect(row.organization_name).toBe("עסק התמיכה");
    expect(row.subject).toBe("adm05 לא נשמר");
    expect(answer.counts.open).toBeGreaterThanOrEqual(1);
    expect((await list(support.id, "closed")).rows.some((r) => r.id === requestId)).toBe(false);
    for (const u of [finance, readonly, alice]) {
      expect((await pgError(asMfaUser(u.id, (q) => q("select public.platform_list_support_requests()")))).code, u.id).toBe("42501");
    }
    expect((await pgError(asUser(support.id, (q) => q("select public.platform_list_support_requests()")))).code).toBe("42501");
    expect((await pgError(asMfaUser(support.id, (q) => q("select public.platform_list_support_requests('nonsense')")))).code).toBe("22023");
  });

  it("a status change is logged and tells only the requester, naming nothing", async () => {
    expect((await pgError(asMfaUser(finance.id, (q) => q("select public.platform_set_support_request_status($1, 'closed')", [requestId])))).code).toBe("42501");
    await asMfaUser(support.id, (q) => q("select public.platform_set_support_request_status($1, 'in_progress')", [requestId]));
    // the same state again changes nothing
    await asMfaUser(support.id, (q) => q("select public.platform_set_support_request_status($1, 'in_progress')", [requestId]));
    const notices = await asAdmin((q) =>
      q<{ user_id: string; type: string; title: string; body: string; entity_type: string }>(
        "select user_id, type, title, body, entity_type from public.notifications where entity_id = $1",
        [requestId],
      ),
    );
    expect(notices.rows).toEqual([{ user_id: carol.id, type: "system", title: "עדכון בפנייה שלכם לתמיכה", body: "הפנייה בטיפול", entity_type: "support_request" }]);
    expect(await asAdmin((q) => count(q, "select 1 from app.platform_log where action = 'support_request.status' and details->>'id' = $1", [requestId]))).toBe(1);
    const seen = await asUser(carol.id, async (q) => (await q<{ status: string }>("select status from public.support_requests where id = $1", [requestId])).rows[0].status);
    expect(seen).toBe("in_progress");
    expect((await pgError(asMfaUser(support.id, (q) => q("select public.platform_set_support_request_status($1, 'done')", [requestId])))).code).toBe("22023");
    expect((await pgError(asMfaUser(support.id, (q) => q("select public.platform_set_support_request_status($1, 'closed')", [crypto.randomUUID()])))).code).toBe("P0002");
  });

  it("a requester who left gets no notice", async () => {
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [orgA, carol.id]));
    await asMfaUser(support.id, (q) => q("select public.platform_set_support_request_status($1, 'closed')", [requestId]));
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1", [requestId]))).toBe(1);
    await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [orgA, carol.id]));
  });

  it("internal notes: staff only, logged by length, never readable by the business", async () => {
    expect((await pgError(asMfaUser(readonly.id, (q) => q("select public.platform_add_support_request_note($1, 'x')", [requestId])))).code).toBe("42501");
    expect((await pgError(asMfaUser(support.id, (q) => q("select public.platform_add_support_request_note($1, '   ')", [requestId])))).code).toBe("22023");
    const noteId = await asMfaUser(support.id, async (q) => (await q<{ id: string }>("select public.platform_add_support_request_note($1, ' בדקנו, תקלה בדפדפן ') as id", [requestId])).rows[0].id);
    expect((await list(support.id)).rows.find((r) => r.id === requestId)!.notes.map((n) => n.body)).toEqual(["בדקנו, תקלה בדפדפן"]);
    const log = await asAdmin(async (q) => (await q<{ details: Record<string, unknown> }>("select details from app.platform_log where action = 'support_request.note' and details->>'note_id' = $1", [noteId])).rows[0].details);
    expect(log.length).toBe(18);
    expect(JSON.stringify(log)).not.toContain("בדקנו");
    for (const u of [alice, carol]) {
      expect((await pgError(asUser(u.id, (q) => q("select * from app.support_request_notes")))).code).toBe("42501");
    }
  });
});
