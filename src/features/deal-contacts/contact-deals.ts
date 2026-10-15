import type { RelatedDeal } from "@/features/deals/queries";

type Role = { dealId: string; roleLabel: string | null };

/**
 * CON-03: the deals on a contact's card. First the deals it is the main contact of, then the
 * deals it takes part in; each shows the contact's role when one is set. A deal is listed once.
 */
export function contactDealsWithRoles(mainDeals: RelatedDeal[], takingPart: RelatedDeal[], roles: Role[]): RelatedDeal[] {
  const roleOf = new Map(roles.map((entry) => [entry.dealId, entry.roleLabel]));
  const describe = (deal: RelatedDeal, fallback: string | null): RelatedDeal => {
    const label = roleOf.get(deal.id);
    return { ...deal, roleLabel: label ? `תפקיד: ${label}` : fallback };
  };
  const mainIds = new Set(mainDeals.map((deal) => deal.id));
  return [
    ...mainDeals.map((deal) => describe(deal, null)),
    ...takingPart.filter((deal) => !mainIds.has(deal.id)).map((deal) => describe(deal, "איש קשר בעסקה")),
  ];
}
