import { NoteText } from "@/features/activities/components/note-text";

import { lockedSegments } from "../locked";

/**
 * SGN-02, owner (224) ב: a template's text (or a preview of it) with its locked sections marked; the marker lines are not
 * shown. A text whose markers are malformed is shown as it is.
 */
export function DocumentSegments({ text }: { text: string }) {
  const split = lockedSegments(text);
  if (split.problem !== null || !split.segments.some((segment) => segment.locked)) return <NoteText text={text} className="text-md text-ink" />;
  return (
    <div className="space-y-2">
      {split.segments.map((segment, index) =>
        segment.locked ? (
          <div key={index} className="rounded-md border border-line bg-surface px-3 py-2">
            <p className="mb-1 text-sm font-medium text-ink-soft">קטע נעול: השולח לא יכול לערוך אותו</p>
            <NoteText text={segment.text} className="text-md text-ink" />
          </div>
        ) : (
          <NoteText key={index} text={segment.text} className="text-md text-ink" />
        ),
      )}
    </div>
  );
}
