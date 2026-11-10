"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, buttonClasses, IconButton } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Input, Label, SelectField, TextareaField } from "@/components/ui/field";
import { ArrowDownIcon, ArrowUpIcon, ChatIcon, CheckIcon, ChevronDownIcon, LockIcon, MailIcon, PhoneIcon } from "@/components/ui/icons";
import { SidePanel } from "@/components/ui/side-panel";
import { QuickNote } from "@/features/activities/components/quick-note";
import { movedToWorkingDayNotice } from "@/features/calendar-days/rest-day-note";
import { RequiredFieldsDialog, type RequiredAsk } from "@/features/custom-fields/components/required-fields-dialog";
import { isMoveRefusal } from "@/features/custom-fields/required-move";
import { DisqualifyReasonField } from "@/features/disqualify-reasons/components/reason-field";
import { inlineEditAction } from "@/features/inline-edit/actions";
import { LeadStatusMenu } from "@/features/leads/components/lead-status-menu";
import { TakeLeadButton } from "@/features/leads/components/take-lead-button";
import { WaitingClock } from "@/features/leads/components/waiting-clock";
import type { LeadStatusOption } from "@/features/leads/queries";
import { takeLeadAction } from "@/features/leads/take-actions";
import { moveAsk } from "@/features/record-move/ask";
import { moveRecordAction } from "@/features/record-move/actions";
import { RecordTaskForm } from "@/features/tasks/components/record-task-form";
import { WhatsappButton } from "@/features/whatsapp/components/whatsapp-button";
import type { TemplateValues } from "@/features/whatsapp/templates";
import { cn } from "@/lib/cn";

import { peekCallBackAction, peekLogCallAction } from "../actions";
import type { CallBackPick, PeekAskedField, PeekRights } from "../model";

export type PeekPanelLead = {
  id: string;
  name: string;
  phone: string | null;
  phoneE164: string | null;
  tel: string | null;
  whatsapp: string | null;
  email: string | null;
  status: { id: string; name: string; tone: BadgeTone } | null;
  statuses: LeadStatusOption[];
  disqualifiedStatusId: string | null;
  ownerId: string | null;
  ownerName: string | null;
  sourceName: string | null;
  createdAt: string;
  // null while the waiting chip shows (owner (214) ב (7))
  createdAgo: string | null;
  waiting: boolean;
  waitingInitial: string;
  asked: PeekAskedField[];
  timeline: Array<{ id: string; label: string; text: string; when: string; author: string | null; isPrivate: boolean; href: string }>;
};

type Props = {
  orgId: string;
  lead: PeekPanelLead;
  rights: PeekRights;
  reasons: string[];
  // who the lead can be handed to; null when this person may not hand it over
  owners: Array<{ value: string; label: string }> | null;
  closeHref: string;
  fullHref: string;
  previousHref: string | null;
  nextHref: string | null;
  // "לחזור ב…": the business's working days, worked out on the server
  callBack: { hour: CallBackPick; tomorrow: CallBackPick; week: CallBackPick } | null;
  whatsappValues: TemplateValues;
};

type Section = "status" | "owner" | "call" | "note" | "task" | null;
type CallChoice = "answered" | "no_answer" | "call_back" | "not_relevant" | null;

const CALL_CHOICES: Array<{ value: Exclude<CallChoice, null>; label: string }> = [
  { value: "answered", label: "ענה" },
  { value: "no_answer", label: "לא ענה" },
  { value: "call_back", label: "לחזור ב…" },
  { value: "not_relevant", label: "לא רלוונטי" },
];

/** Typing in a field, or a window of its own open: the arrows and Escape belong to it, not to the panel. */
function keyBelongsElsewhere(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return true;
  if (document.querySelector("dialog:modal:not([data-side-panel])")) return true;
  // an open popover (bell, filters, columns) closes on its own Escape
  return Array.from(document.querySelectorAll('[role="dialog"]:not([hidden])')).some((node) => !node.closest("[data-side-panel]") && node.tagName !== "DIALOG");
}

/**
 * UX-01 (owner's answers 214-218, 10 November 2026): the lead side panel. Beside the list on a computer (the list stays
 * active), a bottom sheet on a phone. ?peek=<id> in the address; ↑ / ↓ move through the list, Escape closes. Every
 * write goes with the user's session through the lead page's own actions; a lead offered only to take shows its
 * details and "לקחתי", and call / WhatsApp / email take it first (216 ב).
 */
export function LeadPeekPanel({ orgId, lead, rights, reasons, owners, closeHref, fullHref, previousHref, nextHref, callBack, whatsappValues }: Props) {
  const router = useRouter();
  const [, startNavigation] = useTransition();
  const [section, setSection] = useState<Section>(null);
  const [call, setCall] = useState<CallChoice>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const go = (href: string) => startNavigation(() => router.replace(href, { scroll: false }));
  const refresh = () => router.refresh();

  // another lead in the panel starts with every menu closed
  const [shownId, setShownId] = useState(lead.id);
  if (shownId !== lead.id) {
    setShownId(lead.id);
    setSection(null);
    setCall(null);
    setMessage(null);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || keyBelongsElsewhere(event)) return;
      const target = event.key === "ArrowUp" ? previousHref : event.key === "ArrowDown" ? nextHref : event.key === "Escape" ? closeHref : null;
      if (!target) return;
      event.preventDefault();
      startNavigation(() => router.replace(target, { scroll: false }));
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [previousHref, nextHref, closeHref, router]);

  const toggle = (what: Exclude<Section, null>) => setSection((current) => (current === what ? null : what));
  const subject = { kind: "lead" as const, id: lead.id };

  return (
    <SidePanel
      open
      onClose={() => go(closeHref)}
      title={lead.name}
      subtitle={lead.phone ? <span dir="ltr" className="inline-block">{lead.phone}</span> : null}
      footer={
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1">
            <IconButton
              label="הליד הקודם (חץ למעלה)"
              icon={<ArrowUpIcon className="size-5" />}
              variant="secondary"
              disabled={!previousHref}
              onClick={() => previousHref && go(previousHref)}
            />
            <IconButton label="הליד הבא (חץ למטה)" icon={<ArrowDownIcon className="size-5" />} variant="secondary" disabled={!nextHref} onClick={() => nextHref && go(nextHref)} />
          </div>
          <Link href={fullHref} className={buttonClasses("secondary", "md")}>
            לדף המלא
          </Link>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {/* (1) reach the person; status and owner, or "לקחתי" */}
        <section aria-label="פרטי קשר וסטטוס" className="flex flex-col gap-3">
          <ReachButtons
            orgId={orgId}
            lead={lead}
            takeFirst={rights.canTake && lead.ownerId === null}
            logged={rights.canLog}
            whatsappValues={whatsappValues}
            onDialled={() => {
              // after a call, how it ended is one tap away (shown once the person may log it; after taking, too)
              setSection("call");
              setCall(null);
            }}
            onTaken={refresh}
          />

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {rights.canEdit && lead.status ? (
              <button
                type="button"
                aria-expanded={section === "status"}
                onClick={() => toggle("status")}
                className="inline-flex min-h-11 items-center rounded-full"
                aria-label={`סטטוס: ${lead.status.name}. לשינוי`}
              >
                <Badge tone={lead.status.tone} className="gap-1 text-sm">
                  {lead.status.name}
                  <ChevronDownIcon className="size-3.5" />
                </Badge>
              </button>
            ) : lead.status ? (
              <Badge tone={lead.status.tone}>{lead.status.name}</Badge>
            ) : null}
            {owners ? (
              <button
                type="button"
                aria-expanded={section === "owner"}
                onClick={() => toggle("owner")}
                className="inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-md hover:bg-canvas"
              >
                <span className="text-ink-soft">אחראי:</span> {lead.ownerName ?? (lead.ownerId ? "משתמש שאינו בעסק" : "אין")}
                <ChevronDownIcon className="size-3.5 text-ink-soft" />
              </button>
            ) : lead.ownerId ? (
              <span className="text-md">
                <span className="text-ink-soft">אחראי: </span>
                {lead.ownerName ?? "משתמש שאינו בעסק"}
              </span>
            ) : (
              <span className="text-md text-ink-soft">אין אחראי</span>
            )}
          </div>

          {section === "status" && lead.status ? (
            <div className="rounded-md border border-line bg-canvas p-3">
              <LeadStatusMenu
                key={lead.status.id}
                orgId={orgId}
                leadId={lead.id}
                leadName={lead.name}
                currentStatusId={lead.status.id}
                statuses={lead.statuses}
                reasons={reasons}
                onMoved={() => {
                  setSection(null);
                  refresh();
                }}
              />
            </div>
          ) : null}
          {section === "owner" && owners ? (
            <OwnerPicker
              orgId={orgId}
              leadId={lead.id}
              current={lead.ownerId}
              owners={owners}
              onSaved={() => {
                setSection(null);
                refresh();
              }}
            />
          ) : null}

          {rights.canTake ? <TakeLeadButton orgId={orgId} leadId={lead.id} leadName={lead.name} /> : null}
          {rights.mode === "take_only" ? (
            <p role="status" className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-md text-warning">
              <LockIcon className="mt-0.5 size-4.5 shrink-0" />
              כדי לטפל בליד, קחו אותו קודם
            </p>
          ) : null}
        </section>

        {/* (2) what they asked for */}
        {lead.asked.length > 0 ? (
          <section aria-labelledby="peek-asked" className="flex flex-col gap-2">
            <h3 id="peek-asked" className="text-md font-semibold">
              מה ביקש
            </h3>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-md">
              {lead.asked.map((field) => (
                <div key={field.key} className="contents">
                  <dt className="text-ink-soft">{field.label}</dt>
                  <dd className={cn("min-w-0 break-words", field.key === "message" && "line-clamp-4 whitespace-pre-line")}>
                    {field.ltr ? <span dir="ltr">{field.text}</span> : field.text}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {/* (3) where from, how long ago, the waiting clock */}
        <section aria-label="מקור וזמן" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft">
          <span>{lead.sourceName ? `מקור: ${lead.sourceName}` : "בלי מקור"}</span>
          {lead.createdAgo ? <span>נכנס לפני {lead.createdAgo}</span> : null}
          {lead.waiting ? (
            <Badge tone="warning" className="text-sm">
              לא נענה&nbsp;
              <WaitingClock since={lead.createdAt} initial={lead.waitingInitial} />
            </Badge>
          ) : null}
        </section>

        {/* (4) the actions; a lead offered only to take has none (answer 187 ב) */}
        {rights.canLog ? (
          <section aria-label="פעולות" className="flex flex-col gap-3">
            <div className="grid grid-cols-3 gap-2">
              <Button variant={section === "call" ? "primary" : "secondary"} aria-expanded={section === "call"} onClick={() => toggle("call")}>
                <PhoneIcon className="size-4.5 max-sm:hidden" />
                התקשרתי
              </Button>
              <Button variant={section === "note" ? "primary" : "secondary"} aria-expanded={section === "note"} onClick={() => toggle("note")}>
                הערה
              </Button>
              <Button variant={section === "task" ? "primary" : "secondary"} aria-expanded={section === "task"} onClick={() => toggle("task")}>
                משימה
              </Button>
            </div>

            {section === "call" ? (
              <div className="rounded-md border border-line bg-canvas p-3">
                <p id="peek-call-q" className="mb-2 text-md font-medium">
                  איך הסתיימה השיחה?
                </p>
                <div role="group" aria-labelledby="peek-call-q" className="grid grid-cols-2 gap-2">
                  {CALL_CHOICES.filter((choice) => choice.value !== "not_relevant" || (rights.canEdit && lead.disqualifiedStatusId)).map((choice) => (
                    <Button
                      key={choice.value}
                      variant={call === choice.value ? "primary" : "secondary"}
                      aria-pressed={call === choice.value}
                      onClick={() => {
                        setCall(choice.value);
                        setMessage(null);
                      }}
                    >
                      {call === choice.value ? <CheckIcon className="size-4.5" /> : null}
                      {choice.label}
                    </Button>
                  ))}
                </div>
                {call === "answered" || call === "no_answer" ? (
                  <CallOutcomeForm
                    key={call}
                    outcome={call}
                    save={(note) => peekLogCallAction(orgId, lead.id, lead.name, call, note)}
                    onSaved={() => {
                      setSection(null);
                      setCall(null);
                      setMessage({ ok: true, text: "השיחה נרשמה בציר הזמן." });
                      refresh();
                    }}
                  />
                ) : null}
                {call === "call_back" && callBack ? (
                  <CallBackForm
                    picks={callBack}
                    save={(date, time, note) => peekCallBackAction(orgId, lead.id, lead.name, date, time, note)}
                    onSaved={(text) => {
                      setSection(null);
                      setCall(null);
                      setMessage({ ok: true, text });
                      refresh();
                    }}
                  />
                ) : null}
                {call === "not_relevant" && lead.disqualifiedStatusId ? (
                  <NotRelevantForm
                    orgId={orgId}
                    leadId={lead.id}
                    leadName={lead.name}
                    statusId={lead.disqualifiedStatusId}
                    reasons={reasons}
                    onSaved={() => {
                      setSection(null);
                      setCall(null);
                      setMessage({ ok: true, text: "השיחה נרשמה והליד סומן כלא רלוונטי." });
                      refresh();
                    }}
                  />
                ) : null}
              </div>
            ) : null}

            {section === "note" ? (
              <div className="rounded-md border border-line bg-canvas p-3">
                <QuickNote key={lead.id} orgId={orgId} subject={subject} onSaved={refresh} />
              </div>
            ) : null}

            {section === "task" ? (
              <div className="rounded-md border border-line bg-canvas p-3">
                <RecordTaskForm key={lead.id} orgId={orgId} subject={subject} onSaved={refresh} />
              </div>
            ) : null}
            {message ? message.ok ? <FormNotice message={message.text} /> : <FormError message={message.text} /> : null}
          </section>
        ) : null}

        {/* (5) the last five timeline items, each opening the full page at that entry (owner (214) ב (8)) */}
        <section aria-labelledby="peek-timeline" className="flex flex-col gap-2">
          <h3 id="peek-timeline" className="text-md font-semibold">
            אחרונים בציר הזמן
          </h3>
          {lead.timeline.length === 0 ? (
            <p className="text-md text-ink-soft">עוד אין כאן כלום.</p>
          ) : (
            <ol className="flex flex-col divide-y divide-line rounded-md border border-line">
              {lead.timeline.map((item) => (
                <li key={item.id}>
                  <Link href={item.href} className="block px-3 py-2 hover:bg-canvas focus-visible:bg-canvas">
                    <span className="flex flex-wrap items-center gap-x-2 text-sm text-ink-soft">
                      <span className="font-medium text-ink">{item.label}</span>
                      {item.isPrivate ? <LockIcon className="size-3.5" aria-label="פרטית" /> : null}
                      <span>{item.when}</span>
                      {item.author ? <span>· {item.author}</span> : null}
                    </span>
                    {item.text ? <span className="mt-0.5 line-clamp-2 block whitespace-pre-line break-words text-md">{item.text}</span> : null}
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </SidePanel>
  );
}

/**
 * Call, WhatsApp and email. On a lead nobody owns, each one takes the lead first (owner (216) ב): when someone else
 * took it, the message says so and nothing is dialled or opened.
 */
function ReachButtons({
  orgId,
  lead,
  takeFirst,
  logged,
  whatsappValues,
  onDialled,
  onTaken,
}: {
  orgId: string;
  lead: PeekPanelLead;
  takeFirst: boolean;
  logged: boolean;
  whatsappValues: TemplateValues;
  onDialled: () => void;
  onTaken: () => void;
}) {
  const [pending, startTake] = useTransition();
  const [refusal, setRefusal] = useState<string | null>(null);
  if (!lead.tel && !lead.whatsapp && !lead.email) return null;
  const classes = buttonClasses("secondary", "md", "flex-col gap-0.5 px-2 py-1.5 text-sm");

  function takeThen(open: () => void, popup: Window | null) {
    setRefusal(null);
    startTake(async () => {
      const answer = await takeLeadAction(orgId, lead.id);
      if (!answer.ok) {
        popup?.close();
        setRefusal(answer.message);
        return;
      }
      open();
      onTaken();
    });
  }

  const item = (key: string, href: string | null, label: ReactNode, icon: ReactNode, name: string, open: (popup: Window | null) => void, popup = false) =>
    href ? (
      takeFirst ? (
        <button
          key={key}
          type="button"
          className={classes}
          disabled={pending}
          aria-label={popup ? `${name} (לוקח את הליד קודם, נפתח בחלון חדש)` : `${name} (לוקח את הליד קודם)`}
          onClick={() => {
            // a new window opens only straight from the click: open it now, fill it after taking
            const win = popup ? window.open("", "_blank") : null;
            takeThen(() => open(win), win);
          }}
        >
          {icon}
          {label}
        </button>
      ) : (
        <a key={key} href={href} className={classes} aria-label={popup ? `${name} (נפתח בחלון חדש)` : name} target={popup ? "_blank" : undefined} rel={popup ? "noopener noreferrer" : undefined} onClick={key === "tel" ? () => setTimeout(onDialled, 300) : undefined}>
          {icon}
          {label}
        </a>
      )
    ) : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-2">
        {item("tel", lead.tel, "חיוג", <PhoneIcon className="size-5 text-accent" />, `חיוג אל ${lead.name}`, () => {
          window.location.assign(lead.tel!);
          setTimeout(onDialled, 300);
        })}
        {lead.whatsapp && lead.phoneE164 && logged && !takeFirst ? (
          // WA-01: the business's templates and the timeline entry, as on the lead's page
          <WhatsappButton phoneE164={lead.phoneE164} orgId={orgId} subject={{ kind: "lead", id: lead.id }} name={lead.name} values={whatsappValues} wide />
        ) : (
          item(
            "wa",
            lead.whatsapp,
            <span dir="ltr">WhatsApp</span>,
            <ChatIcon className="size-5 text-accent" />,
            `WhatsApp אל ${lead.name}`,
            (win) => {
              if (win) win.location.href = lead.whatsapp!;
              else window.open(lead.whatsapp!, "_blank", "noopener,noreferrer");
            },
            true,
          )
        )}
        {item("mail", lead.email ? `mailto:${lead.email}` : null, "אימייל", <MailIcon className="size-5 text-accent" />, `אימייל אל ${lead.name}`, () =>
          window.location.assign(`mailto:${lead.email}`),
        )}
      </div>
      {pending ? <p className="text-sm text-ink-soft">לוקחים את הליד…</p> : null}
      <FormError message={refusal} />
    </div>
  );
}

function OwnerPicker({ orgId, leadId, current, owners, onSaved }: { orgId: string; leadId: string; current: string | null; owners: Array<{ value: string; label: string }>; onSaved: () => void }) {
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-canvas p-3">
      <div className="flex items-end gap-2">
        <SelectField label="אחראי" controlSize="sm" value={value} onChange={(event) => setValue(event.target.value)} className="min-w-0 flex-1">
          <option value="">בלי אחראי</option>
          {owners.map((owner) => (
            <option key={owner.value} value={owner.value}>
              {owner.label}
            </option>
          ))}
        </SelectField>
        <Button
          size="sm"
          disabled={pending || value === (current ?? "")}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              // LST-06's rule: the user's session decides; 0 rows = not permitted
              const result = await inlineEditAction(orgId, "lead", leadId, "owner", { id: value || null });
              if (result.ok) onSaved();
              else setError(result.message);
            })
          }
        >
          {pending ? "שומרים…" : "שמירה"}
        </Button>
      </div>
      <FormError message={error} />
    </div>
  );
}

function CallOutcomeForm({ outcome, save, onSaved }: { outcome: "answered" | "no_answer"; save: (note: string | null) => Promise<{ ok: boolean; message?: string }>; onSaved: () => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="mt-3 flex flex-col gap-2">
      {outcome === "answered" ? (
        // owner (214) ב (6): a short note with "ענה", optional
        <TextareaField label="הערה קצרה (לא חובה)" rows={2} maxLength={5000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="מה סוכם בשיחה?" />
      ) : null}
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const result = await save(note.trim() || null);
              if (result.ok) onSaved();
              else setError(result.message ?? null);
            })
          }
        >
          {pending ? "שומרים…" : "שמירת השיחה"}
        </Button>
      </div>
      <FormError message={error} />
    </div>
  );
}

function CallBackForm({
  picks,
  save,
  onSaved,
}: {
  picks: { hour: CallBackPick; tomorrow: CallBackPick; week: CallBackPick };
  save: (date: string, time: string, note: string | null) => Promise<{ ok: boolean; message?: string }>;
  onSaved: (message: string) => void;
}) {
  // owner (214) ב (5): the next working day at 10:00 to start with
  const [date, setDate] = useState(picks.tomorrow.date);
  const [time, setTime] = useState(picks.tomorrow.time);
  const [moved, setMoved] = useState(picks.tomorrow.moved ? picks.tomorrow.date : null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const choose = (pick: CallBackPick) => {
    setDate(pick.date);
    setTime(pick.time);
    setMoved(pick.moved ? pick.date : null);
  };
  return (
    <div className="mt-3 flex flex-col gap-3">
      <div role="group" aria-label="קיצורים" className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => choose(picks.hour)}>
          בעוד שעה
        </Button>
        <Button size="sm" variant="secondary" onClick={() => choose(picks.tomorrow)}>
          מחר
        </Button>
        <Button size="sm" variant="secondary" onClick={() => choose(picks.week)}>
          בעוד שבוע
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <DateField
          label="תאריך"
          value={date}
          onChange={(day) => {
            setDate(day);
            setMoved(null);
          }}
        />
        <div>
          <Label htmlFor="peek-back-time">שעה</Label>
          <Input id="peek-back-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        </div>
      </div>
      {moved ? <p className="text-sm text-ink-soft">{movedToWorkingDayNotice(moved)}</p> : null}
      <p className="text-sm text-ink-soft">תיווצר משימת &quot;לחזור&quot; עם תזכורת בזמן הזה.</p>
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const result = await save(date, time, null);
              if (result.ok) onSaved(moved ? `השיחה נרשמה ונוספה משימת "לחזור". ${movedToWorkingDayNotice(moved)}.` : 'השיחה נרשמה ונוספה משימת "לחזור".');
              else setError(result.message ?? null);
            })
          }
        >
          {pending ? "שומרים…" : "שמירה"}
        </Button>
      </div>
      <FormError message={error} />
    </div>
  );
}

/**
 * "לא רלוונטי" (owner (214) ב (4)): the reason from the business's active list first (RVW-9), then the call and the
 * move to the "not relevant" status through moveRecord, which also asks for fields the status makes required.
 */
function NotRelevantForm({
  orgId,
  leadId,
  leadName,
  statusId,
  reasons,
  onSaved,
}: {
  orgId: string;
  leadId: string;
  leadName: string;
  statusId: string;
  reasons: string[];
  onSaved: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [ask, setAsk] = useState<RequiredAsk | null>(null);
  const logCall = async () => {
    const logged = await peekLogCallAction(orgId, leadId, leadName, "answered", null);
    if (logged.ok) onSaved();
    else setError(`הליד סומן כלא רלוונטי, אבל השיחה לא נרשמה: ${logged.message}`);
  };
  return (
    <div className="mt-3 flex flex-col gap-2">
      <DisqualifyReasonField reasons={reasons} label={`למה הליד ${leadName} לא רלוונטי?`} value={reason} onChange={setReason} />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={pending || !reason.trim()}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const why = reason.trim();
              const result = await moveRecordAction(orgId, "lead", leadId, statusId, why, null);
              if (result.ok) {
                await logCall();
              } else if (isMoveRefusal(result)) {
                setAsk(
                  moveAsk({
                    orgId,
                    object: "lead",
                    id: leadId,
                    targetId: statusId,
                    description: `הליד ${leadName} עובר לסטטוס לא רלוונטי`,
                    reason: why,
                    reasons,
                    reasonLabel: `למה הליד ${leadName} לא רלוונטי?`,
                    refusal: result,
                    onSaved: () => void logCall(),
                  }),
                );
              } else {
                setError(result.message);
              }
            })
          }
        >
          {pending ? "שומרים…" : "שמירה"}
        </Button>
      </div>
      <FormError message={error} />
      <RequiredFieldsDialog ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}
