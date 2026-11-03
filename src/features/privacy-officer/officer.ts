// PRK-06: texts and the pure choice of who may be named (an active member of the business; the database checks again,
// trigger org_privacy_settings_check, hint privacy_officer:member).

export const PRIVACY_OFFICER_LABEL = "אחראי פרטיות";

export const PRIVACY_OFFICER_EXPLAIN =
  "אחראי הפרטיות מקבל את הבקשות של אנשים לעיין במידע שלהם, לתקן אותו או למחוק אותו. הסימון לא נותן לו גישה למידע נוסף.";

export const NO_OFFICER = "לא נקבע אחראי פרטיות.";

export type OfficerCandidate = { userId: string; name: string };

/** The members who may be named: active ones only, in the list's order. */
export function officerCandidates(members: ReadonlyArray<{ userId: string; name: string; status: string }>): OfficerCandidate[] {
  return members.filter((m) => m.status === "active").map((m) => ({ userId: m.userId, name: m.name }));
}

/** The officer's name for the screens; a mark that points at someone no longer listed reads as none. */
export function officerName(officerId: string | null, members: ReadonlyArray<{ userId: string; name: string; status: string }>): string | null {
  if (!officerId) return null;
  const member = members.find((m) => m.userId === officerId && m.status === "active");
  return member ? member.name : null;
}
