import Link from "next/link";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { paths } from "@/lib/paths";

import { COMPANY_PEOPLE_SHOWN, type CompanyPerson } from "../queries";

/**
 * CON-05: the people of a company, each with the role at this company (for whom it is the primary company and no
 * role was set here, their job title). A person is linked to more companies from their own card.
 */
export function CompanyPeopleCard({ orgId, people }: { orgId: string; people: CompanyPerson[] }) {
  const title = people.length >= COMPANY_PEOPLE_SHOWN ? `אנשי קשר (${COMPANY_PEOPLE_SHOWN} האחרונים)` : `אנשי קשר (${people.length})`;
  return (
    <Card aria-labelledby="company-contacts-title">
      <CardHeader id="company-contacts-title" title={title} />
      <CardBody>
        {people.length === 0 ? (
          <p className="text-md text-ink-soft">עוד אין אנשי קשר בחברה. מקשרים איש קשר לחברה בכרטיס שלו.</p>
        ) : (
          <ul className="divide-y divide-line">
            {people.map((person) => (
              <li key={person.id} className="py-2.5 first:pt-0 last:pb-0">
                <Link href={paths.contact(orgId, person.id)} className="font-medium underline-offset-4 hover:underline">
                  {person.name}
                </Link>
                {person.title ? <span className="block text-sm text-ink-soft">{person.title}</span> : null}
                {!person.isPrimary ? <span className="block text-sm text-ink-soft">החברה הראשית של איש הקשר היא אחרת</span> : null}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
