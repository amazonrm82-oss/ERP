import { Badge } from "@/components/ui/badge";
import { RECORD_TYPES } from "@/lib/record-types";

import { previewIsEmpty, type TemplatePreview } from "../templates";

type Props = { preview: TemplatePreview; headingId: string };

/** What applying a template would add: one short list per kind, nothing about what is already there. */
export function TemplatePreviewList({ preview, headingId }: Props) {
  if (previewIsEmpty(preview)) {
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
