import type { IcsOrganizer } from "./ics";

/**
 * The ORGANIZER of a meeting's invite file (CAL-07; owner's answer, 13 October 2026).
 * With the business email of the document details (TAX-02): that address, named
 * "<organizer's name>, <business name>" (or the business name alone when the
 * organizer's name is not known). Without it, as before: the business name with
 * the meeting organizer's own address, or no ORGANIZER at all. The address is
 * passed as it is: buildIcs() quotes the name (RFC 5545 3.2) and leaves out the
 * ORGANIZER line when the address could break the line or the mailto URI.
 */
export function inviteOrganizer(input: {
  businessName: string;
  businessEmail: string | null;
  organizerName: string | null;
  organizerEmail: string | null;
}): IcsOrganizer | null {
  const businessEmail = input.businessEmail?.trim();
  if (businessEmail) {
    const person = input.organizerName?.trim();
    return { name: person ? `${person}, ${input.businessName}` : input.businessName, email: businessEmail };
  }
  const own = input.organizerEmail?.trim();
  return own ? { name: input.businessName, email: own } : null;
}
