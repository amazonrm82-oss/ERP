import { BrandScope } from "@/features/branding/components/brand-scope";
import { OrgLogo } from "@/features/branding/components/org-logo";
import { formatDate, formatMoney } from "@/lib/format";

import { overdueText, type PublicStatement } from "../public";

const day = (iso: string | null) => (iso ? formatDate(`${iso}T12:00:00Z`) : "");

/**
 * BAL-04: the customer's statement as they see it through the link: the business, the customer, today's date, every open
 * debt document with its balance and how late it is, the total, the overdue part and any credit. A table on a wide page and
 * on paper, cards on a phone. Only what public.statement_public answered.
 */
export function StatementView({ data, logoUrl }: { data: PublicStatement; logoUrl: string | null }) {
  const { business } = data;
  const registered = business.legalName;
  return (
    <BrandScope color={data.color}>
      <article aria-labelledby="statement-title" className="space-y-6 rounded-lg border border-line bg-surface p-4 text-ink sm:p-8 print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-accent pb-4">
          <div className="min-w-0 space-y-1 text-sm">
            {logoUrl ? <OrgLogo url={logoUrl} alt={`הלוגו של ${business.name}`} className="mb-2 h-14 max-w-48" /> : null}
            <p className="text-base font-semibold">
              <bdi>{business.name}</bdi>
            </p>
            {registered ? (
              <p>
                <bdi>{registered}</bdi>
              </p>
            ) : null}
            {business.taxId ? (
              <p>
                מספר עוסק או ח.פ.:{" "}
                <span dir="ltr" className="tabular-nums">
                  {business.taxId}
                </span>
              </p>
            ) : null}
            {business.address ? <p>{business.address}</p> : null}
            {business.phone || business.email ? (
              <p className="flex flex-wrap gap-x-3">
                {business.phone ? <span dir="ltr">{business.phone}</span> : null}
                {business.email ? <span dir="ltr">{business.email}</span> : null}
              </p>
            ) : null}
          </div>
          <div className="space-y-1 text-sm sm:text-end">
            <h1 id="statement-title" className="text-lg font-semibold">
              דף חשבון
            </h1>
            {data.customerName ? (
              <p>
                לכבוד: <bdi className="font-medium">{data.customerName}</bdi>
              </p>
            ) : null}
            <p className="text-ink-soft">נכון ל-{day(data.today)}</p>
          </div>
        </header>

        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-md border border-line p-3">
            <dt className="text-ink-soft">יתרה לתשלום</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatMoney(data.openAgorot)}</dd>
          </div>
          <div className="rounded-md border border-line p-3">
            <dt className="text-ink-soft">מתוכה באיחור</dt>
            <dd className={`text-lg font-semibold tabular-nums ${data.overdueAgorot > 0 ? "text-danger" : ""}`}>{formatMoney(data.overdueAgorot)}</dd>
          </div>
          {data.creditAgorot > 0 ? (
            <div className="rounded-md border border-line p-3">
              <dt className="text-ink-soft">זכות לטובתכם</dt>
              <dd className="text-lg font-semibold tabular-nums">{formatMoney(data.creditAgorot)}</dd>
            </div>
          ) : null}
        </dl>
        {data.creditAgorot > 0 ? <p className="text-sm text-ink-soft">הזכות מוצגת בנפרד, ועוד לא קוזזה מהיתרה לתשלום.</p> : null}

        {data.lines.length === 0 ? (
          <p role="status" className="rounded-md bg-success-soft px-3 py-2.5 text-sm text-success">
            אין חובות פתוחים. תודה!
          </p>
        ) : (
          <section aria-labelledby="statement-docs" className="space-y-3">
            <h2 id="statement-docs" className="text-md font-semibold">
              מסמכים פתוחים
            </h2>
            {/* a phone: one card per document */}
            <ul className="space-y-2 sm:hidden print:hidden">
              {data.lines.map((line) => (
                <li key={line.key} className="space-y-1 rounded-md border border-line p-3 text-sm">
                  <p className="font-medium">
                    {line.title}
                    {line.number ? (
                      <>
                        {" "}
                        <span dir="ltr" className="tabular-nums">
                          {line.number}
                        </span>
                      </>
                    ) : null}
                  </p>
                  <p className="text-ink-soft">
                    מתאריך {day(line.docDate)}
                    {line.dueDate ? ` · לתשלום עד ${day(line.dueDate)}` : ""}
                  </p>
                  <p className="flex flex-wrap justify-between gap-2">
                    <span>סכום: {formatMoney(line.amountAgorot)}</span>
                    <span className="font-semibold">יתרה: {formatMoney(line.balanceAgorot)}</span>
                  </p>
                  {overdueText(line.overdueDays) ? <p className="text-danger">{overdueText(line.overdueDays)}</p> : null}
                </li>
              ))}
            </ul>
            {/* a wide page and paper: a table */}
            <div className="hidden overflow-x-auto sm:block print:block" role="region" aria-labelledby="statement-docs" tabIndex={0}>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-ink-soft">
                    <th scope="col" className="px-2 py-2 text-start font-medium">
                      מסמך
                    </th>
                    <th scope="col" className="px-2 py-2 text-start font-medium">
                      תאריך
                    </th>
                    <th scope="col" className="px-2 py-2 text-start font-medium">
                      לתשלום עד
                    </th>
                    <th scope="col" className="px-2 py-2 text-end font-medium">
                      סכום
                    </th>
                    <th scope="col" className="px-2 py-2 text-end font-medium">
                      יתרה
                    </th>
                    <th scope="col" className="px-2 py-2 text-start font-medium">
                      איחור
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((line) => (
                    <tr key={line.key} className="border-b border-line">
                      <td className="px-2 py-2">
                        {line.title}
                        {line.number ? (
                          <>
                            {" "}
                            <span dir="ltr" className="tabular-nums">
                              {line.number}
                            </span>
                          </>
                        ) : null}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">{day(line.docDate)}</td>
                      <td className="px-2 py-2 whitespace-nowrap">{day(line.dueDate)}</td>
                      <td className="px-2 py-2 text-end tabular-nums whitespace-nowrap">{formatMoney(line.amountAgorot)}</td>
                      <td className="px-2 py-2 text-end font-semibold tabular-nums whitespace-nowrap">{formatMoney(line.balanceAgorot)}</td>
                      <td className="px-2 py-2 text-danger">{overdueText(line.overdueDays) ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={4} className="px-2 py-2 text-start">
                      סך הכול לתשלום
                    </th>
                    <td className="px-2 py-2 text-end font-semibold tabular-nums whitespace-nowrap">{formatMoney(data.openAgorot)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            {data.more > 0 ? <p className="text-sm text-ink-soft">ועוד {data.more} מסמכים פתוחים שלא מוצגים כאן. הסכומים למעלה כוללים אותם.</p> : null}
          </section>
        )}

        <p className="text-sm text-ink-soft">
          הדף מציג את החובות הפתוחים לפי הרישומים של <bdi>{business.name}</bdi> נכון להיום. זה אינו מסמך חשבונאי. לשאלות על החשבון פנו לעסק.
        </p>
      </article>
    </BrandScope>
  );
}
