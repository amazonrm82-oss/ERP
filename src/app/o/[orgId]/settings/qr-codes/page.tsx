import type { Metadata } from "next";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { FormIcon, PlusIcon } from "@/components/ui/icons";
import { FormQr } from "@/features/intake/components/form-qr";
import { qrFileName } from "@/features/intake/qr-link";
import { deleteQrCodeAction, setQrCodeActiveAction } from "@/features/qr-codes/actions";
import { QrCodeForm } from "@/features/qr-codes/components/qr-code-form";
import { QR_KIND_LABELS } from "@/features/qr-codes/model";
import { qrScanPath } from "@/features/qr-codes/paths";
import { listQrCodes, listQrTargets, qrExternalBlocked, qrScanCounts } from "@/features/qr-codes/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatNumber } from "@/lib/format";
import { siteOrigin } from "@/lib/site-origin";
import { SUPPORT } from "@/lib/support";

export const metadata: Metadata = { title: "קודי QR" };

const RECENT_DAYS = 30;

// "the <target> the code opened was deleted"
const GONE_LABELS = { form: "הטופס", booking: "דף קביעת התור", card: "כרטיס הביקור", url: "הקישור" } as const;

type Props = { params: Promise<{ orgId: string }> };

/**
 * BIZ-03: a QR code per sign or flyer. Each opens a web form, a booking page, a rep's business card or any https link,
 * tags the visit with its own name as the campaign, and counts its scans (a number per day, nothing about who scanned).
 * Owners and admins only.
 */
export default async function QrCodesPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  if (!isAdminRole(role)) {
    return (
      <Card aria-labelledby="qr-title">
        <CardHeader id="qr-title" title="קודי QR" />
        <CardBody>
          <p className="text-md text-ink-soft">קודי QR מנהלים בעלי העסק ומנהלי המערכת.</p>
        </CardBody>
      </Card>
    );
  }
  const [inPlan, codes, counts, targets, origin, externalOff] = await Promise.all([
    orgHasFeature(orgId, "qr_codes"),
    listQrCodes(orgId),
    qrScanCounts(orgId, RECENT_DAYS),
    listQrTargets(orgId),
    siteOrigin(),
    qrExternalBlocked(orgId),
  ]);
  const names = new Map([...targets.forms, ...targets.pages, ...targets.cards].map((t) => [t.value, t]));
  // a code is pointed only at a card someone can open
  const openCards = targets.cards.filter((card) => card.active);
  // the first step the user may take: the form above; nothing outside the plan or while read-only (a link is always possible)
  const firstAction =
    !inPlan || !canWrite ? null : (
      <ButtonLink href="#qr-new" variant="secondary">
        <PlusIcon className="size-4" />
        יצירת קוד ראשון
      </ButtonLink>
    );

  return (
    <div className="space-y-6">
      <Card aria-labelledby="qr-title">
        <CardHeader id="qr-title" title="קוד QR חדש" />
        <CardBody className="space-y-4">
          {externalOff ? (
            // BIZ-03 (owner, 27 October 2026, answer (ה)): the platform's emergency switch
            <p role="status" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
              הקישורים החיצוניים של העסק כובו על ידי צוות המערכת. מי שסורק קוד שפותח קישור חיצוני רואה שהקוד אינו פעיל, ואי אפשר ליצור, לשנות או
              להפעיל קוד כזה. קודים שפותחים טופס, דף קביעת תור או כרטיס ביקור ממשיכים לעבוד. לפרטים פנו לתמיכה בטלפון{" "}
              <span dir="ltr">{SUPPORT.phone}</span>.
            </p>
          ) : null}
          <p className="text-md text-ink-soft">
            קוד נפרד לכל שלט או פלייר. הקוד פותח טופס, דף קביעת תור, כרטיס ביקור של נציג או כל קישור, וסופר כמה פעמים סרקו אותו, כדי לדעת מה עבד. לא נשמר שום פרט על מי שסרק.
          </p>
          {!inPlan ? (
            <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
              קודי QR אינם כלולים בחבילה הנוכחית.
            </p>
          ) : !canWrite ? (
            <p className="text-md text-ink-soft">העסק במצב קריאה בלבד, ולכן אי אפשר ליצור או לשנות קודים.</p>
          ) : (
            <div id="qr-new" className="scroll-mt-24">
              <QrCodeForm orgId={orgId} forms={targets.forms} pages={targets.pages} cards={openCards} externalOff={externalOff} />
            </div>
          )}
        </CardBody>
      </Card>

      <Card aria-labelledby="qr-list">
        <CardHeader id="qr-list" title="הקודים של העסק" />
        {codes.length === 0 ? (
          <EmptyState
            compact
            icon={<FormIcon />}
            title="עוד אין קודי QR"
            description="כאן יופיעו הקודים שתולים על שלטים ופליירים, עם מספר הסריקות של כל אחד."
            action={firstAction}
            className="border-t border-line"
          />
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {codes.map((code) => {
              const target = code.targetId ? names.get(`${code.kind}:${code.targetId}`) : undefined;
              const count = counts.get(code.id);
              const link = `${origin}${qrScanPath(code.token)}`;
              const kindLabel = QR_KIND_LABELS[code.kind];
              // BIZ-03 (owner, 27 October 2026, answer (ג)): a link code is off while the platform's switch is on
              const switchedOff = externalOff && code.kind === "url";
              return (
                <li key={code.id} className="space-y-3 px-4 py-4 sm:px-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="min-w-0 text-md font-medium break-words">
                      {code.name} {code.isActive && !switchedOff ? <Badge tone="success">פעיל</Badge> : <Badge>כבוי</Badge>}
                    </h3>
                    <p className="text-sm text-ink-soft">
                      {formatNumber(count?.recent ?? 0)} סריקות ב-{RECENT_DAYS} הימים האחרונים · {formatNumber(count?.total ?? 0)} בסך הכול
                    </p>
                  </div>
                  <p className="text-sm text-ink-soft">
                    {code.kind === "url" ? (
                      <>
                        פותח קישור:{" "}
                        <span dir="ltr" className="break-all">
                          {code.url}
                        </span>
                        {switchedOff
                          ? " (כבוי: הקישורים החיצוניים כובו על ידי צוות המערכת. מי שסורק רואה שהקוד אינו פעיל.)"
                          : " (לפני המעבר מוצג דף עם שם האתר ושם העסק)"}
                      </>
                    ) : target ? (
                      <>
                        פותח {kindLabel}: {target.label}
                        {target.active ? null : " (כבוי: מי שסורק רואה שהקוד אינו פעיל)"}
                      </>
                    ) : (
                      `${GONE_LABELS[code.kind]} שהקוד פתח נמחק. מי שסורק רואה שהקוד אינו פעיל.`
                    )}
                  </p>
                  <FormQr
                    url={link}
                    fileName={qrFileName(code.name)}
                    imageLabel={`קוד QR: ${code.name}`}
                    description="מורידים, מדפיסים ותולים. כל סריקה נספרת כאן, ומי שמשאיר פרטים נכנס כליד עם שם הקוד כקמפיין."
                  />
                  {inPlan && canWrite ? (
                    <div className="flex flex-wrap gap-2">
                      {/* a link code cannot be switched on while the platform's switch is on; switching it off stays */}
                      {switchedOff && !code.isActive ? null : (
                        <ActionButton
                          action={setQrCodeActiveAction.bind(null, orgId, code.id, !code.isActive)}
                          pendingText="שומרים…"
                          srLabel={code.name}
                        >
                          {code.isActive ? "כיבוי הקוד" : "הפעלת הקוד"}
                        </ActionButton>
                      )}
                      <ActionButton
                        action={deleteQrCodeAction.bind(null, orgId, code.id)}
                        pendingText="מוחקים…"
                        variant="danger-ghost"
                        srLabel={code.name}
                        confirm="למחוק את הקוד? קודים שכבר הודפסו יפסיקו לעבוד, וספירת הסריקות תימחק. לידים שהגיעו דרכו נשארים."
                        confirmLabel="מחיקת הקוד"
                      >
                        מחיקת הקוד
                      </ActionButton>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
