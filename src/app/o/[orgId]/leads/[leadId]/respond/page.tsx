import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { ChatIcon, PhoneIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { CallLogButton } from "@/features/activities/components/call-log-button";
import { TakeLeadButton } from "@/features/leads/components/take-lead-button";
import { WaitingClock } from "@/features/leads/components/waiting-clock";
import { getRespondLead } from "@/features/leads/take-server";
import { getOrgContext } from "@/features/shell/queries";
import { WhatsappButton } from "@/features/whatsapp/components/whatsapp-button";
import { recordTemplateValues } from "@/features/whatsapp/templates";
import { formatDateTime, telUrl, whatsappUrl } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { waitingText } from "@/lib/waiting-time";

export const metadata: Metadata = { title: "ליד חדש" };

type Props = {
  params: Promise<{ orgId: string; leadId: string }>;
  // do = the button pressed on the push: call or whatsapp starts at once
  searchParams: Promise<{ do?: string | string[] }>;
};

/**
 * The short screen a new-lead push opens (SPD-01): call, WhatsApp and "לקחתי".
 * On a phone that shows no buttons on the notification (iPhone), tapping it
 * lands here; elsewhere the buttons on the notification come here too.
 */
export default async function RespondLeadPage({ params, searchParams }: Props) {
  const [{ orgId, leadId }, query] = await Promise.all([params, searchParams]);
  const context = await getOrgContext(orgId);
  if (!isUuid(leadId)) notFound();
  const lead = await getRespondLead(orgId, leadId);
  if (!lead) notFound();

  const tel = telUrl(lead.phoneE164, lead.phone);
  const whatsapp = whatsappUrl(lead.phoneE164);
  const act = typeof query.do === "string" ? query.do : null;
  // a button pressed on the push starts that call or chat once, through the same logging as the lead card
  const subject = { kind: "lead" as const, id: lead.id };
  const mine = lead.ownerId === context.user.id;
  const canTake = context.canWrite && !lead.converted && (lead.ownerId === null || (mine && lead.takenAt === null));
  // read once per request on the server; the clock runs on in the browser
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  const state = lead.converted
    ? "הליד כבר הומר לאיש קשר."
    : lead.ownerId === null
      ? "הליד עוד לא אצל אף אחד. מי שלוחץ ראשון על \"לקחתי\" הופך לאחראי."
      : mine
        ? lead.takenAt
          ? "הליד אצלכם."
          : "הליד הוקצה לכם."
        : `הליד אצל ${lead.ownerName ?? "מישהו אחר בצוות"}.`;

  return (
    <div className="mx-auto w-full max-w-md">
      <PageHeader title="ליד חדש" back={{ href: paths.leadsWaiting(orgId), label: "לידים שמחכים" }} />
      <Card>
        <CardBody className="flex flex-col gap-4">
          <div>
            <h2 className="break-words text-lg font-semibold">
              <bdi>{lead.name}</bdi>
            </h2>
            <p className="mt-1 flex flex-wrap gap-x-3 text-sm text-ink-soft">
              <span className="font-medium text-warning">
                ממתין <WaitingClock since={lead.createdAt} initial={waitingText(now - Date.parse(lead.createdAt))} />
              </span>
              <span>נכנס {formatDateTime(lead.createdAt)}</span>
              {lead.sourceName ? <span>{lead.sourceName}</span> : null}
              {lead.companyName ? <bdi>{lead.companyName}</bdi> : null}
            </p>
            {lead.phone ? (
              <p className="mt-1 text-sm" dir="ltr">
                {lead.phone}
              </p>
            ) : null}
            {lead.message ? <p className="mt-2 line-clamp-4 whitespace-pre-line break-words text-sm">{lead.message}</p> : null}
          </div>

          <p role="status" className="text-sm text-ink-soft">
            {state}
          </p>

          <div className="flex flex-col gap-2">
            {canTake ? <TakeLeadButton orgId={orgId} leadId={lead.id} leadName={lead.name} /> : null}
            {tel && context.canWrite ? (
              <CallLogButton tel={tel} orgId={orgId} subject={subject} name={lead.name} wide autoStart={act === "call"} />
            ) : tel ? (
              <a href={tel} className={buttonClasses("secondary", "md", "w-full")} aria-label={`חיוג אל ${lead.name}`}>
                <PhoneIcon className="size-5 text-accent" />
                חיוג
              </a>
            ) : null}
            {whatsapp && lead.phoneE164 && context.canWrite ? (
              <WhatsappButton
                phoneE164={lead.phoneE164}
                orgId={orgId}
                subject={subject}
                name={lead.name}
                values={recordTemplateValues({ fullName: lead.fullName }, context)}
                wide
                autoStart={act === "whatsapp"}
              />
            ) : whatsapp ? (
              <a
                href={whatsapp}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClasses("secondary", "md", "w-full")}
                aria-label={`WhatsApp אל ${lead.name} (נפתח בחלון חדש)`}
              >
                <ChatIcon className="size-5 text-accent" />
                <span dir="ltr">WhatsApp</span>
              </a>
            ) : null}
            {!tel && !whatsapp ? <p className="text-sm text-ink-soft">לליד הזה אין מספר טלפון.</p> : null}
          </div>

          <Link href={paths.lead(orgId, lead.id)} className="text-sm font-medium text-accent underline underline-offset-4 hover:text-accent-strong">
            לכרטיס הליד המלא
          </Link>
        </CardBody>
      </Card>
    </div>
  );
}
