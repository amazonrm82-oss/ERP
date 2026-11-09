import { describe, expect, it } from "vitest";

import { ACCEPTED_REMAKE_PDF_LABEL, ACCEPTED_REMAKE_SUFFIX, acceptedChoiceChanged } from "@/features/quotes/decision";
import { remadeNote } from "@/features/quotes/pdf";

// PKG-06 (owner (172) ב; second review M1, lead's choice until owner question 175): an accepted quote's PDF made again after a
// service recipient's erasure is rendered from the stored data; when the customer's choice changed the quote it shows the
// accepted state, its footer says so and the staff call it "כפי שאושר"; otherwise it is the quote as sent with the plain footer
describe("an accepted quote's PDF made again after a recipient's erasure", () => {
  const item = { kind: "item" as const, isOptional: false };
  const optional = { kind: "item" as const, isOptional: true };
  const decision = (sent: number | null, accepted: number | null, chosen: number | null) => ({ sentTotalAgorot: sent, acceptedTotalAgorot: accepted, optionalChosen: chosen });

  it("tells a changed choice from the decision: another accepted total, or optional lines chosen", () => {
    expect(acceptedChoiceChanged(decision(10000, 10000, null), [item, optional])).toBe(false);
    expect(acceptedChoiceChanged(decision(10000, 10000, 0), [item])).toBe(false);
    expect(acceptedChoiceChanged(decision(10000, 15000, 0), [item])).toBe(true);
    expect(acceptedChoiceChanged(decision(10000, 10000, 1), [item, optional])).toBe(true);
    expect(acceptedChoiceChanged(decision(null, null, null), [item])).toBe(false);
  });

  it("without the decision (a reader who may not see it), any optional item line counts as changed", () => {
    expect(acceptedChoiceChanged(null, [item])).toBe(false);
    expect(acceptedChoiceChanged(null, [item, optional])).toBe(true);
    expect(acceptedChoiceChanged(null, [{ kind: "group", isOptional: true }])).toBe(false);
  });

  it("names the accepted remake and adds the accepted words to the remake's footer", () => {
    expect(ACCEPTED_REMAKE_PDF_LABEL).toBe("הורדת PDF (כפי שאושר)");
    const note = remadeNote(new Date("2026-11-09T10:00:00Z"), "Asia/Jerusalem");
    expect(note).toBe("נוצר מחדש ב-09.11.2026 מהנתונים השמורים");
    expect(note + ACCEPTED_REMAKE_SUFFIX).toBe("נוצר מחדש ב-09.11.2026 מהנתונים השמורים, לפי מה שאושר");
  });
});
