// USR-09 (owner (387) א): several addresses at once. Pure: split on commas, semicolons, spaces and new lines, lower case,
// each once, at most MAX_INVITES, each a plain address (create_invitation checks again).

import { z } from "zod";

export const MAX_INVITES = 20;

const email = z.string().email();

export type ParsedAddresses = { ok: true; emails: string[] } | { ok: false; message: string };

export function parseInviteAddresses(text: unknown): ParsedAddresses {
  if (typeof text !== "string") return { ok: false, message: "יש להזין כתובת אימייל." };
  const emails = [...new Set(text.split(/[\s,;]+/).map((v) => v.trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0) return { ok: false, message: "יש להזין כתובת אימייל." };
  if (emails.length > MAX_INVITES) return { ok: false, message: `אפשר להזמין עד ${MAX_INVITES} כתובות בבת אחת.` };
  const bad = emails.filter((v) => v.length > 254 || !email.safeParse(v).success);
  if (bad.length > 0) return { ok: false, message: `כתובות לא תקינות: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? " ועוד" : ""}` };
  return { ok: true, emails };
}

/** What the send answered (public.invitation_email_queue), in Hebrew; null = queued. */
export function emailQueueText(reason: string | null): string | null {
  switch (reason) {
    case null:
      return null;
    case "unavailable":
      return "שליחה באימייל עוד לא זמינה. העתיקו את הקישור ושלחו אותו בעצמכם.";
    case "rate":
      return "לכתובת הזו כבר נשלחו 3 הזמנות היום. אפשר לשלוח שוב מחר, או להעתיק קישור.";
    case "rate_requester":
      return "שלחת היום 100 הזמנות באימייל. אפשר לשלוח שוב מחר, או להעתיק קישור.";
    case "rate_business":
      return "העסק שלח היום 100 הזמנות באימייל. אפשר לשלוח שוב מחר, או להעתיק קישור.";
    default:
      return "לא הצלחנו לשלוח את ההזמנה באימייל.";
  }
}
