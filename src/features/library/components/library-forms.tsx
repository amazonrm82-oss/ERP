"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateField } from "@/components/ui/date-picker";
import { Dialog } from "@/components/ui/dialog";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { ACCEPT, FILES_BUCKET } from "@/features/files/types";
import type { ActionResult, FormState } from "@/lib/action-result";
import { createClient } from "@/lib/supabase/client";

import {
  addLibraryCategoryAction,
  createLibraryItemAction,
  deleteLibraryCategoryAction,
  deleteLibraryItemAction,
  finishLibraryFileAction,
  prepareLibraryFileAction,
  renameLibraryCategoryAction,
  updateLibraryItemAction,
} from "../actions";

export type CategoryOption = { id: string; name: string };
type Kind = "link" | "file";
type Values = Partial<Record<"title" | "description" | "category_id" | "url" | "valid_from" | "valid_until" | "is_active", string>>;

/** Uploads a file item's file: a row on the server, the object straight to Storage, then the server checks what arrived. */
async function uploadLibraryFile(orgId: string, itemId: string, file: File): Promise<string | null> {
  const prepared = await prepareLibraryFileAction(orgId, itemId, { name: file.name, size: file.size, type: file.type || "application/octet-stream" });
  if (!prepared.ok) return prepared.message;
  const { error } = await createClient().storage.from(FILES_BUCKET).upload(prepared.path, file, { contentType: file.type, upsert: false });
  const finished = await finishLibraryFileAction(orgId, prepared.id, !error);
  if (error) return `ההעלאה של ${file.name} נכשלה. נסו שוב.`;
  return finished.ok ? null : finished.message;
}

function ItemFields({ kind, categories, values, errors }: { kind: Kind; categories: CategoryOption[]; values: Values; errors?: Record<string, string> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField label="שם" name="title" required maxLength={120} autoComplete="off" defaultValue={values.title ?? ""} error={errors?.title} className="sm:col-span-2" />
      {kind === "link" ? (
        <TextField
          label="קישור"
          name="url"
          required
          dir="ltr"
          inputMode="url"
          autoComplete="off"
          maxLength={2000}
          defaultValue={values.url ?? ""}
          error={errors?.url}
          hint="קישור מאובטח (https), למשל לסרטון או למצגת אונליין."
          className="sm:col-span-2"
        />
      ) : null}
      <SelectField label="קטגוריה" name="category_id" defaultValue={values.category_id ?? ""} error={errors?.category_id}>
        <option value="">בלי קטגוריה</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </SelectField>
      <TextareaField label="תיאור" name="description" maxLength={500} rows={2} defaultValue={values.description ?? ""} error={errors?.description} className="sm:col-span-2" />
      <DateField label="בתוקף מ-" name="valid_from" defaultValue={values.valid_from ?? ""} error={errors?.valid_from} />
      <DateField label="בתוקף עד" name="valid_until" defaultValue={values.valid_until ?? ""} error={errors?.valid_until} hint="אחרי התאריך הפריט נשאר בספרייה ומסומן שפג תוקפו." />
      <Checkbox label="פעיל" name="is_active" defaultChecked={values.is_active === "on"} hint="פריט כבוי נשאר בספרייה ולא מוצע לשליחה." className="sm:col-span-2" />
    </div>
  );
}

/** LIB-01: the two "new" buttons of the library page: a link, or a file. */
export function NewLibraryItem({ orgId, categories }: { orgId: string; categories: CategoryOption[] }) {
  const router = useRouter();
  const fileInputId = useId();
  const [kind, setKind] = useState<Kind | null>(null);
  const [pending, setPending] = useState(false);
  const [state, setState] = useState<FormState<{ id: string }>>(null);
  const failure = state && !state.ok ? state : null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!kind) return;
    const formData = new FormData(event.currentTarget);
    const file = formData.get("file");
    formData.delete("file");
    if (kind === "file" && !(file instanceof File && file.size > 0)) {
      setState({ ok: false, message: "בחרו קובץ להעלאה.", fieldErrors: { file: "בחרו קובץ להעלאה." }, values: Object.fromEntries([...formData].map(([k, v]) => [k, String(v)])) });
      return;
    }
    setPending(true);
    const created = await createLibraryItemAction(orgId, kind, null, formData);
    if (created?.ok && created.data && kind === "file" && file instanceof File) {
      const problem = await uploadLibraryFile(orgId, created.data.id, file);
      if (problem) {
        // the item is saved; its file can be added again from its row
        setPending(false);
        setState({ ok: false, message: `הפריט נשמר, אבל הקובץ לא עלה: ${problem}` });
        router.refresh();
        return;
      }
    }
    setPending(false);
    if (created?.ok) {
      setKind(null);
      setState(null);
      router.refresh();
    } else {
      setState(created);
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setKind("link")}>קישור חדש</Button>
        <Button variant="secondary" onClick={() => setKind("file")}>
          קובץ חדש
        </Button>
      </div>
      <Dialog
        open={kind !== null}
        onClose={() => {
          setKind(null);
          setState(null);
        }}
        title={kind === "file" ? "קובץ חדש בספרייה" : "קישור חדש בספרייה"}
      >
        {kind ? (
          <form onSubmit={(e) => void submit(e)} className="space-y-3" noValidate>
            <ItemFields kind={kind} categories={categories} values={failure?.values ?? { is_active: "on" }} errors={failure?.fieldErrors} />
            {kind === "file" ? (
              <div>
                <label htmlFor={fileInputId} className="mb-1.5 block text-sm font-medium text-ink">
                  קובץ
                </label>
                <input id={fileInputId} name="file" type="file" accept={ACCEPT} className="block w-full text-sm" aria-describedby={`${fileInputId}-hint`} />
                <p id={`${fileInputId}-hint`} className="mt-1.5 text-sm text-ink-soft">
                  עד 25 MB: PDF, תמונות, Word, Excel, PowerPoint, טקסט, CSV או ZIP. הקובץ נספר בנפח האחסון של החבילה.
                </p>
                {failure?.fieldErrors?.file ? <p className="mt-1.5 text-sm text-danger">{failure.fieldErrors.file}</p> : null}
              </div>
            ) : null}
            <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
            <div className="flex gap-2">
              <SubmitButton pending={pending}>שמירה</SubmitButton>
              <Button
                variant="ghost"
                onClick={() => {
                  setKind(null);
                  setState(null);
                }}
              >
                ביטול
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}

export type EditableItem = {
  id: string;
  kind: Kind;
  title: string;
  description: string | null;
  categoryId: string | null;
  url: string | null;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
  hasFile: boolean;
};

/** Changing, replacing the file of, or removing one item, from its row. */
export function LibraryItemActions({ orgId, item, categories }: { orgId: string; item: EditableItem; categories: CategoryOption[] }) {
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await updateLibraryItemAction(orgId, item.id, item.kind, prev, formData);
    if (result?.ok) setOpen(false);
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const values: Values = failure?.values ?? {
    title: item.title,
    description: item.description ?? "",
    category_id: item.categoryId ?? "",
    url: item.url ?? "",
    valid_from: item.validFrom ?? "",
    valid_until: item.validUntil ?? "",
    is_active: item.isActive ? "on" : "",
  };

  async function replace(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setUploadError(await uploadLibraryFile(orgId, item.id, file));
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  return (
    <span className="flex flex-col items-start gap-1">
      <span className="flex flex-wrap gap-1">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          עריכה
        </Button>
        {item.kind === "file" ? (
          <label
            htmlFor={inputId}
            className={`inline-flex min-h-10 cursor-pointer items-center rounded-md px-3 text-sm font-medium text-accent-strong hover:bg-canvas focus-within:outline-2 ${uploading ? "pointer-events-none opacity-60" : ""}`}
          >
            {uploading ? "מעלים…" : item.hasFile ? "החלפת קובץ" : "צירוף קובץ"}
            <span className="sr-only">: {item.title}</span>
            <input ref={inputRef} id={inputId} type="file" accept={ACCEPT} disabled={uploading} className="sr-only" onChange={(e) => void replace(e.target.files?.[0])} />
          </label>
        ) : null}
        <ConfirmButton
          title="למחוק את הפריט?"
          description={item.kind === "file" ? "הפריט והקובץ שלו יימחקו מהספרייה." : "הפריט יימחק מהספרייה."}
          confirmLabel="מחיקה"
          action={deleteLibraryItemAction.bind(null, orgId, item.id)}
        >
          מחיקה
        </ConfirmButton>
      </span>
      {uploadError ? (
        <span role="alert" className="text-sm text-danger">
          {uploadError}
        </span>
      ) : null}
      <Dialog open={open} onClose={() => setOpen(false)} title="עריכת פריט">
        <form action={formAction} className="space-y-3" noValidate>
          <ItemFields kind={item.kind} categories={categories} values={values} errors={failure?.fieldErrors} />
          <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
          <div className="flex gap-2">
            <SubmitButton pending={pending}>שמירה</SubmitButton>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              ביטול
            </Button>
          </div>
        </form>
      </Dialog>
    </span>
  );
}

/** Copies a link item's address, and says so. */
export function CopyLinkButton({ url, title }: { url: string; title: string }) {
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={() => void copy()}>
        העתקת קישור
        <span className="sr-only">: {title}</span>
      </Button>
      <span role="status" className="text-sm text-ink-soft">
        {copied === "done" ? "הקישור הועתק" : copied === "failed" ? "לא הצלחנו להעתיק. אפשר לסמן את הקישור ולהעתיק ידנית." : ""}
      </span>
    </span>
  );
}

/** Owners and admins: add, rename and delete the categories (a managed list). */
export function LibraryCategories({ orgId, categories, counts }: { orgId: string; categories: CategoryOption[]; counts: Record<string, number> }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(addLibraryCategoryAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <div className="space-y-4">
      <ul className="divide-y divide-line">
        {categories.map((category) => (
          <li key={category.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="text-md text-ink">
              {category.name} <span className="text-sm text-ink-soft">({counts[category.id] ?? 0})</span>
            </span>
            <CategoryActions orgId={orgId} category={category} />
          </li>
        ))}
      </ul>
      <form action={formAction} className="flex flex-wrap items-end gap-2" noValidate>
        <TextField label="קטגוריה חדשה" name="name" maxLength={60} autoComplete="off" defaultValue={failure?.values?.name ?? ""} error={failure?.fieldErrors?.name} />
        <SubmitButton pending={pending} variant="secondary">
          הוספה
        </SubmitButton>
      </form>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
    </div>
  );
}

function CategoryActions({ orgId, category }: { orgId: string; category: CategoryOption }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await renameLibraryCategoryAction(orgId, category.id, prev, formData);
    if (result?.ok) setOpen(false);
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const remove: () => Promise<ActionResult> = deleteLibraryCategoryAction.bind(null, orgId, category.id);
  return (
    <span className="flex flex-wrap gap-1">
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        שינוי שם
        <span className="sr-only">: {category.name}</span>
      </Button>
      <ConfirmButton title={`למחוק את הקטגוריה ${category.name}?`} description="הפריטים שבה יישארו בספרייה, בלי קטגוריה." confirmLabel="מחיקה" action={remove}>
        מחיקה
      </ConfirmButton>
      <Dialog open={open} onClose={() => setOpen(false)} title="שינוי שם קטגוריה">
        <form action={formAction} className="space-y-3" noValidate>
          <TextField label="שם" name="name" required maxLength={60} autoComplete="off" defaultValue={failure?.values?.name ?? category.name} error={failure?.fieldErrors?.name} />
          <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
          <div className="flex gap-2">
            <SubmitButton pending={pending}>שמירה</SubmitButton>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              ביטול
            </Button>
          </div>
        </form>
      </Dialog>
    </span>
  );
}
