/** What to call a contact on screen when it has no name. */
export function contactDisplayName(contact: { fullName: string | null; email: string | null; phone: string | null }): string {
  return contact.fullName || contact.email || contact.phone || "איש קשר ללא שם";
}
