type Option = { id: string; name: string };

/** CON-03: contacts that may still be added to a deal: not its main contact and not linked already. */
export function addableDealContacts<T extends Option>(options: T[], linkedIds: string[], mainContactId: string | null): T[] {
  const taken = new Set(linkedIds);
  if (mainContactId) taken.add(mainContactId);
  return options.filter((option) => !taken.has(option.id));
}
