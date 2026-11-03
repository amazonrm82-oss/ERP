import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { TextLink } from "@/components/ui/text-link";
import { CopyWording } from "@/features/privacy-center/components/copy-wording";
import { privacyCenterPath } from "@/features/privacy-center/paths";
import {
  consentWordings,
  noticeMissing,
  PRIVACY_NOTICE_VERSION,
  privacyNoticeParagraph,
  WORDINGS_DRAFT_NOTE,
} from "@/features/privacy-center/wordings";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrganizationSettings } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { documentSettingsPath } from "@/features/tax/paths";
import { getDocumentDetails } from "@/features/tax/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "נוסחים לפרטיות" };

type Props = { params: Promise<{ orgId: string }> };

// PRK-04: the form consent wording (CAP-07, with the version saved with every consent) and a privacy-notice paragraph
// filled with the business's details (it names the role "אחראי/ת הפרטיות", never a person: owner (74) ג), each with a copy button. DRAFTS until the lawyer edits them. Owners and admins.
export default async function PrivacyWordingsPage({ params }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  if (!isAdminRole(context.role)) {
    return <p className="text-sm text-ink-soft">רק בעלים ומנהלי מערכת רואים את הנוסחים.</p>;
  }
  const [details, settings] = await Promise.all([getDocumentDetails(orgId), getOrganizationSettings(orgId)]);
  const consent = consentWordings(context.org.name);
  const address = [details.addressLine, details.city, details.postalCode].filter((part) => part && part.trim() !== "").join(", ");
  const noticeDetails = {
    businessName: context.org.name,
    legalName: details.legalName,
    taxId: details.taxId,
    address: address || null,
    email: details.email,
    phone: details.phone ?? settings?.phone ?? null,
  };
  const notice = privacyNoticeParagraph(noticeDetails);
  const missingDetails = noticeMissing(noticeDetails);

  return (
    <div className="space-y-5">
      <PageHeader title="נוסחים לפרטיות" back={{ href: privacyCenterPath(orgId), label: "מרכז פרטיות" }} />
      <div role="note" className="rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-md text-warning">
        {WORDINGS_DRAFT_NOTE}
      </div>

      <Card aria-labelledby="wording-consent">
        <CardHeader id="wording-consent" title="נוסח הסכמה לדיוור בטפסים" />
        <CardBody className="space-y-4">
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
            זה הנוסח שמופיע ליד תיבת ההסכמה בטפסים של העסק. מספר הגרסה נשמר עם כל הסכמה שנרשמת.
            <Badge>גרסה {consent.version}</Badge>
          </p>
          {consent.items.map((item) => (
            <section key={item.channel} aria-labelledby={`wording-consent-${item.channel}`} className="space-y-1.5">
              <h2 id={`wording-consent-${item.channel}`} className="font-semibold">
                {item.label}
              </h2>
              <CopyWording label={`נוסח הסכמה ל${item.label}`} text={item.text} />
            </section>
          ))}
          <p className="text-sm text-ink-soft">
            את התיבות מפעילים בכל טופס ב<TextLink href={paths.settingsIntake(orgId)}>טפסים וחיבורים</TextLink>.
          </p>
        </CardBody>
      </Card>

      <Card aria-labelledby="wording-notice">
        <CardHeader id="wording-notice" title="פסקה להודעת הפרטיות של העסק" />
        <CardBody className="space-y-4">
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
            לאתר של העסק או לתחתית טופס. ממולאת בפרטי העסק.
            <Badge>גרסה {PRIVACY_NOTICE_VERSION}</Badge>
          </p>
          {missingDetails.length > 0 ? (
            <p className="text-sm text-warning">
              חסרים פרטים: {missingDetails.join(", ")}. אפשר להשלים אותם ב
              <TextLink href={documentSettingsPath(orgId)}>פרטים למסמכים</TextLink>.
            </p>
          ) : null}
          <CopyWording label="פסקה להודעת הפרטיות" text={notice} />
        </CardBody>
      </Card>
    </div>
  );
}
