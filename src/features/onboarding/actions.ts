"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { sessionCheck } from "@/lib/auth";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";
import { pick } from "@/lib/validation";

import { createOrganizationSchema } from "./schema";

export async function createOrganizationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await sessionCheck();
  if (!session.ok) {
    return fail(session.message);
  }

  const parsed = createOrganizationSchema.safeParse(pick(formData, ["name", "industry", "team_size", "phone"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const supabase = await createClient();
  // The only way an organization is created: the function also creates the
  // owner membership, the trial subscription and the default pipeline/statuses.
  const { data: orgId, error } = await supabase.rpc("create_organization", {
    p_name: parsed.data.name,
    p_industry: parsed.data.industry || null,
    p_team_size: parsed.data.team_size || null,
    p_phone: parsed.data.phone,
  });
  if (error || !orgId) {
    return fail(dbErrorMessage(error, "לא הצלחנו ליצור את העסק. נסו שוב."), { values: formValues(formData) });
  }

  revalidatePath("/", "layout");
  // the new business starts at step 1 of the setup wizard (USR-03; every step can be skipped)
  redirect(paths.setup(orgId));
}
