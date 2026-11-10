import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dbErrorMessage } from "@/lib/errors";

import { asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Answer = Record<string, unknown>;

const envelope = (body: string) => `ps1.1.AAAAAAAAAAAAAAAA.${body}.BBBBBBBBBBBBBBBBBBBBBB`;

/**
 * CAP-11 follow-up (migration _meta_page_taken_reopen.sql): an unverified connection that lost its page keeps its status
 * and is ended by last_error_code 'page_taken' (021208, 021215). A new token used to clear that code without the going-live
 * check (the status stayed 'connected'), so the connection looked healthy while the page is verified by another business.
 * app.integrations_check now runs the page-ownership check when an update clears an error code.
 */
describe("a new token does not re-open a connection whose page is verified elsewhere (CAP-11)", () => {
  let winnerOwner: U, loserOwner: U;
  let winnerOrg: string, loserOrg: string;
  let seq = (process.pid % 100000) * 1000 + 900;
  const id = () => String(8400000000 + (seq += 1));

  const makeConnection = (who: U, o: string, page: string, token: string) =>
    asUser(who.id, async (q) => {
      const made = (await q<{ id: string }>("insert into public.integrations (organization_id, provider, external_id, name) values ($1, 'meta_lead_ads', $2, 'הדף') returning id", [o, page])).rows[0].id;
      await q("select public.integration_secret_set($1, $2, $3, 1)", [o, made, envelope(token)]);
      return made;
    });
  const saveToken = (who: U, o: string, integration: string, token: string) =>
    asUser(who.id, async (q) => (await q<{ r: string }>("select public.integration_secret_set($1, $2, $3, 1) as r", [o, integration, envelope(token)])).rows[0].r);
  const state = (integration: string) =>
    asAdmin(
      async (q) =>
        (
          await q<Answer>(
            `select i.status, i.last_error_code, i.verified_at is not null as verified, i.secret_set_at, s.ciphertext
               from public.integrations i left join app.integration_secrets s on s.integration_id = i.id
              where i.id = $1`,
            [integration],
          )
        ).rows[0],
    );
  // the end state 021208 / 021215 leave: the winner verified, the loser ended by its code with its status kept
  const loseRace = (winner: string, loser: string) =>
    asAdmin(async (q) => {
      await q("update public.integrations set verified_at = now() where id = $1", [winner]);
      await q("update public.integrations set last_error_code = 'page_taken', last_error_at = now() where id = $1", [loser]);
    });

  beforeAll(async () => {
    winnerOwner = await createUser("metareopen-winner");
    winnerOrg = await createOrg(winnerOwner.id, "עסק הדף");
    loserOwner = await createUser("metareopen-loser");
    loserOrg = await createOrg(loserOwner.id, "עסק שני");
  });

  it("the loser's new token is refused with integration:taken and nothing changes", async () => {
    const page = id();
    const winner = await makeConnection(winnerOwner, winnerOrg, page, "V2lubmVyVG9rZW4");
    const loser = await makeConnection(loserOwner, loserOrg, page, "TG9zZXJUb2tlbg");
    await loseRace(winner, loser);
    const before = await state(loser);
    expect(before).toMatchObject({ status: "connected", last_error_code: "page_taken", verified: false });

    const refused = await pgError(saveToken(loserOwner, loserOrg, loser, "TmV3TG9zZXJUb2tlbg"));
    expect(refused).toMatchObject({ code: "P0001", hint: "integration:taken" });
    expect(dbErrorMessage(refused)).toBe("הדף הזה כבר מחובר לעסק אחר במקסוז");
    // the whole save rolled back: code, status, stamp and the stored ciphertext as they were
    expect(await state(loser)).toEqual(before);
    // the verified owner is untouched
    expect(await state(winner)).toMatchObject({ status: "connected", last_error_code: null, verified: true });
  });

  it("a connection whose page is not verified elsewhere still saves a token and re-opens", async () => {
    // ended by page_taken, but the page is no longer held verified by anyone (the winner disconnected)
    const page = id();
    const winner = await makeConnection(winnerOwner, winnerOrg, page, "V2lubmVyVG9rZW4");
    const loser = await makeConnection(loserOwner, loserOrg, page, "TG9zZXJUb2tlbg");
    await loseRace(winner, loser);
    await asUser(winnerOwner.id, (q) => q("update public.integrations set status = 'disconnected' where id = $1", [winner]));
    expect(await saveToken(loserOwner, loserOrg, loser, "UmVvcGVuVG9rZW4")).toBe("connected");
    expect(await state(loser)).toMatchObject({ status: "connected", last_error_code: null, verified: false, ciphertext: envelope("UmVvcGVuVG9rZW4") });

    // an unverified connection ended by token_invalid, alone on its page, re-opens with a new token too
    const alonePage = id();
    const alone = await makeConnection(loserOwner, loserOrg, alonePage, "QWxvbmVUb2tlbg");
    await asAdmin((q) => q("update public.integrations set last_error_code = 'token_invalid', last_error_at = now() where id = $1", [alone]));
    expect(await saveToken(loserOwner, loserOrg, alone, "QWxvbmVOZXdUb2tlbg")).toBe("connected");
    expect(await state(alone)).toMatchObject({ status: "connected", last_error_code: null, verified: false });
  });

  it("the owner of the verified page saves a new token as before, also clearing its own error code", async () => {
    const page = id();
    const winner = await makeConnection(winnerOwner, winnerOrg, page, "V2lubmVyVG9rZW4");
    const loser = await makeConnection(loserOwner, loserOrg, page, "TG9zZXJUb2tlbg");
    await loseRace(winner, loser);
    // a plain token refresh on the healthy verified connection
    expect(await saveToken(winnerOwner, winnerOrg, winner, "V2lubmVyVG9rZW4y")).toBe("connected");
    expect(await state(winner)).toMatchObject({ status: "connected", last_error_code: null, verified: true });
    // its token expired (code set, status kept): a new token clears the code; the loser's page_taken does not block it
    await asAdmin((q) => q("update public.integrations set last_error_code = 'token_invalid', last_error_at = now() where id = $1", [winner]));
    expect(await saveToken(winnerOwner, winnerOrg, winner, "V2lubmVyVG9rZW4z")).toBe("connected");
    expect(await state(winner)).toMatchObject({ status: "connected", last_error_code: null, verified: true, ciphertext: envelope("V2lubmVyVG9rZW4z") });
    // and the loser is still ended
    expect(await state(loser)).toMatchObject({ status: "connected", last_error_code: "page_taken", verified: false });
  });
});
