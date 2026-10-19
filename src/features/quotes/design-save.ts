import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DesignValues = Omit<Database["public"]["Tables"]["quote_designs"]["Insert"], "organization_id">;
type Saved = { saved: boolean; error: PostgrestError | null };

/**
 * QUO-05: saves the business's one design row with the user's session. Not an upsert: PostgREST's ON CONFLICT DO UPDATE
 * also sets organization_id, which has no UPDATE grant, so every save after the first failed with 42501. The row is updated
 * first; only when there is none is it inserted, and an insert that lost a race to another save (23505) updates once more.
 * saved = false with no error: RLS let nothing through (not an owner or admin of a writable business).
 */
export async function saveQuoteDesignRow(supabase: SupabaseClient<Database>, orgId: string, values: DesignValues): Promise<Saved> {
  const update = () => supabase.from("quote_designs").update(values).eq("organization_id", orgId).select("organization_id");
  const first = await update();
  if (first.error) return { saved: false, error: first.error };
  if (first.data.length > 0) return { saved: true, error: null };
  const inserted = await supabase.from("quote_designs").insert({ organization_id: orgId, ...values }).select("organization_id");
  if (!inserted.error) return { saved: inserted.data.length > 0, error: null };
  if (inserted.error.code !== "23505") return { saved: false, error: inserted.error };
  const again = await update();
  if (again.error) return { saved: false, error: again.error };
  return { saved: again.data.length > 0, error: null };
}
