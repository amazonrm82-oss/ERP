import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asMfaUser, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/** An envelope of the shape the server makes (src/features/integrations/crypto.ts); the database never sees a key. */
const envelope = (version = 1, body = "Q2lwaGVydGV4dA") => `ps1.${version}.AAAAAAAAAAAAAAAA.${body}.BBBBBBBBBBBBBBBBBBBBBB`;

/**
 * INT-02: a business's provider connections, with the secret stored only as ciphertext in schema app; owners and admins
 * only; audited without the secret; never readable by a browser; replaced only through the service-role pair.
 */
describe("provider secrets (INT-02)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let page = 9100000 + (process.pid % 100000) * 10;
  const nextPage = () => String((page += 1));

  const connect = (who: U, o: string, pageId = nextPage(), name = "הדף של העסק") =>
    asUser(who.id, async (q) =>
      (
        await q<{ id: string; status: string }>(
          "insert into public.integrations (organization_id, provider, external_id, name) values ($1, 'meta_lead_ads', $2, $3) returning id, status",
          [o, pageId, name],
        )
      ).rows[0],
    );
  const setSecret = (who: U, o: string, id: string, value = envelope(), version = 1) =>
    asUser(who.id, async (q) => (await q<{ r: string }>("select public.integration_secret_set($1, $2, $3, $4) as r", [o, id, value, version])).rows[0].r);

  beforeAll(async () => {
    owner = await createUser("ps-owner");
    org = await createOrg(owner.id, "עסק החיבורים");
    admin = await addMember(org, owner.id, "admin", "ps-admin");
    manager = await addMember(org, owner.id, "manager", "ps-manager");
    member = await addMember(org, owner.id, "member", "ps-member");
    viewer = await addMember(org, owner.id, "viewer", "ps-viewer");
    outsider = await createUser("ps-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  it("owners and admins connect; a new connection waits for its secret, whatever is sent", async () => {
    const made = await connect(owner, org);
    expect(made.status).toBe("pending");
    const byAdmin = await connect(admin, org);
    expect(byAdmin.status).toBe("pending");
    for (const who of [manager, member, viewer]) {
      expect((await pgError(connect(who, org))).code).toBe("42501");
    }
    expect((await pgError(connect(outsider, org))).code).toBe("42501");
    // the server-kept columns have no insert grant
    const forged = await pgError(
      asUser(owner.id, (q) =>
        q("insert into public.integrations (organization_id, provider, external_id, name, status) values ($1, 'meta_lead_ads', $2, 'x', 'connected')", [org, nextPage()]),
      ),
    );
    expect(forged.code).toBe("42501");
  });

  it("only owners and admins read connections; nobody else in or out of the business", async () => {
    const made = await connect(owner, org);
    for (const who of [owner, admin]) {
      expect(await asUser(who.id, (q) => count(q, "select 1 from public.integrations where id = $1", [made.id]))).toBe(1);
    }
    for (const who of [manager, member, viewer, outsider]) {
      expect(await asUser(who.id, (q) => count(q, "select 1 from public.integrations where id = $1", [made.id]))).toBe(0);
    }
    expect((await pgError(asAnon((q) => q("select 1 from public.integrations")))).code).toBe("42501");
  });

  it("stores the secret as ciphertext only, outside the API; nothing a client can call returns it", async () => {
    const made = await connect(owner, org);
    expect(await setSecret(owner, org, made.id, envelope(1, "U2VjcmV0Qm9keQ"))).toBe("connected");
    const row = (await asUser(owner.id, (q) => q<Record<string, unknown>>("select * from public.integrations where id = $1", [made.id]))).rows[0];
    expect(row.status).toBe("connected");
    expect(row.secret_key_version).toBe(1);
    expect(row.secret_set_at).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain("U2VjcmV0Qm9keQ");
    // schema app: no client role reads the ciphertext
    for (const run of [(fn: Parameters<typeof asAnon>[0]) => asAnon(fn), (fn: Parameters<typeof asAnon>[0]) => asUser(owner.id, fn)]) {
      expect((await pgError(run((q) => q("select ciphertext from app.integration_secrets")))).code).toBe("42501");
    }
    // the audit log holds the connection's changes and never the secret
    const audit = await asAdmin(async (q) =>
      (await q<{ changes: unknown }>("select changes from public.audit_log where entity_type = 'integrations' and entity_id = $1", [made.id])).rows,
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain("U2VjcmV0Qm9keQ");
    expect(JSON.stringify(audit)).not.toContain("ps1.");
    // owner (146) ג: no function hands out the stored ciphertexts for re-encryption
    expect(await asAdmin((q) => count(q, "select 1 from pg_proc where proname in ('integration_secrets_rekey_list', 'integration_secret_rekey')"))).toBe(0);
  });

  it("refuses a plain value, a version that does not match the envelope, and other people's connections", async () => {
    const made = await connect(owner, org);
    expect(await pgError(setSecret(owner, org, made.id, "EAAB-plain-token", 1))).toMatchObject({ code: "22023", hint: "integration:secret_format" });
    expect(await pgError(setSecret(owner, org, made.id, envelope(2), 1))).toMatchObject({ code: "22023", hint: "integration:secret_format" });
    for (const who of [manager, member, viewer, outsider]) {
      expect((await pgError(setSecret(who, org, made.id))).code).toBe("42501");
    }
    // another business's id is not found from inside this one
    const theirs = await connect(outsider, otherOrg);
    expect((await pgError(setSecret(owner, org, theirs.id))).code).toBe("P0002");
    expect(await asAdmin((q) => count(q, "select 1 from app.integration_secrets where integration_id = $1", [theirs.id]))).toBe(0);
  });

  it("a person only disconnects, or reconnects while a secret is stored; never sets the server's status", async () => {
    const made = await connect(owner, org);
    const setStatus = (status: string) =>
      asUser(owner.id, async (q) => (await q("update public.integrations set status = $2 where id = $1", [made.id, status])).rowCount);
    expect(await pgError(setStatus("connected"))).toMatchObject({ code: "P0001", hint: "integration:status" });
    expect(await pgError(setStatus("error"))).toMatchObject({ code: "P0001", hint: "integration:status" });
    await setSecret(owner, org, made.id);
    expect(await setStatus("disconnected")).toBe(1);
    expect(await setStatus("connected")).toBe(1);
    expect((await pgError(asUser(owner.id, (q) => q("update public.integrations set secret_set_at = null where id = $1", [made.id]))))).toMatchObject({ code: "42501" });
    expect((await pgError(asUser(owner.id, (q) => q("update public.integrations set external_id = '1' where id = $1", [made.id]))))).toMatchObject({ code: "42501" });
    // a member's update reaches nothing
    expect(await asUser(member.id, async (q) => (await q("update public.integrations set name = 'x' where id = $1", [made.id])).rowCount)).toBe(0);
  });

  it("a VERIFIED Meta page is live in one business at a time (the answer names no business); an unverified one blocks nobody", async () => {
    const pageId = nextPage();
    const mine = await connect(owner, org, pageId);
    await setSecret(owner, org, mine.id);
    // review finding 1: a stored secret proves nothing, so an unverified claim never blocks another business
    const early = await connect(outsider, otherOrg, nextPage());
    const squat = await connect(admin, org, nextPage());
    expect(await setSecret(admin, org, squat.id)).toBe("connected");
    expect(await setSecret(outsider, otherOrg, early.id)).toBe("connected");
    // the page is proven only by a fetch (CAP-11's meta_lead_finish, test 304); here set as the server would
    await asAdmin((q) => q("update public.integrations set verified_at = now() where id = $1", [mine.id]));
    const theirs = await connect(outsider, otherOrg, pageId);
    expect(await pgError(setSecret(outsider, otherOrg, theirs.id))).toMatchObject({ code: "P0001", hint: "integration:taken" });
    // a person never sets verified_at
    expect((await pgError(asUser(owner.id, (q) => q("update public.integrations set verified_at = now() where id = $1", [mine.id])))).code).toBe("42501");
    // once the first business disconnects, the page may be connected elsewhere
    await asUser(owner.id, (q) => q("update public.integrations set status = 'disconnected' where id = $1", [mine.id]));
    expect(await setSecret(outsider, otherOrg, theirs.id)).toBe("connected");
    // the verified first may come back: the other one is not verified, so it blocks nothing
    expect(await asUser(owner.id, async (q) => (await q("update public.integrations set status = 'connected' where id = $1", [mine.id])).rowCount)).toBe(1);
    // and the unverified one, switched off and on again, is refused while the verified one is live
    await asUser(outsider.id, (q) => q("update public.integrations set status = 'disconnected' where id = $1", [theirs.id]));
    expect(await pgError(asUser(outsider.id, (q) => q("update public.integrations set status = 'connected' where id = $1", [theirs.id])))).toMatchObject({
      code: "P0001",
      hint: "integration:taken",
    });
    expect(await pgError(connect(owner, org, "not-digits"))).toMatchObject({ code: "P0001", hint: "integration:page_id" });
  });

  it("removing a connection removes its secret; a read-only business stores none", async () => {
    const made = await connect(owner, org);
    await setSecret(owner, org, made.id);
    expect(await asUser(owner.id, async (q) => (await q("delete from public.integrations where id = $1", [made.id])).rowCount)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from app.integration_secrets where integration_id = $1", [made.id]))).toBe(0);

    const roOwner = await createUser("ps-ro");
    const roOrg = await createOrg(roOwner.id, "עסק לקריאה");
    const roConn = await connect(roOwner, roOrg);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [roOrg]));
    expect((await pgError(setSecret(roOwner, roOrg, roConn.id))).hint).toBe("org:read_only");
    // MFA sessions change nothing here (no extra rule)
    expect(await asMfaUser(owner.id, (q) => count(q, "select 1 from public.integrations where organization_id = $1", [org]))).toBeGreaterThan(0);
  });
});
