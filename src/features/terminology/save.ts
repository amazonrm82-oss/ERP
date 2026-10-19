// FLD-10: how the business's words are saved. Update first, insert only when there is no row yet.
// Not an upsert: PostgREST's ON CONFLICT ... DO UPDATE also sets organization_id, and clients may
// update only the three word columns (column grants), so every save after the first one failed.

export type TermValues = { contact_term: string | null; lead_term: string | null; deal_term: string | null };

type DbError = { code?: string; message: string } | null;
type Rows = { data: { id: string }[] | null; error: DbError };

/** The two calls the save needs, so the flow can be tested without a database. */
export type TermsWriter = {
  update(orgId: string, values: TermValues): PromiseLike<Rows>;
  insert(orgId: string, values: TermValues): PromiseLike<Rows>;
};

export type SaveTermsResult = { ok: true } | { ok: false; error: DbError };

/**
 * Update the business's row; when none came back (no row yet, or not permitted), insert it. A first
 * save racing another first save hits the unique key (23505): then the row exists, so update once more.
 * Zero rows at the end means not permitted (RLS), answered as an error with code 42501.
 */
export async function saveTerms(writer: TermsWriter, orgId: string, values: TermValues): Promise<SaveTermsResult> {
  const updated = await writer.update(orgId, values);
  if (updated.error) return { ok: false, error: updated.error };
  if ((updated.data ?? []).length > 0) return { ok: true };

  const inserted = await writer.insert(orgId, values);
  if (inserted.error?.code === "23505") {
    const again = await writer.update(orgId, values);
    if (again.error) return { ok: false, error: again.error };
    return (again.data ?? []).length > 0 ? { ok: true } : { ok: false, error: { code: "42501", message: "not permitted" } };
  }
  if (inserted.error) return { ok: false, error: inserted.error };
  return (inserted.data ?? []).length > 0 ? { ok: true } : { ok: false, error: { code: "42501", message: "not permitted" } };
}
