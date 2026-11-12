// BIZ-01: the business page settings rules the screen and the action share (the database checks them again).

/** At most this many booking pages on the business page (the check of business_pages.booking_page_ids). */
export const MAX_PAGE_BOOKINGS = 20;

/** At most this many characters in the description. */
export const MAX_ABOUT = 1000;

/** BIZ-01 (314) ב: who gets the leads of the page's form. */
export type PageRouting = "default" | "person" | "team";

/** The columns a routing choice writes (at most one of the two is set; the database checks it again). */
export function routingColumns(routing: PageRouting, ownerId: string | null, teamId: string | null): { owner_user_id: string | null; team_id: string | null } {
  if (routing === "person") return { owner_user_id: ownerId, team_id: null };
  if (routing === "team") return { owner_user_id: null, team_id: teamId };
  return { owner_user_id: null, team_id: null };
}
