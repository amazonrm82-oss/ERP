import { randomUUID } from "node:crypto";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

/**
 * Helpers for the database tests.
 *
 * SAFETY: these tests DROP and re-create their database. They refuse to run
 * against anything that is not a local server and a database whose name ends
 * in `_test`, so they can never touch a real Supabase project.
 */

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/crm_saas_test";

export function assertSafeTestUrl(url: string): void {
  const parsed = new URL(url);
  const localHosts = ["127.0.0.1", "localhost", "[::1]", "::1"];
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!localHosts.includes(parsed.hostname)) {
    throw new Error(
      `Refusing to run database tests against host "${parsed.hostname}". Only a local throwaway server is allowed.`,
    );
  }
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `Refusing to run database tests against database "${dbName}". The name must end with "_test".`,
    );
  }
}

assertSafeTestUrl(TEST_DB_URL);

let pool: Pool | undefined;

function getPool(): Pool {
  pool ??= new Pool({ connectionString: TEST_DB_URL, max: 4 });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export type Query = <R extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
) => Promise<QueryResult<R>>;

async function inTransaction<T>(preamble: (q: Query) => Promise<void>, fn: (q: Query) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const q: Query = (sql, params) => client.query(sql, params as unknown[] | undefined);
  try {
    await client.query("begin");
    await preamble(q);
    const result = await fn(q);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Superuser: used only to arrange state and to inspect what clients cannot see. */
export function asAdmin<T>(fn: (q: Query) => Promise<T>): Promise<T> {
  return inTransaction(async () => undefined, fn);
}

/** Exactly what a signed-in browser gets: role `authenticated` + a JWT subject. */
export function asUser<T>(userId: string, fn: (q: Query) => Promise<T>, claims: Record<string, unknown> = {}): Promise<T> {
  return inTransaction(async (q) => {
    await q("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated", ...claims }),
    ]);
    await q("set local role authenticated");
  }, fn);
}

/** A signed-in user whose session passed the second factor (Supabase MFA: aal2). */
export function asMfaUser<T>(userId: string, fn: (q: Query) => Promise<T>): Promise<T> {
  return asUser(userId, fn, { aal: "aal2" });
}

/** A visitor with no session. */
export function asAnon<T>(fn: (q: Query) => Promise<T>): Promise<T> {
  return inTransaction(async (q) => {
    await q("select set_config('request.jwt.claims', '', true)");
    await q("set local role anon");
  }, fn);
}

/** The app's server with the service-role key (used only by the lead intake routes). */
export function asService<T>(fn: (q: Query) => Promise<T>): Promise<T> {
  return inTransaction(async (q) => {
    await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    await q("set local role service_role");
  }, fn);
}

export async function createUser(label = "user"): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const id = await asAdmin(async (q) => {
    const res = await q<{ id: string }>(
      "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
      [email, JSON.stringify({ full_name: label })],
    );
    return res.rows[0].id;
  });
  return { id, email };
}

export async function createOrg(ownerId: string, name = "עסק לדוגמה"): Promise<string> {
  return asUser(ownerId, async (q) => {
    const res = await q<{ id: string }>("select public.create_organization($1) as id", [name]);
    return res.rows[0].id;
  });
}

export type Role = "admin" | "manager" | "member" | "viewer";

/** Invites a brand-new user and has them accept, the same way the app will. */
export async function addMember(
  orgId: string,
  inviterId: string,
  role: Role = "member",
  label: string = role,
): Promise<{ id: string; email: string }> {
  const user = await createUser(label);
  const token = await asUser(inviterId, async (q) => {
    const res = await q<{ token: string }>("select public.create_invitation($1, $2, $3) as token", [
      orgId,
      user.email,
      role,
    ]);
    return res.rows[0].token;
  });
  await asUser(user.id, (q) => q("select public.accept_invitation($1)", [token]));
  return user;
}

export async function defaultLeadStatus(orgId: string): Promise<string> {
  return asAdmin(async (q) => {
    const res = await q<{ id: string }>(
      "select id from public.lead_statuses where organization_id = $1 and is_default",
      [orgId],
    );
    return res.rows[0].id;
  });
}

export async function defaultPipeline(orgId: string): Promise<{ pipelineId: string; stages: { id: string; kind: string }[] }> {
  return asAdmin(async (q) => {
    const pipeline = await q<{ id: string }>(
      "select id from public.pipelines where organization_id = $1 and is_default",
      [orgId],
    );
    const stages = await q<{ id: string; kind: string }>(
      "select id, kind from public.stages where pipeline_id = $1 order by position",
      [pipeline.rows[0].id],
    );
    return { pipelineId: pipeline.rows[0].id, stages: stages.rows };
  });
}

export async function insertLead(
  userId: string,
  orgId: string,
  fields: Record<string, unknown> = {},
): Promise<string> {
  const statusId = await defaultLeadStatus(orgId);
  const row: Record<string, unknown> = {
    organization_id: orgId,
    status_id: statusId,
    full_name: "ישראל ישראלי",
    ...fields,
  };
  const columns = Object.keys(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  return asUser(userId, async (q) => {
    const res = await q<{ id: string }>(
      `insert into public.leads (${columns.join(", ")}) values (${placeholders.join(", ")}) returning id`,
      Object.values(row),
    );
    return res.rows[0].id;
  });
}

export async function count(q: Query, sql: string, params: unknown[] = []): Promise<number> {
  const res = await q<{ n: string }>(`select count(*) as n from (${sql}) t`, params);
  return Number(res.rows[0].n);
}

/** Resolves to the Postgres error (with .code / .hint) the promise rejected with. */
export async function pgError(promise: Promise<unknown>): Promise<{ code?: string; hint?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; hint?: string; message: string };
  }
  throw new Error("expected the statement to fail, but it succeeded");
}
