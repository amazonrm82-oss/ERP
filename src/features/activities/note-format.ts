/**
 * REC-04: what the formatting buttons above a note do to its text. Pure functions on the
 * text and the selection, so they are tested without a browser.
 */

export type FormatKind = "bold" | "bullets" | "numbers" | "link";
export type Edit = { value: string; selectionStart: number; selectionEnd: number };

const BULLET = /^\s{0,3}[-*•]\s+/;
const NUMBER = /^\s{0,3}\d{1,6}[.)]\s+/;
const LINK_PLACEHOLDER = "https://";
const LINK_TEXT = "טקסט הקישור";

/** The whole lines a selection touches: start of the first, end of the last. */
function lineRange(value: string, start: number, end: number): [number, number] {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  // a selection that ends right after a line break does not include the next line
  const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const to = value.indexOf("\n", last);
  return [from, to < 0 ? value.length : to];
}

function prefixLines(value: string, start: number, end: number, kind: "bullets" | "numbers"): Edit {
  const [from, to] = lineRange(value, start, end);
  const lines = value.slice(from, to).split("\n");
  const marker = kind === "bullets" ? BULLET : NUMBER;
  const filled = lines.filter((line) => line.trim() !== "");
  const allMarked = filled.length > 0 && filled.every((line) => marker.test(line));
  let n = 0;
  const changed = lines.map((line) => {
    if (allMarked) return line.replace(marker, "");
    if (line.trim() === "" && lines.length > 1) return line;
    // a line already in the other kind of list switches over
    const bare = line.replace(BULLET, "").replace(NUMBER, "");
    n += 1;
    return `${kind === "bullets" ? "- " : `${n}. `}${bare}`;
  });
  const replacement = changed.join("\n");
  const next = value.slice(0, from) + replacement + value.slice(to);
  return { value: next, selectionStart: from + replacement.length, selectionEnd: from + replacement.length };
}

/** Applies one formatting button to the text and says what to select afterwards. */
export function applyFormat(value: string, selectionStart: number, selectionEnd: number, kind: FormatKind): Edit {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd, value.length));
  const end = Math.min(value.length, Math.max(selectionStart, selectionEnd));
  const selected = value.slice(start, end);

  if (kind === "bold") {
    // already bold around the selection: take the marks away
    if (start >= 2 && value.slice(start - 2, start) === "**" && value.slice(end, end + 2) === "**") {
      const next = value.slice(0, start - 2) + selected + value.slice(end + 2);
      return { value: next, selectionStart: start - 2, selectionEnd: end - 2 };
    }
    const next = `${value.slice(0, start)}**${selected}**${value.slice(end)}`;
    return { value: next, selectionStart: start + 2, selectionEnd: end + 2 };
  }

  if (kind === "link") {
    const text = selected.trim() === "" ? LINK_TEXT : selected.replace(/[[\]\n]/g, " ");
    const inserted = `[${text}](${LINK_PLACEHOLDER})`;
    const next = value.slice(0, start) + inserted + value.slice(end);
    // the address is selected, ready to be typed or pasted over
    const urlStart = start + text.length + 3;
    return { value: next, selectionStart: urlStart, selectionEnd: urlStart + LINK_PLACEHOLDER.length };
  }

  return prefixLines(value, start, end, kind);
}
