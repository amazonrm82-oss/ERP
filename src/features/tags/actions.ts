"use server";

import { revalidatePath } from "next/cache";

import { tagSchema } from "@/features/customization/schema";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { TAGGABLE, type Taggable } from "./types";

const TABLE = { lead: "leads", contact: "contacts", company: "companies", deal: "deals" } as const;
const PAGE = { lead: paths.lead, contact: paths.contact, company: paths.company, deal: paths.deal } as const;

function revalidateTags(orgId: string) {
  revalidatePath(paths.settingsTags(orgId));
  revalidatePath(paths.org(orgId), "layout");
}

const DUPLICATE = "כבר קיימת תגית בשם הזה.";

export async function createTagAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = tagSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { error } = await context.supabase.from("tags").insert({ organization_id: orgId, name: parsed.data.name });
  if (error) {
    return fail(error.code === "23505" ? DUPLICATE : dbErrorMessage(error, "לא הצלחנו ליצור את התגית. נסו שוב."), {
      values: formValues(formData),
    });
  }
  revalidateTags(orgId);
  return { ok: true };
}

/** Admins rename any tag; others only the tags they created (RLS). */
export async function renameTagAction(orgId: string, tagId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, tagId);
  if (!context.ok) {
    return context;
  }
  const parsed = tagSchema.safeParse(pick(formData, ["name"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const { data, error } = await context.supabase
    .from("tags")
    .update({ name: parsed.data.name })
    .eq("organization_id", orgId)
    .eq("id", tagId)
    .select("id");
  if (error) {
    return fail(error.code === "23505" ? DUPLICATE : dbErrorMessage(error), { values: formValues(formData) });
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateTags(orgId);
  return { ok: true };
}

/** Deletes the tag. Records keep the id in tag_ids; screens skip ids of tags that no longer exist. */
export async function deleteTagAction(orgId: string, tagId: string): Promise<ActionResult> {
  const context = await actionContext(orgId, tagId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.from("tags").delete().eq("organization_id", orgId).eq("id", tagId).select("id");
  if (error) {
    return fail(dbErrorMessage(error));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidateTags(orgId);
  return ok();
}

/**
 * Sets the tags of a record from the picker: the checked tags, plus a new tag
 * typed in (created, or reused when a tag with that name exists).
 */
export async function saveRecordTagsAction(
  orgId: string,
  kind: Taggable,
  recordId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!TAGGABLE.includes(kind)) {
    return fail(NOT_FOUND);
  }
  const context = await actionContext(orgId, recordId);
  if (!context.ok) {
    return context;
  }
  const checked = formData.getAll("tag_id").filter((value): value is string => isUuid(value));
  const newName = String(formData.get("new_tag") ?? "").trim();

  const { data: orgTags, error: tagsError } = await context.supabase.from("tags").select("id, name").eq("organization_id", orgId);
  if (tagsError) {
    return fail(dbErrorMessage(tagsError));
  }
  const known = new Set(orgTags.map((tag) => tag.id));
  const tagIds = checked.filter((id) => known.has(id));

  if (newName) {
    const parsed = tagSchema.safeParse({ name: newName });
    if (!parsed.success) {
      return invalid(parsed.error, formData);
    }
    const existing = orgTags.find((tag) => tag.name.toLowerCase() === parsed.data.name.toLowerCase());
    if (existing) {
      tagIds.push(existing.id);
    } else {
      const { data: created, error } = await context.supabase
        .from("tags")
        .insert({ organization_id: orgId, name: parsed.data.name })
        .select("id")
        .single();
      if (error) {
        return fail(dbErrorMessage(error, "לא הצלחנו ליצור את התגית. נסו שוב."), { values: formValues(formData) });
      }
      tagIds.push(created.id);
    }
  }

  const { data, error } = await context.supabase
    .from(TABLE[kind] as "leads")
    .update({ tag_ids: [...new Set(tagIds)] })
    .eq("organization_id", orgId)
    .eq("id", recordId)
    .select("id");
  if (error) {
    return fail(dbErrorMessage(error, "לא הצלחנו לשמור את התגיות. נסו שוב."));
  }
  if (data.length === 0) {
    return fail(NOT_FOUND_OR_FORBIDDEN);
  }
  revalidatePath(PAGE[kind](orgId, recordId));
  revalidatePath(paths.settingsTags(orgId));
  return { ok: true };
}
