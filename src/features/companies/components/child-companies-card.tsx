import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { paths } from "@/lib/paths";

import type { CompanyLink } from "../queries";

/**
 * CON-07: the company's child companies (subsidiaries and branches) that the user may read.
 * Shown only when there is at least one; a child is set from its own page ("שייכת ל").
 */
export function ChildCompaniesCard({ orgId, items, total }: { orgId: string; items: CompanyLink[]; total: number }) {
  if (total === 0) {
    return null;
  }
  const more = total - items.length;
  return (
    <Card aria-labelledby="company-children-title">
      <CardHeader id="company-children-title" title={`חברות שתחתיה (${total})`} />
      <CardBody>
        <ul className="divide-y divide-line">
          {items.map((child) => (
            <li key={child.id} className="py-2.5 first:pt-0 last:pb-0">
              <Link href={paths.company(orgId, child.id)} className="font-medium underline-offset-4 hover:underline">
                <bdi>{child.name}</bdi>
              </Link>
              {child.city ? <span className="block text-sm text-ink-soft">{child.city}</span> : null}
            </li>
          ))}
        </ul>
        {more > 0 ? (
          <p className="mt-3 text-sm text-ink-soft">
            {`ועוד ${more} שלא מוצגות כאן. אפשר למצוא אותן ב`}
            <Link href={paths.companies(orgId)} className="text-accent underline underline-offset-4">
              רשימת החברות
            </Link>
            .
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
