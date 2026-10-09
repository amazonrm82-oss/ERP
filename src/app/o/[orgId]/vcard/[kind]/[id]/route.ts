import { getContact } from "@/features/contacts/queries";
import { getLead } from "@/features/leads/queries";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid } from "@/lib/paths";
import { buildVCard, vcardDisposition, type VCardPerson } from "@/lib/vcard";

// A lead's or contact's card for the phone's contacts (GAP-02), read with the user's session.
export async function GET(_request: Request, { params }: { params: Promise<{ orgId: string; kind: string; id: string }> }) {
  const { orgId, kind, id } = await params;
  if (!isUuid(id) || (kind !== "lead" && kind !== "contact")) {
    return new Response("not found", { status: 404 });
  }
  await getOrgContext(orgId);

  let person: VCardPerson | null = null;
  if (kind === "lead") {
    const lead = await getLead(orgId, id);
    if (lead) {
      person = { name: lead.full_name || lead.company_name || lead.phone || "", phone: lead.phone, email: lead.email, company: lead.company_name, jobTitle: lead.job_title };
    }
  } else {
    const contact = await getContact(orgId, id);
    if (contact) {
      person = {
        name: contact.full_name || contact.phone || "",
        phone: contact.phone,
        email: contact.email,
        company: contact.companyName,
        jobTitle: contact.job_title,
        birthday: contact.birth_date,
      };
    }
  }
  if (!person) {
    return new Response("הרשומה לא נמצאה.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new Response(buildVCard(person), {
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": vcardDisposition(person.name),
      "Cache-Control": "no-store",
    },
  });
}
