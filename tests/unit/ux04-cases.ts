// UX-04 (second pass, 12 November 2026): the refusals whose wording was rewritten so they say what to do next.
// tests/unit/fixtures/ux04-rewritten-messages.json pins their text, so a later edit shows up in review.

/** Hints of the map in src/lib/errors.ts rewritten in the second pass. */
export const REWRITTEN_HINTS = [
  "cheque:refunded",
  "payment_promise:nothing_open",
  "quote_pdf:closed",
  "quote_pdf:not_accepted",
  "order_pdf:closed",
  "quote_version:closed",
  "quote_version:parent",
  "quote_version:fixed",
  "quote_cancel:closed",
  "quote_cancel:not_accepted",
  // owner (347) ב: a closing line each
  "quote_deal:no_deal",
  "contact_channel:primary",
  "quote_addendum:not_accepted",
  "quote_addendum:parent",
  "quote_addendum:version",
  "quote_addendum:fixed",
  "order:quote_not_accepted",
  "order_link:cancelled",
  "order_link:customer_deleted",
  "contact_relation:exists",
  "roadmap:closed",
  "privacy_request:closed",
  "number_sequences:last_number",
  "record_email:not_permitted",
  "record_sms:not_permitted",
] as const;

type ErrorShape = { code?: string; hint?: string; message?: string; status?: number };
type Case = { kind: "db" | "auth"; error: ErrorShape };

/** Messages outside the hint map: the shared code answers, raised and own messages, and Supabase Auth's codes. */
export const OTHER_CASES: Record<string, Case> = {
  "code:42501": { kind: "db", error: { code: "42501", message: "permission denied" } },
  "code:PGRST116": { kind: "db", error: { code: "PGRST116", message: "" } },
  "code:23505": { kind: "db", error: { code: "23505", message: "duplicate key" } },
  "code:28000": { kind: "db", error: { code: "28000", message: "" } },
  "raised:already converted": { kind: "db", error: { code: "P0001", message: "lead already converted" } },
  "raised:no open stage": { kind: "db", error: { code: "P0001", message: "no open stage in the pipeline" } },
  "own:change another admin": { kind: "db", error: { code: "42501", message: "only the owner can change another admin" } },
  "own:make an admin": { kind: "db", error: { code: "42501", message: "only the owner can make someone an admin" } },
  "own:own role": { kind: "db", error: { code: "42501", message: "cannot change your own role" } },
  "own:owner": { kind: "db", error: { code: "42501", message: "owner cannot be removed" } },
  "own:already a member": { kind: "db", error: { code: "23505", message: "already a member" } },
  "own:new owner": { kind: "db", error: { code: "22023", message: "new owner must be an active member" } },
  "own:invalid email": { kind: "db", error: { code: "22023", message: "invalid email address" } },
  "own:note edit window": { kind: "db", error: { code: "42501", message: "note edit window closed" } },
  "own:note pin only": { kind: "db", error: { code: "42501", message: "note pin only" } },
  "own:meeting entry": { kind: "db", error: { code: "42501", message: "meeting entry link is set by the server" } },
  "own:meeting hidden record": { kind: "db", error: { code: "42501", message: "meeting linked to a record the user cannot see" } },
  "own:meeting organizer": { kind: "db", error: { code: "23514", message: "meeting organizer must be an active member" } },
  "own:org not active": { kind: "db", error: { code: "42501", message: "the organization is not active" } },
  "own:change organizer": { kind: "db", error: { code: "42501", message: "not allowed to change the meeting organizer" } },
  "auth:invalid_credentials": { kind: "auth", error: { code: "invalid_credentials" } },
  "auth:same_password": { kind: "auth", error: { code: "same_password" } },
  "auth:email_address_invalid": { kind: "auth", error: { code: "email_address_invalid" } },
  "auth:signup_disabled": { kind: "auth", error: { code: "signup_disabled" } },
  "auth:user_banned": { kind: "auth", error: { code: "user_banned" } },
  "auth:reauthentication_needed": { kind: "auth", error: { code: "reauthentication_needed" } },
  "auth:session_expired": { kind: "auth", error: { code: "session_expired" } },
};
