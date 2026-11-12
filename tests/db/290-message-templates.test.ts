import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { unknownMergeFields } from "@/features/message-templates/fields";
import { DEFAULT_MESSAGE_TEMPLATES } from "@/features/message-templates/templates";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

const INSERT =
  "insert into public.message_templates (organization_id, name, channel, message_type, subject, body) values ($1, $2, $3, $4, $5, $6) returning id";

/** MSG-02: shared message templates (owner (68) א, (73) א). */
describe("message templates (MSG-02)", () => {
  let owner: { id: string };
  let admin: { id: string };
  let member: { id: string };
  let org: string;
  let n = 0;
  const add = (
    userId: string,
    row: {
      channel?: string;
      type?: string;
      subject?: string | null;
      body?: string;
      orgId?: string;
    },
  ) =>
    asUser(
      userId,
      async (q) =>
        (
          await q<{ id: string }>(INSERT, [
            row.orgId ?? org,
            `תבנית ${(n += 1)}`,
            row.channel ?? "sms",
            row.type ?? "marketing",
            row.subject ?? null,
            row.body ?? "שלום {שם פרטי}",
          ])
        ).rows[0].id,
    );

  beforeAll(async () => {
    owner = await createUser("msgtpl-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "msgtpl-admin");
    member = await addMember(org, owner.id, "member", "msgtpl-member");
  });

  it("a new business starts with the defaults, which equal DEFAULT_MESSAGE_TEMPLATES", async () => {
    const rows = await asUser(
      member.id,
      async (q) =>
        (
          await q<{
            name: string;
            channel: string;
            message_type: string;
            subject: string | null;
            body: string;
            locale: string;
            is_active: boolean;
          }>(
            // PKG-03's two punch card notices (notice_kind) are seeded beside these; test 298 covers them
            "select name, channel, message_type, subject, body, locale, is_active from public.message_templates where organization_id = $1 and notice_kind is null order by created_at, name",
            [org],
          )
        ).rows,
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(rows).toHaveLength(DEFAULT_MESSAGE_TEMPLATES.length);
    for (const d of DEFAULT_MESSAGE_TEMPLATES) {
      const row = byName.get(d.name);
      expect(row, d.name).toBeDefined();
      expect(row).toMatchObject({
        channel: d.channel,
        message_type: d.messageType,
        subject: d.subject,
        body: d.body,
        locale: "he",
        is_active: true,
      });
    }
  });

  it("the seed adds the defaults only to an empty list", async () => {
    const other = await createOrg(owner.id, "עסק שני");
    await asAdmin((q) => q("select app.seed_message_templates($1)", [other]));
    // PKG-03's two punch card notices are seeded beside them (their own seed, test 298)
    expect(await asAdmin((q) => count(q, "select 1 from public.message_templates where organization_id = $1 and notice_kind is null", [other]))).toBe(
      DEFAULT_MESSAGE_TEMPLATES.length,
    );
    await asUser(owner.id, (q) => q("delete from public.message_templates where organization_id = $1", [other]));
    await asAdmin((q) => q("select app.seed_message_templates($1)", [other]));
    expect(await asAdmin((q) => count(q, "select 1 from public.message_templates where organization_id = $1", [other]))).toBe(
      DEFAULT_MESSAGE_TEMPLATES.length,
    );
  });

  it("the SQL merge-field rule answers like the TS one", async () => {
    const texts = [
      "שלום {שם פרטי}",
      "{שם העסק} {קישור להצעה} {מועד תשלום}",
      "{שם}",
      "{ שם פרטי }",
      "{abc}",
      "{זכר: אתה | נקבה: את | ניטרלי: {שם פרטי}}",
      "{זכר: {שם x} | נקבה: את | ניטרלי: הם}",
      "{{שם פרטי}}",
      "{}",
      "{" + "א".repeat(31) + "}",
      "a {b|c} d",
      "{שורה\nשנייה}",
      "בלי שדות",
    ];
    for (const text of texts) {
      const sql = await asAdmin(async (q) => (await q<{ f: string | null }>("select app.message_unknown_field($1) as f", [text])).rows[0].f);
      const ts = unknownMergeFields(text);
      expect(sql === null ? null : `{${sql}}`, text).toBe(ts[0] ?? null);
    }
  });

  it("refuses an unknown field and a broken gender block, in the body and in the subject", async () => {
    expect((await pgError(add(owner.id, { body: "שלום {שם פרטי} {כתובת}" }))).hint).toBe("message_template:field");
    expect(
      (
        await pgError(
          add(owner.id, {
            channel: "email",
            subject: "מ{שם החברה}",
            body: "שלום",
          }),
        )
      ).hint,
    ).toBe("message_template:field");
    expect((await pgError(add(owner.id, { body: "{זכר: אתה | נקבה: את}" }))).hint).toBe("message_template:neutral");
    expect(
      (
        await pgError(
          add(owner.id, {
            channel: "email",
            subject: "{זכר: א | ניטרלי: ב",
            body: "x",
          }),
        )
      ).hint,
    ).toBe("message_template:variant");
    const id = await add(owner.id, {
      body: "{זכר: אתה מוזמן | נקבה: את מוזמנת | ניטרלי: הוזמנת} {שם פרטי}",
    });
    // a server write is judged too
    expect((await pgError(asAdmin((q) => q("update public.message_templates set body = '{x}' where id = $1", [id])))).hint).toBe(
      "message_template:field",
    );
    // another column alone leaves the stored texts unjudged
    await asUser(owner.id, (q) => q("update public.message_templates set is_active = false where id = $1", [id]));
  });

  it("checks the closed lists and the subject shape", async () => {
    expect((await pgError(add(owner.id, { type: "promo" }))).code).toBe("23514");
    expect((await pgError(add(owner.id, { channel: "fax" }))).code).toBe("23514");
    // an email needs a subject; an SMS or WhatsApp message has none
    expect((await pgError(add(owner.id, { channel: "email" }))).code).toBe("23514");
    expect((await pgError(add(owner.id, { channel: "whatsapp", subject: "נושא" }))).code).toBe("23514");
    expect(
      (
        await pgError(
          asUser(owner.id, (q) =>
            q(
              "insert into public.message_templates (organization_id, name, channel, message_type, body, locale) values ($1, 'he-x', 'sms', 'collection', 'x', 'de')",
              [org],
            ),
          ),
        )
      ).code,
    ).toBe("23514");
    expect((await pgError(add(owner.id, { body: "x".repeat(2001) }))).code).toBe("23514");
    await add(owner.id, { body: "x".repeat(2000), type: "verification_code" });
    // every type of app.message_types() is accepted, but RET-02's review_request: only the system's own (marked) template
    const types = await asAdmin(async (q) => (await q<{ t: string[] }>("select app.message_types() as t")).rows[0].t);
    for (const type of types.filter((t) => t !== "review_request")) await add(admin.id, { type, channel: "whatsapp" });
    expect((await pgError(add(admin.id, { type: "review_request", channel: "sms" }))).code).toBe("23514");
  });

  it("names are unique per business, ignoring case", async () => {
    await asUser(owner.id, (q) => q(INSERT, [org, "Promo", "sms", "marketing", null, "x"]));
    expect((await pgError(asUser(owner.id, (q) => q(INSERT, [org, "promo", "email", "marketing", "s", "x"])))).code).toBe("23505");
  });

  it("owners and admins of a writable business write; a member reads only; the change is audited", async () => {
    const id = await add(admin.id, {});
    expect((await pgError(add(member.id, {}))).code).toBe("42501");
    expect(await asUser(member.id, async (q) => (await q("update public.message_templates set body = 'x' where id = $1", [id])).rowCount)).toBe(0);
    expect(await asUser(member.id, async (q) => (await q("delete from public.message_templates where id = $1", [id])).rowCount)).toBe(0);
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.message_templates where id = $1", [id]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'message_templates' and entity_id = $1", [id]))).toBe(1);

    const ro = await createOrg(owner.id, "עסק לקריאה");
    const roId = await add(owner.id, { orgId: ro });
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [ro]));
    expect((await pgError(add(owner.id, { orgId: ro }))).code).toBe("42501");
    expect(await asUser(owner.id, async (q) => (await q("update public.message_templates set body = 'y' where id = $1", [roId])).rowCount)).toBe(0);
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.message_templates where organization_id = $1", [ro]))).toBeGreaterThan(0);
  });

  it("at most 50 per business", async () => {
    const capped = await createOrg(owner.id, "עסק מלא");
    const have = await asAdmin((q) => count(q, "select 1 from public.message_templates where organization_id = $1", [capped]));
    for (let i = have; i < 50; i += 1) await add(owner.id, { orgId: capped });
    expect((await pgError(add(owner.id, { orgId: capped }))).hint).toBe("message_templates:max");
  });

  it("name and subject refuse control characters; the body keeps its line breaks (review finding 3)", async () => {
    expect((await pgError(add(owner.id, { channel: "email", subject: "a\r\nBcc: x@y", body: "x" }))).code).toBe("23514");
    expect((await pgError(add(owner.id, { channel: "email", subject: "a\tb", body: "x" }))).code).toBe("23514");
    expect((await pgError(asUser(owner.id, (q) => q(INSERT, [org, "שם\nשני", "sms", "marketing", null, "x"])))).code).toBe("23514");
    await add(owner.id, { body: "שורה\nשורה" });
  });

  it("the type check allows exactly app.message_types() (review finding 5)", async () => {
    const { allowed, types } = await asAdmin(async (q) => {
      const def = (
        await q<{ d: string }>(
          "select pg_get_constraintdef(c.oid) as d from pg_constraint c where c.conrelid = 'public.message_templates'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%message_type%'",
        )
      ).rows[0].d;
      const t = (await q<{ t: string[] }>("select app.message_types() as t")).rows[0].t;
      return { allowed: [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]), types: t };
    });
    expect([...allowed].sort()).toEqual([...types].sort());
    expect(allowed.length).toBe(new Set(allowed).size);
  });

  it("the backfill seeds live businesses with an empty list only, never a deleted one (review finding 4)", async () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/20261006021158_message_templates.sql"), "utf8");
    const start = sql.indexOf("do $$", sql.indexOf("-- existing businesses whose list is empty"));
    const block = sql.slice(start, sql.indexOf("$$;", sql.indexOf("end loop;", start)) + 3);
    expect(block).toContain("o.deleted_at is null");
    // a fresh owner: a user may own at most 5 businesses
    const other = await createUser("msgtpl-backfill");
    const live = await createOrg(other.id, "עסק חי");
    const gone = await createOrg(other.id, "עסק שנמחק");
    const kept = await createOrg(other.id, "עסק עם תבנית");
    for (const id of [live, gone]) await asUser(other.id, (q) => q("delete from public.message_templates where organization_id = $1", [id]));
    await asUser(other.id, (q) => q("delete from public.message_templates where organization_id = $1 and name <> 'הצעת מחיר'", [kept]));
    await asAdmin((q) => q("update public.organizations set deleted_at = now() where id = $1", [gone]));
    await asAdmin((q) => q(block));
    const countOf = (id: string) => asAdmin((q) => count(q, "select 1 from public.message_templates where organization_id = $1", [id]));
    expect(await countOf(live)).toBe(DEFAULT_MESSAGE_TEMPLATES.length);
    expect(await countOf(gone)).toBe(0);
    expect(await countOf(kept)).toBe(1);
  });
});
