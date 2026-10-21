import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asMfaUser, asUser, closePool, createOrg, createUser, insertLead, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * RVW-46 follow-up: removing a person (PRV-03) renames a kept deal whose name holds the person's name; that deal's notices
 * (follow, mention, an automation's text) then say the new name instead of any name the deal had. Other deals' notices stay.
 */
describe("a deal renamed by a person's removal: its notices say the new name", () => {
  let owner: U, admin: U, member: U;
  let org: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const notices = (deal: string) =>
    asAdmin(
      async (q) =>
        (await q<{ title: string; body: string | null }>("select title, body from public.notifications where entity_type = 'deal' and entity_id = $1 order by title, body", [deal]))
          .rows,
    );
  const notify = (deal: string, title: string, body: string | null = null) =>
    asAdmin((q) =>
      q("insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id) values ($1, $2, 'follow', $3, $4, 'deal', $5)", [
        org,
        member.id,
        title,
        body,
        deal,
      ]),
    );

  beforeAll(async () => {
    owner = await createUser("pdn-owner");
    org = await createOrg(owner.id, "עסק ההתראות על עסקאות");
    admin = await addMember(org, owner.id, "admin", "pdn-admin");
    member = await addMember(org, owner.id, "member", "pdn-member");
  });

  it("every old name of the renamed deal leaves its notices; another deal's notices stay", async () => {
    const lead = await insertLead(member.id, org, { full_name: "גלית ברק" });
    const { deal_id: deal } = await asUser(member.id, async (q) =>
      (await one<{ r: { deal_id: string } }>(q, "select public.convert_lead($1, true, null, 100000) as r", [lead])).r,
    );
    const first = (await asAdmin((q) => one<{ name: string }>(q, "select name from public.deals where id = $1", [deal]))).name;
    await asUser(member.id, (q) => q("update public.deals set name = 'מטבח לגלית ברק' where id = $1", [deal]));
    // notices as the database writes them: a follow title, a mention title, an automation's notify text
    await notify(deal, `עדכון בעסקה שבמעקב: ${first}`, "סטטוס: חדש");
    await notify(deal, "עדכון בעסקה שבמעקב: מטבח לגלית ברק", "שלב: הצעה");
    await notify(deal, "הזכירו אתכם בעסקה: מטבח לגלית ברק");
    await notify(deal, "תזכורת", "העסקה מטבח לגלית ברק לא זזה שבועיים");
    const other = await asUser(member.id, async (q) => {
      const p = await one<{ pipeline_id: string; stage_id: string }>(q, "select pipeline_id, stage_id from public.deals where id = $1", [deal]);
      return (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'מטבח לגלית ברק', $2, $3) returning id", [org, p.pipeline_id, p.stage_id])).id;
    });
    await notify(other, "עדכון בעסקה שבמעקב: מטבח לגלית ברק");

    await asMfaUser(admin.id, (q) =>
      q("select public.privacy_erase_person($1, 'leads', $2, '[]'::jsonb, 'בקשה', $3, true)", [org, lead, JSON.stringify({ [deal]: "עסקה (לקוח נמחק)" })]),
    );

    const after = await notices(deal);
    expect(after).toHaveLength(4);
    for (const n of after) expect(`${n.title} ${n.body ?? ""}`).not.toMatch(/גלית|ברק/);
    expect(after).toEqual([
      { title: "הזכירו אתכם בעסקה: עסקה (לקוח נמחק)", body: null },
      { title: "עדכון בעסקה שבמעקב: עסקה (לקוח נמחק)", body: "סטטוס: חדש" },
      { title: "עדכון בעסקה שבמעקב: עסקה (לקוח נמחק)", body: "שלב: הצעה" },
      { title: "תזכורת", body: "העסקה עסקה (לקוח נמחק) לא זזה שבועיים" },
    ]);
    // the other deal (not renamed) keeps its notice, even though it carries the same text
    expect(await notices(other)).toEqual([{ title: "עדכון בעסקה שבמעקב: מטבח לגלית ברק", body: null }]);
  });
  it("a generic earlier name (\"עסקה\") stays in the deal's notices; only names that held the person's name change", async () => {
    const lead = await insertLead(member.id, org, { full_name: "דורית אלון" });
    const { deal_id: deal } = await asUser(member.id, async (q) =>
      (await one<{ r: { deal_id: string } }>(q, "select public.convert_lead($1, true, null, 100000) as r", [lead])).r,
    );
    await asUser(member.id, (q) => q("update public.deals set name = 'עסקה' where id = $1", [deal]));
    await asUser(member.id, (q) => q("update public.deals set name = 'שיפוץ לדורית אלון' where id = $1", [deal]));
    await notify(deal, "עסקה הוקצתה לכם");
    await notify(deal, "עדכון בעסקה שבמעקב: שיפוץ לדורית אלון");

    await asMfaUser(admin.id, (q) =>
      q("select public.privacy_erase_person($1, 'leads', $2, '[]'::jsonb, 'בקשה', $3, true)", [org, lead, JSON.stringify({ [deal]: "שיפוץ (לקוח נמחק)" })]),
    );

    expect(await notices(deal)).toEqual([
      { title: "עדכון בעסקה שבמעקב: שיפוץ (לקוח נמחק)", body: null },
      { title: "עסקה הוקצתה לכם", body: null },
    ]);
  });
});
