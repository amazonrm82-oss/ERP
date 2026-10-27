"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";

import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, TextareaField } from "@/components/ui/field";
import { SearchPicker, type SearchPickerChoice } from "@/components/ui/search-picker";
import { addNoteAction } from "@/features/activities/actions";
import type { TimelineSubject } from "@/features/activities/schema";
import type { BillingPriceList } from "@/features/billing/queries";
import type { CompanyOption } from "@/features/companies/queries";
import { ContactForm } from "@/features/contacts/components/contact-form";
import type { FieldDefinition } from "@/features/custom-fields/types";
import { uploadFiles } from "@/features/files/upload-client";
import { LeadForm } from "@/features/leads/components/lead-form";
import type { LeadSourceOption, LeadStatusOption } from "@/features/leads/queries";
import type { RecordType } from "@/features/record-type-options/schema";
import { withPrefixThe, type OrgTerms, type TermForms } from "@/features/terminology/terms";
import { cn } from "@/lib/cn";
import { paths } from "@/lib/paths";

import { searchShareRecordsAction } from "../actions";
import { subjectFromPick } from "../records";
import {
  NOTE_MAX,
  noteStart,
  readStoredShare,
  recordPrefill,
  recordSavedLine,
  SHARE_ITEM_PREFIX,
  SHARE_PREVIEW_TYPES,
  SHARED_FROM_PHONE,
  shareChoices,
  sharedNoteBody,
  sharePrefill,
  type ShareChoice,
  type ShareParams,
  type SharedInput,
} from "../share";

export type ShareLeadForm = {
  statuses: LeadStatusOption[];
  sources: LeadSourceOption[];
  fields: FieldDefinition[];
  reasons: string[];
  products: boolean;
};

/** LEAD-08: with leads switched off the share offers a new contact instead (owner, 27 October 2026). */
export type ShareContactForm = {
  companies: CompanyOption[] | null;
  fields: FieldDefinition[];
  types: RecordType[];
  priceLists: BillingPriceList[];
};

type Loaded =
  | { state: "loading" }
  | { state: "gone" }
  | { state: "ready"; input: SharedInput; image: File | null; imageUrl: string | null; imageProblem: string | null };

const FALLBACK = "השיתוף לא נשמר. פתחו את האפליקציה פעם אחת ושתפו שוב.";
const GONE = "השיתוף כבר לא זמין במכשיר הזה. שתפו שוב מהאפליקציה שממנה שיתפתם.";

type Choice = ShareChoice;

const IMAGE_DROPPED = "התמונה לא הגיעה. שתפו אותה שוב.";
const IMAGE_REFUSED = "את התמונה הזאת אי אפשר לצרף: אפשר JPG, PNG, GIF, WEBP או HEIC עד 25 MB.";

function recordPath(orgId: string, subject: TimelineSubject): string {
  switch (subject.kind) {
    case "lead":
      return paths.lead(orgId, subject.id);
    case "contact":
      return paths.contact(orgId, subject.id);
    case "company":
      return paths.company(orgId, subject.id);
    default:
      return paths.deal(orgId, subject.id);
  }
}

/** Forget the share kept on this device (the service worker answers; no worker = nothing kept). */
function forgetShare(id: string | null): Promise<void> {
  if (!id) return Promise.resolve();
  return fetch(`${SHARE_ITEM_PREFIX}${id}`, { method: "DELETE", cache: "no-store" }).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * WAB-06: the share screen. The share is read from the service worker on this device (only its id is in the address),
 * tied to the signed-in person (`owner`, the SHA-256 of their id); then the person picks: a new lead prefilled (the
 * business's word), or a note on a record they find, with the image attached through the record's normal upload.
 * Everything is saved with the person's own session.
 */
export function ShareScreen({
  orgId,
  share,
  owner,
  terms,
  leadForm,
  contactForm,
}: {
  orgId: string;
  share: ShareParams;
  owner: string;
  terms: OrgTerms;
  leadForm: ShareLeadForm | null;
  contactForm: ShareContactForm | null;
}) {
  const [loaded, setLoaded] = useState<Loaded>(() => (share.s ? { state: "loading" } : { state: "gone" }));
  const [choice, setChoice] = useState<Choice | null>(leadForm || contactForm ? null : "note");

  useEffect(() => {
    if (!share.s) return;
    let cancelled = false;
    (async () => {
      try {
        const item = `${SHARE_ITEM_PREFIX}${share.s}`;
        const query = `?owner=${owner}`;
        const answer = await fetch(`${item}${query}`, { cache: "no-store" });
        const stored = answer.ok ? readStoredShare(await answer.json(), Date.now(), owner) : null;
        if (!stored) {
          if (!cancelled) setLoaded({ state: "gone" });
          return;
        }
        let image: File | null = null;
        if (stored.image) {
          const response = await fetch(`${item}/image${query}`, { cache: "no-store" });
          if (response.ok) {
            const blob = await response.blob();
            image = new File([blob], stored.image.name, { type: stored.image.type });
          }
        }
        if (!cancelled) {
          setLoaded({
            state: "ready",
            input: stored,
            image,
            // a local preview (a blob: address); the image is not uploaded before the person saves. HEIC is named instead
            imageUrl: image && SHARE_PREVIEW_TYPES.includes(image.type) ? URL.createObjectURL(image) : null,
            imageProblem: stored.imageRefused ? IMAGE_REFUSED : stored.image && !image ? IMAGE_DROPPED : null,
          });
        }
      } catch {
        if (!cancelled) setLoaded({ state: "gone" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [share.s, owner]);

  const imageUrl = loaded.state === "ready" ? loaded.imageUrl : null;
  useEffect(() => (imageUrl ? () => URL.revokeObjectURL(imageUrl) : undefined), [imageUrl]);

  if (share.failed || loaded.state === "gone") {
    return (
      <Card>
        <CardBody className="space-y-3">
          <p className="text-md">{share.fallback ? FALLBACK : GONE}</p>
          <ButtonLink href={paths.org(orgId)} variant="secondary">
            להיום שלי
          </ButtonLink>
        </CardBody>
      </Card>
    );
  }
  if (loaded.state === "loading") {
    return (
      <p role="status" className="text-ink-soft">
        טוענים את מה ששיתפתם…
      </p>
    );
  }

  return (
    <ShareChoices
      orgId={orgId}
      shareId={share.s}
      loaded={loaded}
      terms={terms}
      leadForm={leadForm}
      contactForm={contactForm}
      choice={choice}
      onChoice={setChoice}
    />
  );
}

function ShareChoices({
  orgId,
  shareId,
  loaded,
  terms,
  leadForm,
  contactForm,
  choice,
  onChoice,
}: {
  orgId: string;
  shareId: string | null;
  loaded: Extract<Loaded, { state: "ready" }>;
  terms: OrgTerms;
  leadForm: ShareLeadForm | null;
  contactForm: ShareContactForm | null;
  choice: Choice | null;
  onChoice: (choice: Choice) => void;
}) {
  const router = useRouter();
  const prefill = useMemo(() => sharePrefill(loaded.input), [loaded.input]);
  const groupId = useId();
  const [cancelling, setCancelling] = useState(false);
  const hasImage = loaded.image !== null;
  // after a new lead or contact is saved: the shared note on it (saving), or what was not saved (failed)
  const [after, setAfter] = useState<AfterSave | null>(null);
  // "לנסות שוב כהערה": the note form starts on the new record, with what is left to save
  const [retry, setRetry] = useState<{ pick: SearchPickerChoice; body: string; image: File | null } | null>(null);

  async function created(kind: "lead" | "contact", id: string, href: string) {
    const term = kind === "lead" ? terms.lead : terms.contact;
    const subject: TimelineSubject = { kind, id };
    const body = sharedNoteBody(prefill.note, hasImage);
    if (body === null) {
      // nothing shared to keep beside the phone or email the form already saved
      await forgetShare(shareId);
      router.push(href);
      return;
    }
    setAfter({ state: "saving", term, href });
    const form = new FormData();
    form.set("type", "note");
    form.set("body", body);
    const saved = await addNoteAction(orgId, subject, null, form).catch(() => null);
    const pick = { id: `${kind}:${id}`, label: term.newOne };
    if (!saved || !saved.ok) {
      setAfter({ state: "failed", term, href, problems: [saved?.message ?? NOTE_FAILED], pick, body, image: loaded.image });
      return;
    }
    const noteId = saved.data?.id;
    // REC-07: the image goes up as a file of this note, through the record's normal upload and its rules
    const problems = loaded.image && noteId ? await uploadFiles(orgId, subject, [loaded.image], { activityId: noteId }).catch(() => [UPLOAD_FAILED]) : [];
    if (problems.length > 0) {
      // the note is saved, the image is not: a retry adds only the image, under the same mark
      setAfter({ state: "failed", term, href, problems: [NOTE_SAVED_IMAGE_NOT, ...problems], pick, body: SHARED_FROM_PHONE, image: loaded.image });
      return;
    }
    // everything is saved: only now is the share forgotten on this device
    await forgetShare(shareId);
    router.push(href);
  }

  async function cancel() {
    setCancelling(true);
    await forgetShare(shareId);
    router.push(paths.org(orgId));
  }
  const labels: Record<Choice, { label: string; hint: string }> = {
    lead: { label: terms.lead.newOne, hint: "טופס חדש עם מה ששיתפתם" },
    contact: { label: terms.contact.newOne, hint: "טופס חדש עם מה ששיתפתם" },
    note: { label: "הערה לרשומה", hint: "לשמור על רשומה קיימת" },
  };
  const options = shareChoices(leadForm !== null)
    .filter((value) => value === "note" || (value === "lead" ? leadForm : contactForm))
    .map((value) => ({ value, ...labels[value] }));

  if (after) {
    return (
      <AfterSaveCard
        after={after}
        onRetry={(next) => {
          setRetry(next);
          setAfter(null);
          onChoice("note");
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <SharedPreview prefill={prefill.note} image={loaded.image} imageUrl={loaded.imageUrl} imageProblem={loaded.imageProblem} />
      {options.length > 1 ? (
        <fieldset className="space-y-2">
          <legend id={groupId} className="mb-2 font-medium">
            מה לעשות?
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {options.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex min-h-14 cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                  choice === option.value ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-canvas",
                )}
              >
                <input
                  type="radio"
                  name="share_choice"
                  value={option.value}
                  checked={choice === option.value}
                  onChange={() => onChoice(option.value)}
                  className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"
                />
                <span className="min-w-0">
                  <span className="block font-medium">{option.label}</span>
                  <span className="block text-sm text-ink-soft">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {choice === "lead" && leadForm ? (
        <Card>
          <CardBody className="space-y-4">
            <SavedAsNoteLine term={terms.lead} show={sharedNoteBody(prefill.note, hasImage) !== null} />
            <LeadForm
              orgId={orgId}
              {...leadForm}
              prefill={recordPrefill(prefill)}
              onCreated={(id) => void created("lead", id, paths.lead(orgId, id))}
            />
          </CardBody>
        </Card>
      ) : null}
      {choice === "contact" && contactForm ? (
        <Card>
          <CardBody className="space-y-4">
            <SavedAsNoteLine term={terms.contact} show={sharedNoteBody(prefill.note, hasImage) !== null} />
            <ContactForm
              orgId={orgId}
              {...contactForm}
              prefill={recordPrefill(prefill)}
              onCreated={({ id, channelsFailed }) =>
                void created("contact", id, channelsFailed ? `${paths.contact(orgId, id)}?channels=failed` : paths.contact(orgId, id))
              }
            />
          </CardBody>
        </Card>
      ) : null}
      {choice === "note" ? (
        <ShareNoteForm
          key={retry ? "retry" : "note"}
          orgId={orgId}
          shareId={shareId}
          note={retry ? retry.body : noteStart(prefill, hasImage)}
          image={retry ? retry.image : loaded.image}
          initial={retry?.pick ?? null}
        />
      ) : null}
      <div>
        <Button variant="ghost" onClick={cancel} loading={cancelling}>
          ביטול השיתוף
        </Button>
      </div>
    </div>
  );
}

const NOTE_FAILED = "לא הצלחנו לשמור את ההערה. נסו שוב.";
const UPLOAD_FAILED = "התמונה לא הועלתה. נסו שוב.";
const NOTE_SAVED_IMAGE_NOT = "ההערה נשמרה, אבל התמונה לא:";

type AfterSave =
  | { state: "saving"; term: TermForms; href: string }
  | { state: "failed"; term: TermForms; href: string; problems: string[]; pick: SearchPickerChoice; body: string; image: File | null };

/** Said above the new lead or contact form: what happens to the shared text and image (owner, 27 October 2026). */
function SavedAsNoteLine({ term, show }: { term: TermForms; show: boolean }) {
  if (!show) return null;
  return (
    <p className="rounded-md bg-canvas px-3 py-2.5 text-sm text-ink-soft">
      אחרי השמירה, מה ששיתפתם יישמר על {term.theSingular} כהערה &quot;{SHARED_FROM_PHONE}&quot;.
    </p>
  );
}

/**
 * After the new record is saved. While the note is saved: a status line. When the note or the image was not saved, the
 * record stays and the person is told plainly what was not saved; the share stays on the device for "לנסות שוב כהערה".
 */
function AfterSaveCard({
  after,
  onRetry,
}: {
  after: AfterSave;
  onRetry: (next: { pick: SearchPickerChoice; body: string; image: File | null }) => void;
}) {
  if (after.state === "saving") {
    return (
      <Card>
        <CardBody>
          <p role="status" className="text-md">
            {recordSavedLine(after.term)} שומרים גם את מה ששיתפתם…
          </p>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardBody className="space-y-3">
        <FormNotice message={recordSavedLine(after.term)} />
        <p className="text-md">מה ששיתפתם לא נשמר במלואו. השיתוף נשאר במכשיר הזה, ואפשר לנסות שוב.</p>
        {after.problems.map((problem) => (
          <FormError key={problem} message={problem} />
        ))}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onRetry({ pick: after.pick, body: after.body, image: after.image })}>לנסות שוב כהערה</Button>
          <ButtonLink href={after.href} variant="secondary">
            {withPrefixThe("ל", after.term)}
          </ButtonLink>
        </div>
      </CardBody>
    </Card>
  );
}

function SharedPreview({
  prefill,
  image,
  imageUrl,
  imageProblem,
}: {
  prefill: string;
  image: File | null;
  imageUrl: string | null;
  imageProblem: string | null;
}) {
  return (
    <Card>
      <CardBody className="space-y-3">
        <h2 className="font-medium">מה ששיתפתם</h2>
        {prefill ? <p className="text-md break-words whitespace-pre-line">{prefill}</p> : null}
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local blob: preview, nothing to optimize
          <img src={imageUrl} alt="התמונה ששיתפתם" className="max-h-60 max-w-full rounded-md border border-line object-contain" />
        ) : image ? (
          <p className="text-sm break-all text-ink-soft" dir="ltr">
            {image.name}
          </p>
        ) : null}
        {!prefill && !image ? <p className="text-ink-soft">לא הגיע טקסט. אפשר לכתוב אותו כאן למטה.</p> : null}
        {imageProblem ? <p className="text-sm text-ink-soft">{imageProblem}</p> : null}
      </CardBody>
    </Card>
  );
}

function ShareNoteForm({
  orgId,
  shareId,
  note,
  image,
  initial,
}: {
  orgId: string;
  shareId: string | null;
  note: string;
  image: File | null;
  initial: SearchPickerChoice;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<SearchPickerChoice>(initial);
  const [body, setBody] = useState(note);
  const [attach, setAttach] = useState(image !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ href: string; problems: string[] } | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    const subject = subjectFromPick(picked?.id);
    if (!subject) {
      setFieldErrors({ record: "יש לבחור רשומה." });
      return;
    }
    setBusy(true);
    const form = new FormData();
    form.set("type", "note");
    form.set("body", body);
    const saved = await addNoteAction(orgId, subject, null, form);
    if (!saved || !saved.ok) {
      setBusy(false);
      setError(saved?.message ?? "לא הצלחנו לשמור את ההערה. נסו שוב.");
      if (saved?.fieldErrors) setFieldErrors(saved.fieldErrors);
      return;
    }
    const noteId = saved.data?.id;
    // REC-07: the image goes up as a file of this note, through the record's normal upload and its rules
    const problems = image && attach && noteId ? await uploadFiles(orgId, subject, [image], { activityId: noteId }) : [];
    const href = recordPath(orgId, subject);
    if (problems.length === 0) {
      await forgetShare(shareId);
      setBusy(false);
      router.push(href);
      return;
    }
    // L1: the note is saved but the image is not: the share stays on the device for another try
    setBusy(false);
    setDone({ href, problems });
  }

  if (done) {
    return (
      <Card>
        <CardBody className="space-y-3">
          <FormNotice message="ההערה נשמרה." />
          {done.problems.map((problem) => (
            <FormError key={problem} message={problem} />
          ))}
          <ButtonLink href={done.href} variant="secondary">
            לרשומה
          </ButtonLink>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <form onSubmit={save} className="space-y-4" noValidate>
          <FormError message={error} />
          <SearchPicker
            label="לאיזו רשומה?"
            name="record"
            initial={initial}
            required
            clearable={false}
            search={(query) => searchShareRecordsAction(orgId, query)}
            onChange={setPicked}
            error={fieldErrors.record}
          />
          <TextareaField
            label="ההערה"
            name="body"
            rows={5}
            maxLength={NOTE_MAX}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            error={fieldErrors.body}
          />
          {image ? <Checkbox label="לצרף את התמונה להערה" checked={attach} onChange={(event) => setAttach(event.target.checked)} /> : null}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="submit" loading={busy}>
              שמירת ההערה
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
