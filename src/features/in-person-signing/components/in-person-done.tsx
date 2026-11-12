import { buttonClasses } from "@/components/ui/button";
import { FormNotice } from "@/components/ui/feedback";

import { IN_PERSON_PDF_LATER, IN_PERSON_PDF_SAVED } from "../texts";

// declined: owner (290) ב, the customer declined a quote: nothing was signed, so no PDF line
type Props = { message: string; pdfLater: boolean; declined?: boolean; back: { href: string; label: string } };

/** SGN-07: after the customer signed (or declined) on the rep's device: the thank-you, where the signed PDF is, and the way back. */
export function InPersonDone({ message, pdfLater, declined = false, back }: Props) {
  return (
    <div className="space-y-3">
      <FormNotice message={message} />
      {declined ? null : <p className="text-sm text-ink-soft">{pdfLater ? IN_PERSON_PDF_LATER : IN_PERSON_PDF_SAVED}</p>}
      <a href={back.href} className={buttonClasses("secondary", "sm")}>
        {back.label}
      </a>
    </div>
  );
}
