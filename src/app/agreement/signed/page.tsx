import type { Metadata } from "next";
import Link from "next/link";

import { PrintButton } from "@/features/legal/components/print-button";
import { getMyAgreement } from "@/features/legal/queries";
import { requireUser } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "ההסכם החתום" };

export default async function SignedAgreementPage() {
  await requireUser();
  const agreement = await getMyAgreement();
  if (agreement === "second_step") {
    return (
      <>
        <h1 className="text-2xl font-semibold">ההסכם החתום</h1>
        <p className="mt-2">כדי לראות את העותק החתום צריך להשלים את האימות הדו-שלבי בכניסה הזו.</p>
        <Link
          href={`${paths.loginMfa}?next=${encodeURIComponent(paths.agreementSigned)}`}
          className="mt-4 inline-block text-accent-strong underline underline-offset-4"
        >
          לאימות
        </Link>
      </>
    );
  }
  if (!agreement) {
    return (
      <>
        <h1 className="text-2xl font-semibold">ההסכם החתום</h1>
        <p className="mt-2">עוד לא חתמתם על ההסכם.</p>
        <Link href={paths.agreement} className="mt-4 inline-block text-accent-strong underline underline-offset-4">
          לחתימה
        </Link>
      </>
    );
  }

  return (
    <article>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold">ההסכם החתום</h1>
        <PrintButton />
      </div>

      <section aria-labelledby="signature" className="mt-6 rounded-lg border border-line p-4 sm:p-5">
        <h2 id="signature" className="font-semibold">
          פרטי החתימה
        </h2>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-md">
          <dt className="text-ink-soft">שם</dt>
          <dd>{agreement.fullName}</dd>
          <dt className="text-ink-soft">אימייל</dt>
          <dd dir="ltr" className="text-end">
            {agreement.email}
          </dd>
          <dt className="text-ink-soft">נחתם</dt>
          <dd>{formatDateTime(agreement.signedAt)}</dd>
          <dt className="text-ink-soft">גרסה</dt>
          <dd>{agreement.version}</dd>
          {agreement.ip ? (
            <>
              <dt className="text-ink-soft">כתובת IP</dt>
              <dd dir="ltr" className="text-end">
                {agreement.ip}
              </dd>
            </>
          ) : null}
          <dt className="text-ink-soft">טביעת המסמך (SHA-256)</dt>
          <dd dir="ltr" className="text-end font-mono text-xs break-all">
            {agreement.contentHash}
          </dd>
        </dl>
        <div className="mt-4">
          <p className="text-sm text-ink-soft">חתימה</p>
          {agreement.method === "drawn" && agreement.signature ? (
            // eslint-disable-next-line @next/next/no-img-element -- a stored data: URL
            <img src={agreement.signature} alt={`החתימה של ${agreement.fullName}`} className="mt-1 h-28 w-auto max-w-full rounded-md border border-line bg-paper" />
          ) : (
            <p className="mt-1 text-3xl italic">{agreement.fullName}</p>
          )}
        </div>
      </section>

      {agreement.documents.map((doc) => (
        <section key={doc.slug} aria-labelledby={`signed-${doc.slug}`} className="mt-8">
          <h2 id={`signed-${doc.slug}`} className="text-xl font-semibold">
            {doc.title}
          </h2>
          <p className="text-sm text-ink-soft">גרסה {doc.version}</p>
          <div className="mt-3 text-md leading-relaxed whitespace-pre-line">{doc.text}</div>
        </section>
      ))}
    </article>
  );
}
