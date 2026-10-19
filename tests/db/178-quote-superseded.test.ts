import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Page = { quote: { number: string; status: string }; replaced: { number: string } | null };
type Version = { number: string | null; fingerprint: string | null };

/**
 * QUO-11 review: once a newer version of a quote was sent, the customer's old link never shows or decides the superseded
 * quote again. A newer version that is cancelled or expires closes the old link (not found) instead of bringing the old
 * quote back, and no path can accept or decline the superseded quote.
 */
describe("a superseded quote stays superseded (QUO-11 review)", () => {
  let owner: U, member: U;
  let org: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const sentQuote = () =>
    asUser(member.id, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipelineId,
          stageId,
          member.id,
        ])
      ).id;
      const quote = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'שיפוץ', $2) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'עבודה', 50000)", [org, quote]);
      await q("select public.quote_send($1, $2)", [org, quote]);
      return quote;
    });
  const linkOf = (quote: string) => asUser(member.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t);
  const newVersion = (quote: string) => asUser(member.id, async (q) => (await one<{ v: string }>(q, "select public.quote_new_version($1, $2) as v", [org, quote])).v);
  const send = (quote: string) => asUser(member.id, (q) => q("select public.quote_send($1, $2)", [org, quote]));
  const page = (token: string) => asService(async (q) => (await one<{ p: Page }>(q, "select public.quote_public($1) as p", [token])).p);
  const version = (token: string) => asService(async (q) => (await one<{ v: Version }>(q, "select public.quote_public_version($1) as v", [token])).v);
  const decideIn = async (q: Query, token: string, fingerprint: string | null, decision = "accepted") =>
    (
      await one<{ a: { status: string } }>(
        q,
        `select public.quote_public_decide(p_token => $1, p_decision => $3, p_fingerprint => $2, p_signer_name => 'רונית לוי',
                  p_signature_kind => 'typed', p_wording_version => 'draft-2026-10-18', p_agreed => true) as a`,
        [token, fingerprint ?? "0".repeat(64), decision],
      )
    ).a;
  const decide = (token: string, fingerprint: string | null) =>
    asService(
      async (q) =>
        (
          await one<{ a: { status: string } }>(
            q,
            `select public.quote_public_decide(p_token => $1, p_decision => 'accepted', p_fingerprint => $2, p_signer_name => 'רונית לוי',
                      p_signature_kind => 'typed', p_wording_version => 'draft-2026-10-18', p_agreed => true) as a`,
            [token, fingerprint ?? "0".repeat(64)],
          )
        ).a,
    );
  const status = (quote: string) => asAdmin(async (q) => (await one<{ s: string }>(q, "select status as s from public.quotes where id = $1", [quote])).s);
  const number = (quote: string) => asAdmin(async (q) => (await one<{ n: string }>(q, "select number_display as n from public.quotes where id = $1", [quote])).n);
  // v1 sent with its link, v2 sent with its own link: the old link shows v2
  const chain = async () => {
    const v1 = await sentQuote();
    const t1 = await linkOf(v1);
    const fingerprint1 = (await version(t1)).fingerprint;
    const v2 = await newVersion(v1);
    await send(v2);
    await linkOf(v2);
    expect(await page(t1)).toMatchObject({ quote: { number: await number(v2) }, replaced: { number: await number(v1) } });
    return { v1, t1, v2, fingerprint1 };
  };
  // every way of reaching or deciding v1 through its own link is closed, and no other path decides it
  const v1Closed = async (c: { v1: string; t1: string; fingerprint1: string | null }) => {
    expect((await pgError(page(c.t1))).code).toBe("P0002");
    expect((await pgError(version(c.t1))).code).toBe("P0002");
    expect((await pgError(decide(c.t1, c.fingerprint1))).code).toBe("P0002");
    expect((await pgError(asUser(member.id, (q) => q("select public.quote_new_version($1, $2)", [org, c.v1])))).hint).toBe("quote_version:exists");
    for (const to of ["accepted", "rejected"]) {
      expect((await pgError(asAdmin((q) => q("update public.quotes set status = $2 where id = $1", [c.v1, to])))).hint, to).toBe("quote:superseded");
    }
    // still undecided (QUO-10 marks it viewed when the customer opened it before the new version)
    expect(["sent", "viewed"]).toContain(await status(c.v1));
  };

  beforeAll(async () => {
    owner = await createUser("qs-owner");
    org = await createOrg(owner.id, "עסק הגרסאות");
    member = await addMember(org, owner.id, "member", "qs-member");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
  });

  it("a cancelled newer version closes the old link; the superseded quote is not shown or accepted", async () => {
    const c = await chain();
    await asUser(member.id, (q) => q("select public.quote_cancel($1, $2)", [org, c.v2]));
    await v1Closed(c);
  });

  it("an expired newer version closes the old link the same way", async () => {
    const c = await chain();
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.quotes set valid_until = current_date - 2, quote_date = current_date - 30 where id = $1", [c.v2]);
    });
    await asAdmin((q) => q("select app.expire_quotes()"));
    expect(await status(c.v2)).toBe("expired");
    await v1Closed(c);
  });

  it("a newer version sent without a link yet, or whose link was turned off, never brings the old one back", async () => {
    const v1 = await sentQuote();
    const t1 = await linkOf(v1);
    const fingerprint1 = (await version(t1)).fingerprint;
    const v2 = await newVersion(v1);
    // a draft version changes nothing: the original is still shown and may be decided
    expect(await page(t1)).toMatchObject({ quote: { number: await number(v1) }, replaced: null });
    await send(v2);
    await v1Closed({ v1, t1, fingerprint1 });
    await linkOf(v2);
    await asUser(member.id, (q) => q("select public.quote_link_revoke($1, $2)", [org, v2]));
    await v1Closed({ v1, t1, fingerprint1 });
  });

  it("a decided newer version is shown as decided on the old link, and the old quote stays undecided", async () => {
    const c = await chain();
    const v = await version(c.t1);
    expect(v.number).toBe(await number(c.v2));
    expect(await decide(c.t1, v.fingerprint)).toEqual({ status: "accepted" });
    expect(["sent", "viewed"]).toContain(await status(c.v1));
    expect(await status(c.v2)).toBe("accepted");
    expect((await page(c.t1)).quote.status).toBe("accepted");
    expect(await version(c.t1)).toEqual({ number: await number(c.v2), fingerprint: null });
  });

  it("an accepted quote's draft version is never sent (the probe), while deciding with only a draft version stays allowed", async () => {
    // a declined quote's draft version may be sent since 19 October 2026 (owner, QUO-12; test 198)
    for (const decision of ["accepted"]) {
      const v1 = await sentQuote();
      const t1 = await linkOf(v1);
      const v2 = await newVersion(v1);
      // a draft version does not supersede: the customer still answers v1 on its own link
      const f1 = (await version(t1)).fingerprint;
      expect(await asService((q) => decideIn(q, t1, f1, decision))).toEqual({ status: decision });
      expect(await status(v1)).toBe(decision);
      // the staff then try to send the draft: refused for every writer, and it stays a draft that may be deleted
      expect((await pgError(send(v2))).hint, decision).toBe("quote_version:previous_decided");
      expect((await pgError(asAdmin((q) => q("update public.quotes set status = 'sent' where id = $1", [v2]))))).toMatchObject({ hint: "quote_version:previous_decided" });
      expect(await status(v2)).toBe("draft");
      // v1's page still shows v1 as decided, and nothing else can be decided there
      expect((await page(t1)).quote).toMatchObject({ number: await number(v1), status: decision });
      expect(await version(t1)).toEqual({ number: await number(v1), fingerprint: null });
      expect((await asUser(member.id, (q) => q("delete from public.quotes where id = $1 returning id", [v2]))).rowCount).toBe(1);
      // and no new version is made from a decided quote
      expect((await pgError(newVersion(v1))).hint).toBe("quote_version:closed");
    }
  });

  it("a decision and a send in flight at the same time: whichever commits first wins, the other is turned away", async () => {
    // each side is ordered by what the database reports, never by a timer: the first side has run its statement (and holds
    // its lock) before the second starts, and the second is seen waiting on a lock (pg_stat_activity) before the first commits
    const deferred = <T = void,>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => (resolve = r));
      return { promise, resolve };
    };
    const backendPid = async (q: Query) => (await one<{ pid: number }>(q, "select pg_backend_pid() as pid")).pid;
    const waitUntilBlocked = async (pid: Promise<number>) => {
      const id = await pid;
      for (let i = 0; i < 400; i += 1) {
        const row = await asAdmin(async (q) => (await q<{ w: string | null }>("select wait_event_type as w from pg_stat_activity where pid = $1", [id])).rows[0]);
        if (row?.w === "Lock") return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`backend ${id} never waited on a lock`);
    };

    // `first` runs in its own transaction until it calls hold() (its statement done, its lock held); then `second` starts and
    // must be seen waiting on a lock; then `first` commits. On any failure the held transaction is rolled back, both sides
    // are awaited (no transaction left open for closePool), and the error is thrown at once.
    const ordered = async <A, B>(first: (hold: () => Promise<void>) => Promise<A>, second: (pid: (q: Query) => Promise<void>) => Promise<B>): Promise<[A, B]> => {
      const held = deferred();
      const gate = deferred<boolean>();
      const pid = deferred<number>();
      const firstRun = first(async () => {
        held.resolve();
        if (!(await gate.promise)) throw new Error("rolled back: the other side failed");
      });
      let secondRun: Promise<B> | undefined;
      let ok = false;
      try {
        await Promise.race([
          held.promise,
          firstRun.then(() => {
            throw new Error("the first side ended before holding its lock");
          }),
        ]);
        const started = second(async (q) => pid.resolve(await backendPid(q)));
        secondRun = started;
        await waitUntilBlocked(
          Promise.race([
            pid.promise,
            started.then(() => {
              throw new Error("the second side ended without waiting on a lock");
            }),
          ]),
        );
        ok = true;
      } finally {
        gate.resolve(ok);
        if (!ok) await Promise.allSettled([firstRun, secondRun]);
      }
      return [await firstRun, await (secondRun as Promise<B>)];
    };

    // the send commits first: the decision waits on v1, then sees the newer version and answers "changed"
    const a = await sentQuote();
    const ta = await linkOf(a);
    const fa = (await version(ta)).fingerprint;
    const a2 = await newVersion(a);
    const [, decision] = await ordered(
      (hold) =>
        asUser(member.id, async (q) => {
          await q("select public.quote_send($1, $2)", [org, a2]);
          await hold();
        }),
      (pid) =>
        asService(async (q) => {
          await pid(q);
          return decideIn(q, ta, fa);
        }),
    );
    expect(decision).toEqual({ status: "changed" });
    expect(["sent", "viewed"]).toContain(await status(a));
    expect(await status(a2)).toBe("sent");

    // the decision commits first: the send waits on v1, then sees it decided and is refused
    const b = await sentQuote();
    const tb = await linkOf(b);
    const fb = (await version(tb)).fingerprint;
    const b2 = await newVersion(b);
    const [answer, refusal] = await ordered(
      (hold) =>
        asService(async (q) => {
          const result = await decideIn(q, tb, fb);
          await hold();
          return result;
        }),
      (pid) =>
        pgError(
          asUser(member.id, async (q) => {
            await pid(q);
            await q("select public.quote_send($1, $2)", [org, b2]);
          }),
        ),
    );
    expect(answer).toEqual({ status: "accepted" });
    expect(refusal.hint).toBe("quote_version:previous_decided");
    expect([await status(b), await status(b2)]).toEqual(["accepted", "draft"]);
  });
});
