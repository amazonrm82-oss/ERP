"use client";

import { useState, useTransition } from "react";

import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SearchPicker, type SearchPickerChoice } from "@/components/ui/search-picker";

import { previewPersonAction, searchPreviewRecordsAction, type PreviewPerson } from "../actions";
import { marketingEnvelope, MARKETING_UNSUBSCRIBE_TOKEN } from "../envelope";
import { fillMessage, unfilledMergeFields, type MergeValues } from "../fields";
import type { MessageTemplate } from "../queries";
import { smsLengthWarning, TEMPLATE_CHANNEL_LABELS } from "../templates";

type Props = {
  orgId: string;
  templates: MessageTemplate[];
  userName: string;
  businessName: string;
  // what the business has today (TAX-02 document details, else the organization's phone); null = not set
  businessPhone: string | null;
  businessAddress: string | null;
};

/**
 * MSG-02: preview a template on a real lead or contact the user picks. The record is read with the user's session;
 * nothing is sent or saved. Fields the record has no value for (a meeting's date, a quote link) stay as they are.
 */
export function TemplatePreview({ orgId, templates, userName, businessName, businessPhone, businessAddress }: Props) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [person, setPerson] = useState<PreviewPerson | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const template = templates.find((item) => item.id === templateId) ?? null;

  function onPick(choice: SearchPickerChoice) {
    setFailure(null);
    if (!choice) {
      setPerson(null);
      return;
    }
    startTransition(async () => {
      const result = await previewPersonAction(orgId, choice.id);
      if (result.ok && result.data) setPerson(result.data);
      else {
        setPerson(null);
        setFailure(result.ok ? null : result.message);
      }
    });
  }

  const values: MergeValues = {
    userName,
    businessName,
    businessPhone,
    businessAddress,
    ...(person
      ? {
          firstName: person.firstName,
          fullName: person.fullName,
          gender: person.gender,
        }
      : {}),
  };
  // MSG-02 (owner (88)): a marketing message is shown as it would go out, with the parts the system adds
  const envelope = template ? marketingEnvelope(template) : null;
  const subject = envelope?.subject ? fillMessage(envelope.subject, values) : null;
  const body = envelope ? fillMessage(envelope.body, values) : "";
  const noUnsubscribeYet = body.includes(MARKETING_UNSUBSCRIBE_TOKEN);
  const unfilled = template ? unfilledMergeFields(`${subject ?? ""}\n${body}`) : [];
  const smsWarning = template?.channel === "sms" ? smsLengthWarning(body) : null;

  return (
    <div className="space-y-3">
      <h3 className="font-semibold">תצוגה מקדימה על רשומה</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="תבנית" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
          {templates.map((item) => (
            <option key={item.id} value={item.id}>
              {`${item.name} (${TEMPLATE_CHANNEL_LABELS[item.channel]})`}
            </option>
          ))}
        </SelectField>
        <SearchPicker
          label="ליד או איש קשר"
          name="preview_record"
          initial={null}
          search={(query) => searchPreviewRecordsAction(orgId, query)}
          onChange={onPick}
        />
      </div>
      <FormError message={failure} />
      {template ? (
        <div className="space-y-2 rounded-md border border-line bg-canvas px-3 py-3" aria-live="polite" aria-busy={pending}>
          {subject !== null ? (
            <p className="text-md text-ink">
              <span className="font-medium">נושא: </span>
              <span className="break-words">{subject}</span>
            </p>
          ) : null}
          <p className="break-words whitespace-pre-wrap text-md text-ink">{body}</p>
        </div>
      ) : null}
      {!person ? <p className="text-sm text-ink-soft">בחרו רשומה כדי לראות את ההודעה עם השם שלה. בלי רשומה מוצגים רק השם שלכם ושם העסק.</p> : null}
      {unfilled.length > 0 ? <p className="text-sm text-ink-soft">{`שדות שהשולח ימלא בזמן השליחה: ${unfilled.join(", ")}`}</p> : null}
      {template?.messageType === "marketing" ? (
        <p className="text-sm text-ink-soft">
          בהודעה שיווקית המערכת מוסיפה לבד את המילה ״פרסומת״, את פרטי העסק ואת שורת ההסרה מרשימת התפוצה, ואי אפשר להוריד אותם מהתבנית.
        </p>
      ) : null}
      {noUnsubscribeYet ? <p className="text-sm text-ink-soft">עוד אין קישור הסרה במערכת. הוא יתווסף כשתיבנה השליחה.</p> : null}
      {smsWarning ? <p className="text-sm text-ink-soft">{smsWarning}</p> : null}
    </div>
  );
}
