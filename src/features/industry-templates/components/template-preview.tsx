import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/format";
import { RECORD_TYPES } from "@/lib/record-types";

import { kitPreviewIsEmpty, type KitPreview } from "../kits";
import { previewIsEmpty, type TemplatePreview } from "../templates";

// kit: VRT-01, a kit's extras (null for an FLD-05 template)
type Props = { preview: TemplatePreview; kit?: KitPreview | null; headingId: string };

/** What applying a template would add: one short list per kind, nothing about what is already there. */
export function TemplatePreviewList({ preview, kit = null, headingId }: Props) {
  if (previewIsEmpty(preview) && kitPreviewIsEmpty(kit)) {
    return <p className="text-sm text-ink-soft">כל מה שבתבנית הזו כבר קיים אצלכם. אין מה להוסיף.</p>;
  }
  const groups: Array<{ title: string; names: string[] }> = [
    {
      title: preview.pipeline?.isNew ? `תהליך מכירה חדש: ${preview.pipeline.name}` : preview.pipeline ? `שלבים חדשים ב${preview.pipeline.name}` : "",
      names: preview.stages,
    },
    { title: "סטטוסים של ליד", names: preview.statuses },
    { title: "מקורות לידים", names: preview.sources },
    { title: "שדות", names: preview.fields.map((f) => `${f.label} (${RECORD_TYPES[f.object_type].singular})`) },
    { title: "אוטומציות (נוספות כבויות)", names: preview.automations },
    // FLD-05: sample products, with the price before VAT (the business changes them in the catalog)
    {
      title: 'מוצרים לדוגמה (מחיר לפני מע"מ)',
      names: preview.products.map((p) => `${p.name}: ${formatMoney(p.price_agorot)}${p.billing === "monthly" ? " לחודש" : ""}`),
    },
    // VRT-01: a kit's extras
    { title: "סוגי פגישות", names: kit?.meetingTypes ?? [] },
    { title: "תבניות הודעה (נוסח טיוטה)", names: kit?.messageTemplates ?? [] },
    { title: "תבניות וואטסאפ", names: kit?.whatsappTemplates ?? [] },
    { title: "טופס לידים (נוסף כבוי)", names: kit?.form ? [kit.form] : [] },
    { title: "תצוגות שמורות של לידים", names: kit?.views ?? [] },
  ].filter((g) => g.title && g.names.length > 0);

  return (
    <ul className="space-y-3" aria-labelledby={headingId}>
      {groups.map((group) => (
        <li key={group.title}>
          <h4 className="mb-1.5 text-sm font-medium">{group.title}</h4>
          <ul className="flex flex-wrap gap-1.5" aria-label={group.title}>
            {group.names.map((name, index) => (
              <li key={`${index}-${name}`} className="max-w-full">
                <Badge className="max-w-full truncate">{name}</Badge>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
