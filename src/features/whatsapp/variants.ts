import type { Gender } from "@/features/gender/gender";

// HEB-01: a template may hold a wording per gender in one block:
//   {זכר: תודה שפנית | נקבה: תודה שפנית | ניטרלי: תודה על הפנייה}
// The system picks the part by the record's gender; an empty or unknown gender takes the neutral part,
// which every block must hold. A part may hold placeholders ({שם פרטי}), never another block.
// The rule is mirrored by app.template_variant_problem() (migration gender), and both run
// tests/unit/fixtures/gender-variants.json (tests/unit/gender-variants.test.ts and tests/db 2xx-gender).
// Keep the two in step: same labels, same start pattern (spaces only, U+0020), same trim set.

export const VARIANT_LABELS = { male: "זכר", female: "נקבה", neutral: "ניטרלי" } as const;
type VariantPart = keyof typeof VARIANT_LABELS;

const LABEL_TO_PART = new Map<string, VariantPart>(
  (Object.keys(VARIANT_LABELS) as VariantPart[]).map((part) => [VARIANT_LABELS[part], part]),
);

// a block starts with "{", optional spaces, a label, optional spaces and ":"
const BLOCK_START = /\{ *(זכר|נקבה|ניטרלי) *:/y;
const PART_HEAD = /^ *(זכר|נקבה|ניטרלי) *:/;
const TRIM_SET = " \t\n\r";

export type VariantProblem = "variant" | "neutral";

// the same texts answer the database's hints whatsapp_template:variant / whatsapp_template:neutral (src/lib/errors.ts)
export const VARIANT_PROBLEM_MESSAGES: Record<VariantProblem, string> = {
  neutral: "בנוסח לפי מגדר חסר נוסח ניטרלי, שנשלח כשהמגדר לא ידוע. הוסיפו אותו בתוך הסוגריים, אחרי \"ניטרלי:\".",
  variant: "נוסח לפי מגדר לא כתוב נכון. כותבים כך: {זכר: … | נקבה: … | ניטרלי: …}, כל אפשרות פעם אחת, ובלי סוגריים בתוך סוגריים חוץ משדות כמו {שם פרטי}.",
};

/** The example the editor shows. */
export const VARIANT_EXAMPLE = "{זכר: תודה שפנית אלינו | נקבה: תודה שפנית אלינו | ניטרלי: תודה על הפנייה}";

function trimSet(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && TRIM_SET.includes(value[start])) start += 1;
  while (end > start && TRIM_SET.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

type Block = { start: number; end: number; parts: Partial<Record<VariantPart, string>> };
type Scan = { blocks: Block[]; problem: VariantProblem | null };

function blockStartsAt(text: string, index: number): boolean {
  BLOCK_START.lastIndex = index;
  return BLOCK_START.test(text);
}

/** Reads every block of a text, or the first problem. Pure; the SQL mirror walks the text the same way. */
function scan(text: string): Scan {
  const blocks: Block[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{" || !blockStartsAt(text, i)) {
      i += 1;
      continue;
    }
    // the block's body runs to the "}" that closes it; one level of placeholders may sit inside
    let depth = 0;
    let j = i + 1;
    let close = -1;
    const pipes: number[] = [];
    while (j < text.length) {
      const ch = text[j];
      if (ch === "{") {
        if (depth > 0 || blockStartsAt(text, j)) return { blocks, problem: "variant" };
        depth = 1;
      } else if (ch === "}") {
        if (depth === 0) {
          close = j;
          break;
        }
        depth = 0;
      } else if (ch === "|" && depth === 0) {
        pipes.push(j);
      }
      j += 1;
    }
    if (close < 0) return { blocks, problem: "variant" };
    const bounds = [i, ...pipes, close];
    const parts: Partial<Record<VariantPart, string>> = {};
    for (let k = 0; k < bounds.length - 1; k += 1) {
      const raw = text.slice(bounds[k] + 1, bounds[k + 1]);
      const head = PART_HEAD.exec(raw);
      if (!head) return { blocks, problem: "variant" };
      const part = LABEL_TO_PART.get(head[1]) as VariantPart;
      if (parts[part] !== undefined) return { blocks, problem: "variant" };
      parts[part] = trimSet(raw.slice(head[0].length));
    }
    if (parts.neutral === undefined) return { blocks, problem: "neutral" };
    blocks.push({ start: i, end: close, parts });
    i = close + 1;
  }
  return { blocks, problem: null };
}

/** null when the text's gender blocks are well formed and each holds a neutral part; else what is wrong. */
export function templateVariantProblem(text: string): VariantProblem | null {
  return scan(text).problem;
}

/** True when the text holds at least one gender block. */
export function hasVariants(text: string): boolean {
  const result = scan(text);
  return result.problem !== null || result.blocks.length > 0;
}

/**
 * Replaces every gender block by the part for this gender: male or female when the block has it, else
 * the neutral part; no gender or 'unknown' always the neutral part. A text with a problem is left as it
 * is (a template saved before the rule), so the person sees what to fix.
 */
export function pickVariants(text: string, gender: Gender | null | undefined): string {
  const { blocks, problem } = scan(text);
  if (problem || blocks.length === 0) return text;
  let out = "";
  let at = 0;
  for (const block of blocks) {
    const chosen = (gender === "male" || gender === "female" ? block.parts[gender] : undefined) ?? block.parts.neutral ?? "";
    out += text.slice(at, block.start) + chosen;
    at = block.end + 1;
  }
  return out + text.slice(at);
}
