/**
 * CON-03: the contacts the "add" search leaves out: the deal's main contact and the ones linked already (each once). The
 * database refuses a second link anyway; this keeps them out of the hits.
 */
export function dealContactExclude(linkedIds: string[], mainContactId: string | null): string[] {
  const taken = new Set(linkedIds);
  if (mainContactId) taken.add(mainContactId);
  return [...taken];
}
