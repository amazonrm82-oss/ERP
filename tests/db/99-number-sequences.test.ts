import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError, TEST_DB_URL } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Allocated = { o_number: string; o_display: string };

// QUO-03 / ORD-03: running numbers per organization and kind, handed out by
// app.next_document_number() under a row lock; never twice, never back.
describe("running document numbers (QUO-03)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string;
  let other: string;

  // the server (no session), or a definer function called by a signed-in user (claims only, role stays the owner)
  const allocate = (orgId: string, kind: string, actor?: string) =>
    asAdmin(async (q) => {
      if (actor) await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor, role: "authenticated" })]);
      const row = (await q<Allocated>("select * from app.next_document_number($1, $2)", [orgId, kind])).rows[0];
      return { n: Number(row.o_number), display: row.o_display };
    });
  const series = (orgId: string, kind: string) =>
    asAdmin(async (q) => (await q<{ prefix: string; start_number: string; last_number: string | null }>("select prefix, start_number, last_number from public.number_sequences where organization_id = $1 and kind = $2", [orgId, kind])).rows[0]);

  beforeAll(async () => {
    owner = await createUser("ns-owner");
    org = await createOrg(owner.id, "עסק המספרים");
    admin = await addMember(org, owner.id, "admin", "ns-admin");
    manager = await addMember(org, owner.id, "manager", "ns-manager");
    member = await addMember(org, owner.id, "member", "ns-member");
    viewer = await addMember(org, owner.id, "viewer", "ns-viewer");
    outsider = await createUser("ns-outsider");
    other = await createOrg(outsider.id, "עסק אחר");
  });

  it("starts at 1 with no prefix when the business set nothing, and counts up", async () => {
    expect(await series(org, "quote")).toBeUndefined();
    expect(await allocate(org, "quote")).toEqual({ n: 1, display: "1" });
    expect(await allocate(org, "quote", member.id)).toEqual({ n: 2, display: "2" });
    expect(await series(org, "quote")).toEqual({ prefix: "", start_number: "1", last_number: "2" });
    // another kind and another organization have their own series
    expect(await allocate(other, "quote")).toEqual({ n: 1, display: "1" });
  });

  it("uses the prefix and start an owner or admin set, and locks the start once a number was given", async () => {
    await asUser(admin.id, (q) => q("insert into public.number_sequences (organization_id, kind, prefix, start_number) values ($1, 'order', 'ORD-', 500)", [org]));
    await asUser(owner.id, (q) => q("update public.number_sequences set start_number = 1001, prefix = 'הז-' where organization_id = $1 and kind = 'order'", [org]));
    expect(await allocate(org, "order")).toEqual({ n: 1001, display: "הז-1001" });

    const locked = await pgError(asUser(owner.id, (q) => q("update public.number_sequences set start_number = 1 where organization_id = $1 and kind = 'order'", [org])));
    expect(locked.code).toBe("P0001");
    expect(locked.hint).toBe("number_sequences:start_locked");
    // the server cannot move it either
    expect((await pgError(asAdmin((q) => q("update public.number_sequences set start_number = 5000 where organization_id = $1 and kind = 'order'", [org])))).hint).toBe("number_sequences:start_locked");

    // the prefix may change; the number goes on
    await asUser(owner.id, (q) => q("update public.number_sequences set prefix = 'O/' where organization_id = $1 and kind = 'order'", [org]));
    expect(await allocate(org, "order")).toEqual({ n: 1002, display: "O/1002" });
  });

  it("never hands a number out twice: the last number only goes up, and no client may write it or delete the series", async () => {
    const back = await pgError(asAdmin((q) => q("update public.number_sequences set last_number = 1 where organization_id = $1 and kind = 'order'", [org])));
    expect(back.hint).toBe("number_sequences:last_number");
    expect((await pgError(asAdmin((q) => q("update public.number_sequences set last_number = null where organization_id = $1 and kind = 'order'", [org])))).hint).toBe(
      "number_sequences:last_number",
    );
    expect((await pgError(asAdmin((q) => q("update public.number_sequences set kind = 'quote' where organization_id = $1 and kind = 'order'", [org])))).code).toBe("P0001");

    expect((await pgError(asUser(owner.id, (q) => q("update public.number_sequences set last_number = 1 where organization_id = $1", [org])))).code).toBe("42501");
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.number_sequences (organization_id, kind, last_number) values ($1, 'quote', 9)", [other])))).code,
    ).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("delete from public.number_sequences where organization_id = $1", [org])))).code).toBe("42501");
    // service_role has no DELETE or TRUNCATE either, and even the table owner cannot remove a series
    expect((await pgError(asService((q) => q("delete from public.number_sequences where organization_id = $1", [org])))).code).toBe("42501");
    expect((await pgError(asService((q) => q("truncate public.number_sequences")))).code).toBe("42501");
    const ownerDelete = await pgError(asAdmin((q) => q("delete from public.number_sequences where organization_id = $1", [org])));
    expect(ownerDelete.code).toBe("P0001");
    expect(ownerDelete.hint).toBe("number_sequences:delete");
    expect(await series(org, "order")).toMatchObject({ last_number: "1002" });
  });

  it("a rolled-back allocation leaves no gap; a committed one is never given again", async () => {
    const client = new Client({ connectionString: TEST_DB_URL });
    await client.connect();
    try {
      await client.query("begin");
      const r = await client.query<Allocated>("select * from app.next_document_number($1, 'quote')", [org]);
      expect(Number(r.rows[0].o_number)).toBe(3);
      await client.query("rollback");
    } finally {
      await client.end();
    }
    expect((await allocate(org, "quote")).n).toBe(3);
    expect((await allocate(org, "quote")).n).toBe(4);
  });

  it("two connections at the same moment get distinct consecutive numbers (the second waits for the first)", async () => {
    const start = Number((await series(org, "quote")).last_number);
    const first = new Client({ connectionString: TEST_DB_URL });
    const second = new Client({ connectionString: TEST_DB_URL });
    await first.connect();
    await second.connect();
    try {
      await first.query("begin");
      await second.query("begin");
      const a = await first.query<Allocated>("select * from app.next_document_number($1, 'quote')", [org]);
      // blocks on the row lock until the first transaction ends
      let secondDone = false;
      const pending = second.query<Allocated>("select * from app.next_document_number($1, 'quote')", [org]).then((res) => {
        secondDone = true;
        return res;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(secondDone).toBe(false);
      await first.query("commit");
      const b = await pending;
      await second.query("commit");
      expect([Number(a.rows[0].o_number), Number(b.rows[0].o_number)]).toEqual([start + 1, start + 2]);
    } finally {
      await first.end();
      await second.end();
    }

    // and under load: 25 allocations at once, each in its own transaction
    const before = Number((await series(org, "quote")).last_number);
    const got = await Promise.all(Array.from({ length: 25 }, () => allocate(org, "quote")));
    const numbers = got.map((g) => g.n).sort((x, y) => x - y);
    expect(numbers).toEqual(Array.from({ length: 25 }, (_, i) => before + 1 + i));
  });

  it("the first allocation of a new series under load creates one row and no duplicates", async () => {
    const fresh = await createOrg(owner.id, "עסק חדש למספרים");
    const got = await Promise.all(Array.from({ length: 10 }, () => allocate(fresh, "order")));
    expect(got.map((g) => g.n).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await asAdmin((q) => count(q, "select 1 from public.number_sequences where organization_id = $1", [fresh]))).toBe(1);
  });

  it("checks the caller: a signed-in caller must be able to write in that organization; clients cannot call it", async () => {
    expect((await pgError(allocate(org, "quote", viewer.id))).code).toBe("42501");
    expect((await pgError(allocate(org, "quote", outsider.id))).code).toBe("42501");
    expect((await allocate(org, "quote", manager.id)).n).toBeGreaterThan(0);
    expect((await pgError(allocate(org, "invoice"))).code).toBe("22023");
    expect((await pgError(allocate("00000000-0000-0000-0000-000000000000", "quote"))).code).toBe("22023");

    // started one at a time, so no rejection waits unobserved
    for (const run of [
      () => asUser(owner.id, (q) => q("select * from app.next_document_number($1, 'quote')", [org])),
      () => asService((q) => q("select * from app.next_document_number($1, 'quote')", [org])),
    ]) {
      expect((await pgError(run())).code).toBe("42501");
    }

    // a read-only business gets no new number from a person
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(allocate(org, "quote", owner.id))).code).toBe("42501");
      expect(await asUser(owner.id, async (q) => (await q("update public.number_sequences set prefix = 'X' where organization_id = $1", [org])).rowCount)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("checks the prefix and the start", async () => {
    for (const [prefix, start] of [
      ["ABCDEFGHIJKLM", 1],
      ["Q 1", 1],
      ["Q<", 1],
      ["Q-", 0],
      ["Q-", 1000000000],
      // a digit at the end would let "Q-1" + 35 print like "Q-" + 135
      ["Q-1", 1],
      ["2026", 1],
    ] as const) {
      const own = await pgError(asUser(outsider.id, (q) => q("insert into public.number_sequences (organization_id, kind, prefix, start_number) values ($1, 'order', $2, $3)", [other, prefix, start])));
      expect(own.code, `${prefix} ${start}`).toBe("23514");
    }
    expect((await pgError(asUser(outsider.id, (q) => q("insert into public.number_sequences (organization_id, kind) values ($1, 'invoice')", [other])))).code).toBe("23514");
    await asUser(outsider.id, (q) => q("insert into public.number_sequences (organization_id, kind, prefix, start_number) values ($1, 'order', 'הצ.2026/', 999999999)", [other]));
    expect(await allocate(other, "order")).toEqual({ n: 999999999, display: "הצ.2026/999999999" });
  });

  it("only owners and admins write; every member reads; other businesses see nothing", async () => {
    for (const u of [manager, member, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.number_sequences where organization_id = $1", [org]), u.email).toBe(2);
        expect((await q("update public.number_sequences set prefix = 'X' where organization_id = $1", [org])).rowCount, u.email).toBe(0);
      });
    }
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.number_sequences where organization_id = $1", [org]))).toBe(0);
    expect(await asUser(admin.id, async (q) => (await q("update public.number_sequences set prefix = 'Q-' where organization_id = $1 and kind = 'quote'", [org])).rowCount)).toBe(1);
  });

  it("refuses a cancelled or deleted business; a read-only or suspended one still numbers for the server", async () => {
    const closing = await createOrg(owner.id, "עסק שנסגר");
    const setStatus = (status: string, deleted = false) =>
      asAdmin((q) => q("update public.organizations set status = $2, deleted_at = case when $3 then now() else null end where id = $1", [closing, status, deleted]));
    for (const status of ["read_only", "suspended"]) {
      await setStatus(status);
      expect((await allocate(closing, "quote")).n, status).toBeGreaterThan(0);
      // a person never gets a number there (app.can_write)
      expect((await pgError(allocate(closing, "quote", owner.id))).code, status).toBe("42501");
    }
    for (const [status, deleted] of [["cancelled", false], ["active", true]] as const) {
      await setStatus(status, deleted);
      const err = await pgError(allocate(closing, "quote"));
      expect(err.code, `${status} ${deleted}`).toBe("P0001");
      expect(err.hint).toBe("org:closed");
    }
  });

  it("removing the organization removes its series (the one delete the guard lets through)", async () => {
    const gone = await createOrg(owner.id, "עסק שנמחק");
    await allocate(gone, "quote");
    await allocate(gone, "order");
    await asAdmin((q) => q("delete from public.organizations where id = $1", [gone]));
    expect(await asAdmin((q) => count(q, "select 1 from public.number_sequences where organization_id = $1", [gone]))).toBe(0);
  });

  it("does not audit the allocator's insert of a new series, even when a person's action caused it", async () => {
    const fresh = await createOrg(owner.id, "עסק בלי יומן מספור");
    const entries = () => asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'number_sequences'", [fresh]));
    expect((await allocate(fresh, "quote", owner.id)).n).toBe(1);
    expect(await allocate(fresh, "order")).toMatchObject({ n: 1 });
    expect(await entries()).toBe(0);
    // the setting does not stay on for the rest of the transaction: a person's insert after it is audited
    await asAdmin(async (q) => {
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner.id, role: "authenticated" })]);
      await q("select * from app.next_document_number($1, 'quote')", [org]);
      expect((await q<{ v: string | null }>("select current_setting('app.number_allocating', true) as v")).rows[0].v).not.toBe("on");
    });
    await asUser(owner.id, (q) => q("update public.number_sequences set prefix = 'Q-' where organization_id = $1 and kind = 'quote'", [fresh]));
    expect(await entries()).toBe(1);
  });

  describe("jump forward (owner, 14 October 2026)", () => {
    let jorg: string;
    let jowner: U, jadmin: U, jmember: U, jviewer: U;
    const jump = (user: U, orgId: string, kind: string, next: number) =>
      asUser(user.id, async (q) => Number((await q<{ n: string }>("select public.number_sequence_jump($1, $2, $3) as n", [orgId, kind, next])).rows[0].n));

    beforeAll(async () => {
      jowner = await createUser("nsj-owner");
      jorg = await createOrg(jowner.id, "עסק הקפיצה");
      jadmin = await addMember(jorg, jowner.id, "admin", "nsj-admin");
      jmember = await addMember(jorg, jowner.id, "member", "nsj-member");
      jviewer = await addMember(jorg, jowner.id, "viewer", "nsj-viewer");
    });

    it("before the first number there is nothing to jump; the start is edited instead", async () => {
      expect((await pgError(jump(jowner, jorg, "quote", 100))).hint).toBe("number_sequences:not_used");
    });

    it("moves the next number forward, writes one audit entry with the old and new numbers, and the series goes on from there", async () => {
      await allocate(jorg, "quote");
      await allocate(jorg, "quote");
      expect(await jump(jowner, jorg, "quote", 100)).toBe(100);
      const entries = await asAdmin(
        async (q) =>
          (await q<{ actor_id: string; action: string; changes: unknown }>("select actor_id, action, changes from public.audit_log where organization_id = $1 and action = 'number_jump'", [jorg])).rows,
      );
      expect(entries).toEqual([{ actor_id: jowner.id, action: "number_jump", changes: { next_number: { old: 3, new: 100 } } }]);
      expect((await allocate(jorg, "quote")).n).toBe(100);
      expect(await jump(jadmin, jorg, "quote", 500)).toBe(500);
      expect((await allocate(jorg, "quote")).n).toBe(500);
      // the other kind is untouched
      expect(await series(jorg, "order")).toBeUndefined();
    });

    it("refuses a number that is not higher, out of range, or an unknown kind", async () => {
      // last 500: next is 501, so 501, 500 and 7 do not move forward
      for (const next of [501, 500, 7]) {
        expect((await pgError(jump(jowner, jorg, "quote", next))).hint, String(next)).toBe("number_sequences:not_forward");
      }
      expect((await pgError(jump(jowner, jorg, "quote", 1000000000))).hint).toBe("number_sequences:range");
      expect((await pgError(jump(jowner, jorg, "quote", 0))).hint).toBe("number_sequences:range");
      expect((await pgError(jump(jowner, jorg, "invoice", 9000))).code).toBe("22023");
      // a direct write cannot go back either, the server and the table owner included
      for (const run of [
        () => asService((q) => q("update public.number_sequences set last_number = 10 where organization_id = $1 and kind = 'quote'", [jorg])),
        () => asAdmin((q) => q("update public.number_sequences set last_number = 10 where organization_id = $1 and kind = 'quote'", [jorg])),
      ]) {
        expect((await pgError(run())).hint).toBe("number_sequences:last_number");
      }
      // and a person cannot write last_number at all
      expect((await pgError(asUser(jowner.id, (q) => q("update public.number_sequences set last_number = 9000 where organization_id = $1", [jorg])))).code).toBe("42501");
      expect(await series(jorg, "quote")).toMatchObject({ last_number: "500" });
    });

    it("only owners and admins of that writable business may jump; nobody else, and not the server role", async () => {
      for (const user of [jmember, jviewer, outsider, owner]) {
        expect((await pgError(jump(user, jorg, "quote", 9000))).code, user.email).toBe("42501");
      }
      expect((await pgError(asService((q) => q("select public.number_sequence_jump($1, 'quote', 9000)", [jorg])))).code).toBe("42501");
      await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [jorg]));
      try {
        expect((await pgError(jump(jowner, jorg, "quote", 9000))).code).toBe("42501");
      } finally {
        await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [jorg]));
      }
      expect(await series(jorg, "quote")).toMatchObject({ last_number: "500" });
      expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'number_jump'", [jorg]))).toBe(2);
    });

    it("an allocation at the same moment never yields a duplicate, whichever comes first", async () => {
      // allocation holds the row; the jump waits and is checked against the allocated number
      const alloc = new Client({ connectionString: TEST_DB_URL });
      await alloc.connect();
      try {
        await alloc.query("begin");
        const a = await alloc.query<Allocated>("select * from app.next_document_number($1, 'quote')", [jorg]);
        expect(Number(a.rows[0].o_number)).toBe(501);
        let jumped = false;
        const pending = jump(jowner, jorg, "quote", 502).then(
          () => (jumped = true),
          (err: unknown) => err,
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(jumped).toBe(false);
        await alloc.query("commit");
        // after 501 was used, 502 is the current next: not forward
        expect(((await pending) as { hint?: string }).hint).toBe("number_sequences:not_forward");
      } finally {
        await alloc.end();
      }

      // the jump holds the row; the allocation waits and continues after the new number
      const jumper = new Client({ connectionString: TEST_DB_URL });
      await jumper.connect();
      try {
        await jumper.query("begin");
        await jumper.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: jowner.id, role: "authenticated" })]);
        await jumper.query("set local role authenticated");
        await jumper.query("select public.number_sequence_jump($1, 'quote', 800)", [jorg]);
        let allocated = false;
        const pending = allocate(jorg, "quote").then((r) => {
          allocated = true;
          return r;
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(allocated).toBe(false);
        await jumper.query("commit");
        expect((await pending).n).toBe(800);
      } finally {
        await jumper.end();
      }
      const all = await Promise.all([allocate(jorg, "quote"), allocate(jorg, "quote"), jump(jadmin, jorg, "quote", 5000).catch(() => null), allocate(jorg, "quote")]);
      const numbers = [all[0], all[1], all[3]].map((r) => r.n);
      expect(new Set(numbers).size).toBe(3);
    });
  });

  it("a person's session cannot switch the audit off with the allocator's setting", async () => {
    const fresh = await createOrg(owner.id, "עסק שמנסה לדלג על היומן");
    const entries = () => asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'number_sequences'", [fresh]));
    await asUser(owner.id, async (q) => {
      await q("select set_config('app.number_allocating', 'on', true)");
      await q("insert into public.number_sequences (organization_id, kind, prefix) values ($1, 'quote', 'Q-')", [fresh]);
      await q("update public.number_sequences set prefix = 'QT-' where organization_id = $1 and kind = 'quote'", [fresh]);
    });
    expect(await entries()).toBe(2);
    // the allocator's own insert stays unaudited
    expect((await allocate(fresh, "order", owner.id)).n).toBe(1);
    expect(await entries()).toBe(2);
  });

  it("stops at 999,999,999: the allocator refuses the next number and the table never holds more", async () => {
    const full = await createOrg(outsider.id, "עסק בסוף הסדרה");
    await asUser(outsider.id, (q) => q("insert into public.number_sequences (organization_id, kind, start_number) values ($1, 'quote', 999999998)", [full]));
    expect((await allocate(full, "quote")).n).toBe(999999998);
    expect((await allocate(full, "quote")).n).toBe(999999999);
    const err = await pgError(allocate(full, "quote"));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("number_sequences:exhausted");
    expect(await series(full, "quote")).toMatchObject({ last_number: "999999999" });
    // no writer can store a number past the end
    expect((await pgError(asAdmin((q) => q("update public.number_sequences set last_number = 1000000000 where organization_id = $1 and kind = 'quote'", [full])))).code).toBe("23514");
  });

  it("audits a person's change of prefix or start, not each number handed out", async () => {
    const entries = () => asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'number_sequences'", [org]));
    const before = await entries();
    await allocate(org, "quote");
    await allocate(org, "quote");
    expect(await entries()).toBe(before);
    await asUser(owner.id, (q) => q("update public.number_sequences set prefix = 'QT-' where organization_id = $1 and kind = 'quote'", [org]));
    expect(await entries()).toBe(before + 1);
  });
});
