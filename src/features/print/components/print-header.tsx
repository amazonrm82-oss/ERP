import "../print.css";

import { printedAtText } from "../print";
import { PrintStamp } from "./print-stamp";

/**
 * GAP-11: the top of a printed page (business name and when it was printed), hidden on screen.
 * Its `data-print-page` marker switches on the print layout of `print.css` for this page only.
 */
export function PrintHeader({ orgName, timeZone }: { orgName: string; timeZone: string }) {
  return (
    <div data-print-page="" className="mb-4 hidden border-b border-line pb-2 print:block">
      <p className="text-lead font-semibold">{orgName}</p>
      <PrintStamp timeZone={timeZone} initial={printedAtText(new Date(), timeZone)} />
    </div>
  );
}
