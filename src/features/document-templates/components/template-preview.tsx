"use client";

import { useState, useTransition } from "react";

import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SearchPicker, type SearchPickerChoice } from "@/components/ui/search-picker";

import { documentPreviewAction, searchDocumentRecordsAction, type DocumentPreviewRecord } from "../actions";
import { fillDocument, unfilledDocumentFields } from "../fields";
import type { DocumentTemplate } from "../queries";
import { DOCUMENT_KIND_LABELS } from "../templates";
import { DocumentSegments } from "./document-segments";
import { DRAFT_LINE, type RecordTypeLabels } from "./templates-editor";

type Props = {
  orgId: string;
  templates: DocumentTemplate[];
  /** the business's merge values (businessDocumentValues) */
  business: Record<string, string>;
  labels: RecordTypeLabels;
};

/**
 * SGN-01: preview a template on a real record the user picks. The record is read with the user's session; the document is
 * filled here in the browser and nothing is sent, signed or saved. A field the record has no value for stays as it is.
 */
export function DocumentTemplatePreview({ orgId, templates, business, labels }: Props) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [record, setRecord] = useState<DocumentPreviewRecord | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const template = templates.find((item) => item.id === templateId) ?? null;

  function onTemplate(id: string) {
    const next = templates.find((item) => item.id === id);
    // a record of another type does not fill this template
    if (next && template && next.recordType !== template.recordType) setRecord(null);
    setTemplateId(id);
  }

  function onPick(choice: SearchPickerChoice) {
    setFailure(null);
    if (!choice || !template) {
      setRecord(null);
      return;
    }
    const type = template.recordType;
    startTransition(async () => {
      const result = await documentPreviewAction(orgId, type, choice.id);
      if (result.ok && result.data) setRecord(result.data);
      else {
        setRecord(null);
        setFailure(result.ok ? null : result.message);
      }
    });
  }

  const filled = template ? fillDocument(template.body, { ...business, ...(record?.values ?? {}) }, record?.gender ?? null) : "";
  const unfilled = template ? unfilledDocumentFields(filled, template.recordType) : [];

  return (
    <div className="space-y-3">
      <h3 className="font-semibold">תצוגה מקדימה על רשומה</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="תבנית" value={templateId} onChange={(event) => onTemplate(event.target.value)}>
          {templates.map((item) => (
            <option key={item.id} value={item.id}>
              {`${item.name} (${DOCUMENT_KIND_LABELS[item.kind]})`}
            </option>
          ))}
        </SelectField>
        {template ? (
          <SearchPicker
            key={template.recordType}
            label={labels[template.recordType]}
            name="preview_record"
            initial={null}
            search={(query) => searchDocumentRecordsAction(orgId, template.recordType, query)}
            onChange={onPick}
          />
        ) : null}
      </div>
      <FormError message={failure} />
      {template?.draftWording ? <p className="text-sm text-ink-soft">{DRAFT_LINE}</p> : null}
      {template ? (
        <div className="rounded-md border border-line bg-canvas px-3 py-3" aria-live="polite" aria-busy={pending}>
          <DocumentSegments text={filled} />
        </div>
      ) : null}
      {!record ? <p className="text-sm text-ink-soft">בחרו רשומה כדי לראות את המסמך עם הפרטים שלה. בלי רשומה מוצגים רק פרטי העסק.</p> : null}
      {unfilled.length > 0 ? <p className="text-sm text-ink-soft">{`שדות שאין להם ערך: ${unfilled.join(", ")}`}</p> : null}
      <p className="text-sm text-ink-soft">התצוגה לא נשמרת ולא נשלחת לאף אחד. שליחה לחתימה נעשית מכרטיס הרשומה.</p>
    </div>
  );
}
