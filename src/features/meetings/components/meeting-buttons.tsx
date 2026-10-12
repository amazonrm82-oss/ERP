"use client";

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog } from "@/components/ui/dialog";
import { PencilIcon, PlusIcon } from "@/components/ui/icons";
import { FormError, FormNotice } from "@/components/ui/feedback";
import type { TimelineSubject } from "@/features/activities/schema";

import { deleteMeetingAction } from "../actions";
import { MeetingForm, type MeetingFormValues, type MemberOption } from "./meeting-form";
import { MeetingStatusForm } from "./meeting-status-form";

type Common = { orgId: string; subject: TimelineSubject; members: MemberOption[]; timeZone: string };

/** "פגישה חדשה" on a record's meetings card: the form opens as a sheet on a phone. */
export function NewMeetingButton({ orgId, subject, members, timeZone, initial }: Common & { initial: MeetingFormValues }) {
  const [open, setOpen] = useState(false);
  // the app has no toast region yet: a short notice under the button says it worked
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const saved = useCallback((message?: string) => {
    setOpen(false);
    setNotice(message ? null : "הפגישה נקבעה.");
    setWarning(message ?? null);
  }, []);
  return (
    <div>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          setNotice(null);
          setWarning(null);
          setOpen(true);
        }}
      >
        <PlusIcon className="size-4" />
        פגישה חדשה
      </Button>
      <Dialog open={open} onClose={close} title="פגישה חדשה" variant="sheet">
        {open ? <MeetingForm orgId={orgId} subject={subject} initial={initial} members={members} timeZone={timeZone} onDone={saved} onCancel={close} /> : null}
      </Dialog>
      <FormNotice message={notice} className="mt-2" />
      <FormError message={warning} className="mt-2" />
    </div>
  );
}

type ItemProps = Omit<Common, "subject"> & {
  // null: a meeting opened from the calendar that is on no record (an internal meeting)
  subject: TimelineSubject | null;
  meetingId: string;
  title: string;
  status: string;
  outcome: string;
  initial: MeetingFormValues;
  // the calendar closes its own window after a change: what was done, and a warning (participants not saved)
  onChanged?: (change: MeetingChange, message?: string) => void;
};

/** What was done to a meeting from its buttons. */
export type MeetingChange = "edit" | "status" | "delete";

/** The two things done to a meeting after it is set: say how it went, or change its details. */
export function MeetingItemButtons({ orgId, subject, members, timeZone, meetingId, title, status, outcome, initial, onChanged }: ItemProps) {
  const [open, setOpen] = useState<"status" | "edit" | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const saved = useCallback(
    (change: MeetingChange, message?: string) => {
      setOpen(null);
      setWarning(message ?? null);
      onChanged?.(change, message);
    },
    [onChanged],
  );
  const edited = useCallback((message?: string) => saved("edit", message), [saved]);
  return (
    <div className="flex flex-wrap gap-2">
      <FormError message={warning} className="w-full" />
      <Button size="sm" variant="secondary" onClick={() => setOpen("status")}>
        {status === "planned" ? "איך הייתה הפגישה?" : "עדכון סטטוס"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen("edit")}>
        <PencilIcon className="size-4" />
        עריכה
        <span className="sr-only">: {title}</span>
      </Button>
      <Dialog open={open === "status"} onClose={close} title="סטטוס ותוצאה" description={title} variant="sheet">
        {open === "status" ? (
          <MeetingStatusForm orgId={orgId} meetingId={meetingId} subject={subject} status={status} outcome={outcome} onDone={() => saved("status")} onCancel={close} />
        ) : null}
      </Dialog>
      <Dialog open={open === "edit"} onClose={close} title="עריכת הפגישה" variant="sheet">
        {open === "edit" ? (
          <div className="space-y-5">
            <MeetingForm orgId={orgId} subject={subject} meetingId={meetingId} initial={initial} members={members} timeZone={timeZone} onDone={edited} onCancel={close} />
            <div className="border-t border-line pt-4">
              <ConfirmButton
                title="למחוק את הפגישה?"
                description="המחיקה סופית. פגישה שלא התקיימה אפשר לסמן כ״בוטלה״ במקום למחוק."
                confirmLabel="מחיקה"
                action={deleteMeetingAction.bind(null, orgId, meetingId, subject)}
                onDone={() => {
                  setOpen(null);
                  onChanged?.("delete");
                }}
              >
                מחיקת הפגישה
              </ConfirmButton>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
