"use client";

import { useCallback, useState } from "react";

import { SearchPicker, type SearchPickerChoice } from "@/components/ui/search-picker";
import { ContactPicker } from "@/features/contacts/components/contact-picker";

import { searchDocumentCompaniesAction } from "../picker-actions";

/**
 * DOC-03: the list's customer filter: a contact or a company (one of them; picking one clears the other). The picks travel
 * in the GET form as `contact` / `company` with their `__label`, like every SearchPicker.
 */
export function DocumentCustomerFilter({ orgId, contact, company }: { orgId: string; contact: SearchPickerChoice; company: SearchPickerChoice }) {
  const [kind, setKind] = useState<"contact" | "company">(company ? "company" : "contact");
  const searchCompanies = useCallback((query: string) => searchDocumentCompaniesAction(orgId, query), [orgId]);
  return (
    <div className="w-full space-y-1.5 sm:w-72">
      <fieldset className="flex items-center gap-3 text-sm">
        <legend className="sr-only">סוג הלקוח</legend>
        <label className="flex items-center gap-1.5">
          <input type="radio" name="customer_kind" checked={kind === "contact"} onChange={() => setKind("contact")} />
          איש קשר
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name="customer_kind" checked={kind === "company"} onChange={() => setKind("company")} />
          חברה
        </label>
      </fieldset>
      {kind === "contact" ? (
        <ContactPicker orgId={orgId} name="contact" label="לקוח" initial={contact} />
      ) : (
        <SearchPicker name="company" label="לקוח" initial={company} search={searchCompanies} placeholder="הקלידו שם חברה" />
      )}
    </div>
  );
}
