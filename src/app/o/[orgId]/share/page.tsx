import { createHash } from "node:crypto";

import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/page-header";
import { listCompanyOptions } from "@/features/companies/queries";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { activeReasonNames } from "@/features/disqualify-reasons/queries";
import { getLeadLookups } from "@/features/leads/queries";
import { getOrgModules } from "@/features/modules/queries";
import { listPriceLists } from "@/features/price-lists/queries";
import { listRecordTypes } from "@/features/record-type-options/queries";
import { requestedProductEnabled } from "@/features/requested-product/queries";
import { ShareScreen, type ShareContactForm, type ShareLeadForm } from "@/features/share/components/share-screen";
import { readShareParams } from "@/features/share/share";
import { ReadOnlyNotice } from "@/features/shell/components/read-only-notice";
import { getOrgContext } from "@/features/shell/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = { title: "שיתוף" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * WAB-06: what was shared from another app becomes a new lead (a new contact while leads are switched off), with the
 * shared text and image as a note on it, or a note (and file) on a record the person picks.
 */
export default async function OrgSharePage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const share = readShareParams(await searchParams);
  const [{ canWrite }, terms, modules, user] = await Promise.all([getOrgContext(orgId), getOrgTerms(orgId), getOrgModules(orgId), requireUser()]);
  // the share kept on this device belongs to the first signed-in person who opens it (the worker compares this hash)
  const owner = createHash("sha256").update(user.id).digest("hex");

  if (!canWrite) {
    return (
      <>
        <PageHeader title="שיתוף" />
        <ReadOnlyNotice />
      </>
    );
  }

  // LEAD-08: with leads switched off a new contact takes the new lead's place (owner, 27 October 2026, answer (ג))
  let leadForm: ShareLeadForm | null = null;
  let contactForm: ShareContactForm | null = null;
  if (modules.leads) {
    const [{ statuses, sources }, fields, reasons, products] = await Promise.all([
      getLeadLookups(orgId),
      listFieldDefinitions(orgId, "lead"),
      activeReasonNames(orgId),
      requestedProductEnabled(orgId),
    ]);
    leadForm = { statuses, sources, fields, reasons, products };
  } else {
    // as /contacts/new: with companies switched off there is no company field (null)
    const [companies, fields, types, priceLists] = await Promise.all([
      modules.companies ? listCompanyOptions(orgId) : null,
      listFieldDefinitions(orgId, "contact"),
      listRecordTypes(orgId, "contact"),
      listPriceLists(orgId),
    ]);
    contactForm = { companies, fields, types, priceLists };
  }

  return (
    <div className="max-w-2xl">
      <PageHeader title="שיתוף" description="מה לעשות עם מה ששיתפתם?" />
      <ShareScreen orgId={orgId} share={share} owner={owner} terms={terms} leadForm={leadForm} contactForm={contactForm} />
    </div>
  );
}
