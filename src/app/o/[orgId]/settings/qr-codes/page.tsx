import type { Metadata } from "next";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormQr } from "@/features/intake/components/form-qr";
import { qrFileName } from "@/features/intake/qr-link";
import { deleteQrCodeAction, setQrCodeActiveAction } from "@/features/qr-codes/actions";
import { QrCodeForm } from "@/features/qr-codes/components/qr-code-form";
import { qrScanPath } from "@/features/qr-codes/paths";
import { listQrCodes, listQrTargets, qrScanCounts } from "@/features/qr-codes/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { formatNumber } from "@/lib/format";
import { siteOrigin } from "@/lib/site-origin";

export const metadata: Metadata = { title: "קודי QR" };

const RECENT_DAYS = 30;

type Props = { params: Promise<{ orgId: string }> };

/**
 * BIZ-03 part one: a QR code per sign or flyer. Each opens a web form or a booking page, tags the visit with its own
 * name as the campaign, and counts its scans (a number per day, nothing about who scanned). Owners and admins only.
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
  const [inPlan, codes, counts, targets, origin] = await Promise.all([
    orgHasFeature(orgId, "qr_codes"),
    listQrCodes(orgId),
    qrScanCounts(orgId, RECENT_DAYS),
    listQrTargets(orgId),
    siteOrigin(),
  ]);
  const names = new Map([...targets.forms, ...targets.pages].map((t) => [t.value, t]));

  return (
    <div className="space-y-6">
      <Card aria-labelledby="qr-title">
        <CardHeader id="qr-title" title="קוד QR חדש" />
        <CardBody className="space-y-4">
          <p className="text-md text-ink-soft">
            קוד נפרד לכל שלט או פלייר. הקוד פותח טופס או דף קביעת תור, וסופר כמה פעמים סרקו אותו, כדי לדעת מה עבד. לא נשמר שום פרט על מי שסרק.
          </p>
          {!inPlan ? (
            <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
              קודי QR אינם כלולים בחבילה הנוכחית.
            </p>
          ) : !canWrite ? (
            <p className="text-md text-ink-soft">העסק במצב קריאה בלבד, ולכן אי אפשר ליצור או לשנות קודים.</p>
          ) : targets.forms.length + targets.pages.length === 0 ? (
            <p className="text-md text-ink-soft">כדי ליצור קוד, צריך קודם טופס אתר או דף קביעת תור.</p>
          ) : (
            <QrCodeForm orgId={orgId} forms={targets.forms} pages={targets.pages} />
          )}
        </CardBody>
      </Card>

      <Card aria-labelledby="qr-list">
        <CardHeader id="qr-list" title="הקודים של העסק" />
        {codes.length === 0 ? (
          <CardBody>
            <p className="text-md text-ink-soft">עדיין אין קודים.</p>
          </CardBody>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {codes.map((code) => {
              const target = code.targetId ? names.get(`${code.kind}:${code.targetId}`) : undefined;
              const count = counts.get(code.id);
              const link = `${origin}${qrScanPath(code.token)}`;
              const kindLabel = code.kind === "booking" ? "דף קביעת תור" : "טופס";
              return (
                <li key={code.id} className="space-y-3 px-4 py-4 sm:px-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="min-w-0 text-md font-medium break-words">
                      {code.name} {code.isActive ? <Badge tone="success">פעיל</Badge> : <Badge>כבוי</Badge>}
                    </h3>
                    <p className="text-sm text-ink-soft">
                      {formatNumber(count?.recent ?? 0)} סריקות ב-{RECENT_DAYS} הימים האחרונים · {formatNumber(count?.total ?? 0)} בסך הכול
                    </p>
                  </div>
                  <p className="text-sm text-ink-soft">
                    {target ? (
                      <>
                        פותח {kindLabel}: {target.label}
                        {target.active ? null : " (כבוי: מי שסורק רואה שהקוד אינו פעיל)"}
                      </>
                    ) : (
                      `ה${kindLabel} שהקוד פתח נמחק. מי שסורק רואה שהקוד אינו פעיל.`
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
                      <ActionButton
                        action={setQrCodeActiveAction.bind(null, orgId, code.id, !code.isActive)}
                        pendingText="שומרים…"
                        srLabel={code.name}
                      >
                        {code.isActive ? "כיבוי הקוד" : "הפעלת הקוד"}
                      </ActionButton>
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
