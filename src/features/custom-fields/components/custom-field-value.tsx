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
  // FLD-06 part B: a linked record or a field's file, inside the app
  if (field.internalHref && field.text) {
    return (
      <a href={field.internalHref} className="text-accent-strong underline underline-offset-4">
        {field.text}
      </a>
    );
  }
  // FLD-06 part B: an address with its map links
  if (field.maps && field.text) {
    return (
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span>{field.text}</span>
        {options.compact ? null : (
          <span className="flex gap-3 text-sm">
            <a href={field.maps.waze} target="_blank" rel="noopener noreferrer" className="text-accent-strong underline underline-offset-4">
              Waze
              <span className="sr-only"> (נפתח בחלון חדש)</span>
            </a>
            <a href={field.maps.google} target="_blank" rel="noopener noreferrer" className="text-accent-strong underline underline-offset-4">
              Google Maps
              <span className="sr-only"> (נפתח בחלון חדש)</span>
            </a>
          </span>
        )}
      </span>
    );
  }
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
