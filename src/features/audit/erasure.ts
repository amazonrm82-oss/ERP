import { SUPPORT_LINE } from "@/lib/support-phone";

// audit_erase_record answers -1 when the erasure is paused (owner, 13 October 2026): the request
// is kept and the server completes it later; the person gets no marketing meanwhile. The text
// never names the cause.
export const ERASURE_PAUSED = -1;
export const ERASURE_PAUSED_MESSAGE = `לא ניתן להשלים את המחיקה כרגע בגלל תקלה אצלנו. הבקשה נשמרה ותושלם אוטומטית. לבירור: ${SUPPORT_LINE}.`;
