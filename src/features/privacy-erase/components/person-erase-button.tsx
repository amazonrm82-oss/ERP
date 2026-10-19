"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, TextareaField, TextField } from "@/components/ui/field";
import { ERASURE_PAUSED_MESSAGE } from "@/features/audit/erasure";

import { erasePersonAction, previewPersonEraseAction } from "../actions";
import {
  confirmsName,
  countLines,
  DEAL_NAME_MAX,
  familyOf,
  MATCHES_TRUNCATED,
  matchHint,
  notPreselected,
  REASON_MAX,
  type EraseKind,
  type EraseMatch,
  type ErasePreview,
} from "../erase";

type Props = { orgId: string; kind: EraseKind; id: string; listHref: string };

const matchKey = (m: Pick<EraseMatch, "type" | "id">) => `${m.type}:${m.id}`;

/**
 * PRV-03: an owner or admin removes the person from everywhere: this record, the records conversion links to it, and the
 * records of the same phone or email that stay ticked, with their files, inquiries and the person's details in the audit log
 * and in meetings. The window counts what goes, asks a new name for a deal that holds the person's name, a reason, and the
 * person's name to confirm.
 */
export function PersonEraseButton({ orgId, kind, id, listHref }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ErasePreview | null>(null);
  // the offered records, as first read (the list does not change when ticks change), and the ones unticked
  const [offered, setOffered] = useState<EraseMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [personRequest, setPersonRequest] = useState(true);
  const [dealNames, setDealNames] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ paused: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  const extraOf = (matches: EraseMatch[], off: Set<string>) => matches.filter((m) => !off.has(matchKey(m))).map((m) => ({ type: m.type, id: m.id }));

  function load(matches: EraseMatch[], off: Set<string>) {
    startTransition(async () => {
      const result = await previewPersonEraseAction(orgId, kind, id, extraOf(matches, off));
      if (!result.ok || !result.data) {
        setError(result.ok ? "לא הצלחנו לקרוא מה יימחק." : result.message);
        return;
      }
      const next = result.data;
      setPreview(next);
      // a deal that must be renamed starts with the suggestion; a name typed before stays
      setDealNames((names) => {
        const kept: Record<string, string> = {};
        for (const d of next.deals) if (d.mustRename) kept[d.id] = names[d.id] ?? d.suggested;
        return kept;
      });
    });
  }

  function openWindow() {
    setOpen(true);
    setError(null);
    setPreview(null);
    setOffered([]);
    setTruncated(false);
    setUnticked(new Set());
    setTyped("");
    setReason("");
    setDealNames({});
    startTransition(async () => {
      const first = await previewPersonEraseAction(orgId, kind, id, []);
      if (!first.ok || !first.data) {
        setError(first.ok ? "לא הצלחנו לקרוא מה יימחק." : first.message);
        return;
      }
      setOffered(first.data.matches);
      setTruncated(first.data.matchesTruncated);
      // an offered record starts ticked, unless its address is widely shared or it brings more records along
      const off = notPreselected(first.data.matches, matchKey);
      setUnticked(off);
      load(first.data.matches, off);
    });
  }

  function toggle(m: EraseMatch, ticked: boolean) {
    // a conversion family goes as one, so its records are ticked and unticked together
    const next = new Set(unticked);
    for (const one of [m, ...familyOf(offered, m)]) {
      if (ticked) next.delete(matchKey(one));
      else next.add(matchKey(one));
    }
    setUnticked(next);
    load(offered, next);
  }

  function erase() {
    if (!preview) return;
    setError(null);
    startTransition(async () => {
      const result = await erasePersonAction(orgId, kind, id, {
        confirmName: typed,
        personRequest,
        reason: reason.trim(),
        extra: extraOf(offered, unticked),
        dealNames: Object.fromEntries(Object.entries(dealNames).map(([k, v]) => [k, v.trim()])),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setDone({ paused: result.data?.paused ?? false });
    });
  }

  function close() {
    if (pending) return;
    setOpen(false);
    if (done) router.push(listHref);
  }

  const renames = preview?.deals.filter((d) => d.mustRename) ?? [];
  const others = preview?.deals.filter((d) => !d.mustRename) ?? [];
  const canErase =
    preview !== null &&
    !pending &&
    confirmsName(typed, preview) &&
    reason.trim().length > 0 &&
    renames.every((d) => (dealNames[d.id] ?? "").trim().length > 0);

  return (
    <>
      <Button variant="danger-ghost" size="sm" onClick={openWindow}>
        מחיקת האדם מכל המקומות
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title={done ? "האדם נמחק" : "למחוק את האדם מכל המקומות?"}
        description={done ? undefined : "המחיקה סופית ואי אפשר לבטל אותה. הפרטים נמחקים גם מיומן הפעולות."}
        footer={
          done ? (
            <Button variant="secondary" autoFocus onClick={close}>
              סיום
            </Button>
          ) : (
            <>
              <Button variant="secondary" autoFocus onClick={close} disabled={pending}>
                ביטול
              </Button>
              <Button variant="danger" onClick={erase} loading={pending && preview !== null} disabled={!canErase}>
                מחיקה לצמיתות
              </Button>
            </>
          )
        }
      >
        {done ? (
          <p className="text-md">{done.paused ? `הרשומות נמחקו. ${ERASURE_PAUSED_MESSAGE}` : "הרשומות נמחקו, והפרטים נמחקו מיומן הפעולות."}</p>
        ) : preview ? (
          <div className="space-y-5">
            <div className="space-y-1 text-sm">
              <p className="font-medium text-ink">יימחקו לצמיתות:</p>
              <ul className="list-disc space-y-0.5 ps-5 text-ink-soft">
                {preview.leads.map((r) => (
                  <li key={r.id}>
                    ליד: <bdi>{r.name}</bdi>
                    {r.inBin ? " (בסל המחזור)" : ""}
                  </li>
                ))}
                {preview.contacts.map((r) => (
                  <li key={r.id}>
                    איש קשר: <bdi>{r.name}</bdi>
                    {r.inBin ? " (בסל המחזור)" : ""}
                  </li>
                ))}
              </ul>
              <p className="pt-1 font-medium text-ink">בסך הכול:</p>
              <ul className="list-disc space-y-0.5 ps-5 text-ink-soft">
                {countLines(preview.counts).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="text-ink-soft">גיבובי ההסכמה וההסרה נשארים, כדי שלא יפנו לאדם שוב.</p>
            </div>

            {offered.length > 0 ? (
              <fieldset className="space-y-2 text-sm">
                <legend className="font-medium text-ink">רשומות עם אותו טלפון או אימייל</legend>
                <p className="text-ink-soft">המסומנות יימחקו. בטלו את הסימון לרשומה של אדם אחר, וסמנו רק רשומה של אותו אדם.</p>
                {offered.map((m) => (
                  <Checkbox
                    key={matchKey(m)}
                    label={`${m.type === "leads" ? "ליד" : "איש קשר"}: ${m.name}`}
                    hint={matchHint(
                      m,
                      familyOf(offered, m).map((o) => o.name),
                    )}
                    checked={!unticked.has(matchKey(m))}
                    disabled={pending}
                    onChange={(event) => toggle(m, event.currentTarget.checked)}
                  />
                ))}
                {truncated ? <p className="text-ink-soft">{MATCHES_TRUNCATED}</p> : null}
              </fieldset>
            ) : null}

            {renames.length > 0 ? (
              <div className="space-y-3 text-sm">
                <p className="font-medium text-ink">עסקאות שנשארות ושמן כולל את שם האדם, ולכן צריך שם חדש:</p>
                {renames.map((d) => (
                  <TextField
                    key={d.id}
                    label={`שם חדש במקום "${d.name}"`}
                    value={dealNames[d.id] ?? ""}
                    maxLength={DEAL_NAME_MAX}
                    required
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setDealNames((names) => ({ ...names, [d.id]: value }));
                    }}
                  />
                ))}
              </div>
            ) : null}
            {others.length > 0 ? (
              <div className="space-y-1 text-sm">
                <p className="font-medium text-ink">עסקאות שנשארות בלי איש הקשר:</p>
                <ul className="list-disc space-y-0.5 ps-5 text-ink-soft">
                  {others.map((d) => (
                    <li key={d.id}>
                      <bdi>{d.name}</bdi>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <TextareaField
              label="סיבת המחיקה"
              hint="נשמרת ביומן הפעולות. אל תכתבו בה את שם האדם."
              value={reason}
              maxLength={REASON_MAX}
              rows={2}
              required
              onChange={(event) => setReason(event.currentTarget.value)}
            />
            <Checkbox
              label="האדם ביקש את המחיקה"
              hint='הטלפון והאימייל שלו יירשמו ברשימת "לא לפנות".'
              checked={personRequest}
              onChange={(event) => setPersonRequest(event.currentTarget.checked)}
            />
            <TextField label="להקלדת שם האדם לאישור" value={typed} onChange={(event) => setTyped(event.currentTarget.value)} autoComplete="off" />
          </div>
        ) : pending ? (
          <p className="text-sm text-ink-soft">בודקים מה יימחק…</p>
        ) : null}
        <FormError message={error} />
      </Dialog>
    </>
  );
}
