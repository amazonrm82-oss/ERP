// SGN-02, owner (224) ב: a document template marks a section the sender may not edit with a line "::: נעול" before it and a
// line ":::" after it (each alone on its line; spaces around it allowed). Sections do not nest; at most 20; none is empty.
// The markers are never sent: the document is the template's lines without them. Pure; mirrored by
// app.document_locked_segments (migration signature_documents); both run tests/unit/fixtures/document-locked-sections.json.

export const LOCKED_OPEN = "::: נעול";
export const LOCKED_CLOSE = ":::";
export const LOCKED_MAX = 20;

export type LockedProblem = "unclosed" | "stray" | "nested" | "empty" | "too_many";
export type DocumentSegment = { locked: boolean; text: string };
export type LockedSplit = { problem: LockedProblem; segments?: undefined } | { problem: null; segments: DocumentSegment[] };

export const LOCKED_PROBLEM_MESSAGES: Record<LockedProblem, string> = {
  unclosed: "קטע נעול נפתח ולא נסגר. אחרי הקטע כותבים שורה עם ::: בלבד.",
  stray: "יש שורה ::: בלי שורת ::: נעול לפניה.",
  nested: "קטע נעול נפתח בתוך קטע נעול אחר. סוגרים את הראשון לפני שפותחים קטע חדש.",
  empty: "קטע נעול ריק. כותבים בתוכו טקסט, או מוחקים את שתי שורות הסימון.",
  too_many: `אפשר עד ${LOCKED_MAX} קטעים נעולים בתבנית.`,
};

const OPEN_LINE = /^:::[ \t]*נעול$/;
const trimLine = (line: string) => line.replace(/^[ \t]+|[ \t]+$/g, "");

/** The template's lines in runs, locked or free, without the marker lines; or the first problem. */
export function lockedSegments(body: string): LockedSplit {
  if (body === "") return { problem: null, segments: [] };
  const segments: DocumentSegment[] = [];
  let run: string[] = [];
  let open = false;
  let sections = 0;
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const mark = trimLine(line);
    if (OPEN_LINE.test(mark)) {
      if (open) return { problem: "nested" };
      if (run.length > 0) segments.push({ locked: false, text: run.join("\n") });
      run = [];
      open = true;
      sections += 1;
      if (sections > LOCKED_MAX) return { problem: "too_many" };
    } else if (mark === LOCKED_CLOSE) {
      if (!open) return { problem: "stray" };
      if (!run.some((part) => trimLine(part) !== "")) return { problem: "empty" };
      segments.push({ locked: true, text: run.join("\n") });
      run = [];
      open = false;
    } else {
      run.push(line);
    }
  }
  if (open) return { problem: "unclosed" };
  if (run.length > 0) segments.push({ locked: false, text: run.join("\n") });
  return { problem: null, segments };
}

/** The template's text without the marker lines (what a document made from it reads), or the body itself when malformed. */
export function withoutLockMarks(body: string): string {
  const split = lockedSegments(body);
  return split.problem === null ? split.segments.map((segment) => segment.text).join("\n") : body;
}
