"use server";

import { revalidatePath } from "next/cache";

import {
  isRoadmapStatus,
  parseRequestIds,
  ROADMAP_DESCRIPTION_MAX,
  ROADMAP_REQUESTS_MAX,
  ROADMAP_SORT_MAX,
  ROADMAP_SORT_MIN,
  ROADMAP_TITLE_MAX,
} from "@/features/roadmap/items";
import { fail, formValues, type FormState } from "@/lib/action-result";
import { sessionCheck } from "@/lib/auth";
import { SESSION_EXPIRED } from "@/lib/errors";
import { isUuid, paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

function roadmapError(error: { code?: string }): string {
  if (error.code === "42501") return "אין לכם הרשאה לפעולה הזו, או שהאימות הדו-שלבי פג. התחברו מחדש ונסו שוב.";
  if (error.code === "22023") return "הנתונים אינם תקינים: בדקו את הכותרת, התיאור, המצב או מזהי הפניות.";
  if (error.code === "P0002") return "הפריט לא נמצא.";
  return "הפעולה נכשלה. נסו שוב.";
}

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
};

type Fields = { title: string; description: string; status: string; published: boolean; sortOrder: number; requestIds: string[] };

function readFields(formData: FormData): { ok: true; fields: Fields } | { ok: false; message: string } {
  const title = text(formData, "title").replace(/\s+/g, " ");
  if (title === "" || title.length > ROADMAP_TITLE_MAX) return { ok: false, message: `יש לכתוב כותרת של עד ${ROADMAP_TITLE_MAX} תווים.` };
  const description = text(formData, "description");
  if (description === "" || description.length > ROADMAP_DESCRIPTION_MAX) {
    return { ok: false, message: `יש לכתוב תיאור של עד ${ROADMAP_DESCRIPTION_MAX.toLocaleString("he-IL")} תווים.` };
  }
  const status = text(formData, "status");
  if (!isRoadmapStatus(status)) return { ok: false, message: "יש לבחור מצב." };
  const sortText = text(formData, "sort_order") || "0";
  const sortOrder = Number(sortText);
  if (!Number.isInteger(sortOrder) || sortOrder < ROADMAP_SORT_MIN || sortOrder > ROADMAP_SORT_MAX) {
    return { ok: false, message: "הסדר צריך להיות מספר שלם." };
  }
  const requests = parseRequestIds(text(formData, "request_ids"));
  if (requests.rest !== "") return { ok: false, message: "ברשימת הפניות יש טקסט שאינו מזהה פנייה." };
  if (requests.ids.length > ROADMAP_REQUESTS_MAX) return { ok: false, message: `אפשר לקשר עד ${ROADMAP_REQUESTS_MAX} פניות.` };
  return { ok: true, fields: { title, description, status, published: formData.get("published") === "on", sortOrder, requestIds: requests.ids } };
}

/** TRU-01: the platform owner or support adds a roadmap item (Mexuz wording only). */
export async function addRoadmapItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  if (!(await sessionCheck()).ok) return fail(SESSION_EXPIRED);
  const values = formValues(formData);
  const read = readFields(formData);
  if (!read.ok) return fail(read.message, { values });
  const f = read.fields;
  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_add_roadmap_item", {
    p_title: f.title,
    p_description: f.description,
    p_status: f.status,
    p_published: f.published,
    p_sort_order: f.sortOrder,
    p_request_ids: f.requestIds,
  });
  if (error) return fail(roadmapError(error), { values });
  revalidatePath(paths.adminRoadmap);
  return { ok: true, message: "הפריט נשמר." };
}

/** TRU-01: the platform owner or support changes an item; the id travels as a hidden field. */
export async function updateRoadmapItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  if (!(await sessionCheck()).ok) return fail(SESSION_EXPIRED);
  const id = text(formData, "id");
  if (!isUuid(id)) return fail(SESSION_EXPIRED);
  const values = formValues(formData);
  const read = readFields(formData);
  if (!read.ok) return fail(read.message, { values });
  const f = read.fields;
  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_update_roadmap_item", {
    p_id: id,
    p_title: f.title,
    p_description: f.description,
    p_status: f.status,
    p_published: f.published,
    p_sort_order: f.sortOrder,
    p_request_ids: f.requestIds,
  });
  if (error) return fail(roadmapError(error), { values });
  revalidatePath(paths.adminRoadmap);
  return { ok: true, message: "השינויים נשמרו." };
}
