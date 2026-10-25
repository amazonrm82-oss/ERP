import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { BackIcon } from "@/components/ui/icons";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { deleteIntakeAction } from "@/features/intake/actions";
import { FormQr } from "@/features/intake/components/form-qr";
import { CopyBlock, IntakeSettingsForm, ShareLink, type ProductChoices } from "@/features/intake/components/intake-editor";
import { SubmissionList } from "@/features/intake/components/submission-list";
import { formFieldOptions, formInputName, isCustomFormKey } from "@/features/intake/fields";
import { formQrUrl, qrFileName } from "@/features/intake/qr-link";
import {
  countFormProductOffer,
  FORM_PRODUCT_PICK_LIMIT,
  getIntake,
  listFormCategoryOptions,
  listFormProductOptions,
  listSubmissions,
} from "@/features/intake/queries";
import { requestedProductEnabled } from "@/features/requested-product/queries";
import { getLeadLookups } from "@/features/leads/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrganizationSettings, getTeam, listMembers, listTeams } from "@/features/settings/queries";
import { UNOWNED_NOTE, unownedLeadsGoTo } from "@/features/intake/unowned";
import { whatsappNumber } from "@/features/intake/whatsapp";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid, paths } from "@/lib/paths";
import { siteOrigin } from "@/lib/site-origin";

export const metadata: Metadata = { title: "טופס או חיבור" };

type Props = { params: Promise<{ orgId: string; formId: string }> };

export default async function IntakeItemPage({ params }: Props) {
  const { orgId, formId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  if (!isUuid(formId) || !isAdminRole(role)) {
    notFound();
  }
  const [intake, submissions, lookups, members, teams, origin, definitions, organization, productsOn] = await Promise.all([
    getIntake(orgId, formId),
    listSubmissions(orgId, formId),
    getLeadLookups(orgId),
    listMembers(orgId),
    listTeams(orgId),
    siteOrigin(),
    listFieldDefinitions(orgId, "lead", { includeInactive: true }),
    getOrganizationSettings(orgId),
    // LEAD-04 / CAP-08: the product question needs the products flag
    requestedProductEnabled(orgId),
  ]);
  if (!intake) {
    notFound();
  }
  const sources = lookups.sources.filter((source) => source.isActive || source.id === intake.sourceId);
  const assignable = members
    .filter((member) => member.status === "active" && member.role !== "viewer")
    .map((member) => ({ id: member.userId, name: member.name }));

  // SPD-01: no active owner and no round robin: new leads go to the whole team (owner's answer, 13 October 2026)
  const noActiveOwner = intake.assignMode !== "round_robin" && !assignable.some((member) => member.id === intake.ownerId);
  const team = noActiveOwner && intake.teamId ? await getTeam(orgId, intake.teamId) : null;
  const unownedNote = noActiveOwner
    ? UNOWNED_NOTE[
        unownedLeadsGoTo({
          teamId: team ? team.id : null,
          visibility: organization?.recordVisibility ?? "org",
          members,
          teamMembers: team?.members ?? [],
        })
      ]
    : null;

  const fieldOptions = formFieldOptions(definitions);
  // LEAD-04 / CAP-08: the product question's lists and counts (the business's products flag, web forms only)
  let productChoices: ProductChoices | null = null;
  if (productsOn && intake.kind === "form") {
    const [options, categories] = await Promise.all([listFormProductOptions(orgId, intake.productIds), listFormCategoryOptions(orgId)]);
    const counts = await countFormProductOffer(orgId, intake.productIds, intake.productCategoryIds, categories);
    productChoices = { options, cut: options.length >= FORM_PRODUCT_PICK_LIMIT, categories, ...counts };
  }
  // CAP-05: the business phone, as typed, when a WhatsApp chat can open it
  const businessPhone = organization?.phone && whatsappNumber(organization.phone) ? organization.phone : null;
  const customNames = intake.fields.filter((field) => isCustomFormKey(field.key)).map((field) => formInputName(field.key));
  const pageUrl = `${origin}/f/${intake.token}`;
  const postUrl = `${origin}/api/forms/${intake.token}`;
  const hookUrl = `${origin}/api/in/${intake.token}`;
  // CAP-02: the iframe alone still works; the script line adds the campaign details and the page address
  const embedCode = [
    `<iframe src="${pageUrl}?embed=1" title="${(intake.title ?? intake.name).replace(/"/g, "&quot;")}" style="width:100%;max-width:480px;height:560px;border:0" loading="lazy"></iframe>`,
    `<script src="${origin}/f/embed.js" async></script>`,
  ].join("\n");

  return (
    <div className="space-y-5">
      <div>
        <Link href={paths.settingsIntake(orgId)} className="mb-2 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
          <BackIcon className="size-4" />
          כל הטפסים והחיבורים
        </Link>
        <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold break-words">
          {intake.name}
          <Badge>{intake.kind === "form" ? "טופס" : "Webhook"}</Badge>
          {intake.isActive ? null : <Badge tone="warning">כבוי</Badge>}
        </h2>
      </div>

      {intake.kind === "form" ? (
        <Card aria-labelledby="share-title">
          <CardHeader id="share-title" title="שיתוף הטופס" />
          <CardBody className="space-y-5">
            <p className="text-md text-ink-soft">שולחים את הקישור ב-WhatsApp, בפוסט או במודעה. כל מי שממלא את הטופס נכנס כליד.</p>
            <ShareLink url={pageUrl} title={intake.title ?? intake.name} />
            <details className="text-md">
              <summary className="cursor-pointer font-medium">קוד QR לשלט, לפלייר או לכרטיס ביקור</summary>
              <div className="mt-3">
                <FormQr url={formQrUrl(pageUrl)} printUrl={`${pageUrl}/qr`} fileName={qrFileName(intake.name)} />
              </div>
            </details>
            <details className="text-md">
              <summary className="cursor-pointer font-medium">יש לכם אתר? קוד להטמעה</summary>
              <div className="mt-3 space-y-3">
                <p className="text-ink-soft">מדביקים את הקוד באתר, במקום שבו הטופס צריך להופיע.</p>
                <CopyBlock label="קוד להטמעה באתר" value={embedCode} />
                <p className="text-ink-soft">
                  שורת הסקריפט מעבירה לטופס רק את פרטי הקמפיין (utm ומזהי מודעות) ואת כתובת הדף שבו הטופס מוטמע, בלי עוגיות ובלי
                  מעקב. כך רואים בליד מאיזו מודעה ומאיזה דף הוא הגיע. קוד הטמעה שכבר הודבק באתר, בלי השורה הזו, ממשיך לעבוד.
                </p>
              </div>
            </details>
            <details className="text-md">
              <summary className="cursor-pointer font-medium">לבוני אתרים: שליחה מטופס קיים</summary>
              <div className="mt-3 space-y-3">
                <p className="text-ink-soft">
                  טופס HTML קיים יכול לשלוח ישירות לכתובת הזו (POST). שמות השדות: full_name, phone, email, company_name, message.
                  {customNames.length > 0 ? <> שדות מותאמים: <span dir="ltr">{customNames.join(", ")}</span>.</> : null}
                </p>
                <CopyBlock label="כתובת שליחה" value={postUrl} />
              </div>
            </details>
          </CardBody>
        </Card>
      ) : (
        <Card aria-labelledby="hook-title">
          <CardHeader id="hook-title" title="חיבור ה-webhook" />
          <CardBody className="space-y-4">
            <p className="text-md text-ink-soft">
              הכתובת היא הסיסמה: מי שמחזיק בה יכול ליצור לידים. לא לפרסם אותה באתר. שולחים POST עם JSON, עם השדות full_name, phone,
              email, company_name, message (גם name, company ו-notes מתקבלים).
            </p>
            <CopyBlock label="כתובת ה-webhook" value={hookUrl} />
            <CopyBlock
              label="דוגמה לבדיקה"
              value={`curl -X POST "${hookUrl}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"full_name":"ישראל ישראלי","phone":"050-1234567","email":"israel@example.com"}'`}
            />
          </CardBody>
        </Card>
      )}

      <Card aria-labelledby="intake-settings-title">
        <CardHeader id="intake-settings-title" title="הגדרות" />
        <CardBody>
          {unownedNote ? (
            <p role="note" className="mb-4 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
              {unownedNote}
            </p>
          ) : null}
          {canWrite ? (
            <IntakeSettingsForm
              orgId={orgId}
              intake={intake}
              sources={sources}
              members={assignable}
              teams={teams.map((team) => ({ id: team.id, name: team.name }))}
              fieldOptions={fieldOptions}
              businessPhone={businessPhone}
              productChoices={productChoices}
            />
          ) : (
            <p className="text-md text-ink-soft">העסק במצב קריאה בלבד.</p>
          )}
        </CardBody>
      </Card>

      <Card aria-labelledby="submissions-title">
        <CardHeader id="submissions-title" title="פניות אחרונות" />
        {submissions.length === 0 ? (
          <CardBody>
            <p className="text-md text-ink-soft">עוד לא התקבלו פניות.</p>
          </CardBody>
        ) : (
          <SubmissionList orgId={orgId} submissions={submissions} />
        )}
      </Card>

      {canWrite ? (
        <ActionButton
          action={deleteIntakeAction.bind(null, orgId, intake.id)}
          pendingText="מוחקים…"
          variant="danger-ghost"
          confirm={`למחוק את "${intake.name}"? הכתובת תפסיק לעבוד מייד. הלידים שכבר נוצרו נשארים, ויומן הפניות נשמר 12 חודשים.`}
        >
          מחיקה
        </ActionButton>
      ) : null}
    </div>
  );
}
