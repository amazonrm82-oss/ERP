import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { NoteText } from "@/features/activities/components/note-text";

import type { CustomFieldDisplay } from "../values";

/**
 * A custom field's value as a card, a list or the board shows it: a link, a coloured status (FLD-06, a palette
 * tone), rich text (FLD-06, REC-04's Markdown rendered as React elements, never HTML; `compact` shows its words
 * only), or plain text.
 */
export function customFieldValue(field: CustomFieldDisplay, options: { compact?: boolean } = {}): ReactNode {
  if (field.href && field.text) {
    return (
      <a href={field.href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-4">
        {field.text.replace(/^https?:\/\//, "")}
        <span className="sr-only"> (נפתח בחלון חדש)</span>
      </a>
    );
  }
  if (field.tone && field.text) return <Badge tone={field.tone}>{field.text}</Badge>;
  if (field.markdown && !options.compact) return <NoteText text={field.markdown} />;
  return field.text;
}
