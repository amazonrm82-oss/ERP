"use server";

import { revalidatePath } from "next/cache";

import { fail, ok, type ActionResult } from "@/lib/action-result";
import { sessionCheck } from "@/lib/auth";
import { dbErrorMessage, SESSION_EXPIRED } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

const NOT_FOUND = "הפריט כבר לא מופיע במפת הדרכים. רעננו את הדף.";

/** TRU-01: an owner or admin casts (vote = true) or takes back the business's one vote on a roadmap item. */
export async function roadmapVoteAction(orgId: string, itemId: string, vote: boolean): Promise<ActionResult<{ votes: number; voted: boolean }>> {
  if (!isUuid(orgId) || !isUuid(itemId) || typeof vote !== "boolean") return fail(SESSION_EXPIRED);
  if (!(await sessionCheck()).ok) return fail(SESSION_EXPIRED);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("roadmap_vote", { p_org: orgId, p_item: itemId, p_vote: vote });
  if (error) return fail(error.code === "P0002" ? NOT_FOUND : dbErrorMessage(error));
  const answer = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  revalidatePath(paths.orgRoadmap(orgId));
  return ok({ votes: Number(answer.votes) || 0, voted: answer.voted === true });
}
