import type { Metadata } from "next";

import { BlankText } from "@/features/legal/components/blank-text";
import { SignAgreementForm } from "@/features/legal/components/sign-agreement-form";
import { agreementDocuments, AGREEMENT_VERSION } from "@/features/legal/agreement";
import { getSignedVersion } from "@/features/legal/queries";
import { requireUser } from "@/lib/auth";
import { safeNextPath } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "חתימה על ההסכם" };

type Props = { searchParams: Promise<{ next?: string | string[] }> };

// Before the first use, and whenever the documents change: read and sign.
export default async function AgreementPage({ searchParams }: Props) {
  const user = await requireUser();
  const raw = (await searchParams).next;
  const next = safeNextPath(typeof raw === "string" ? raw : null);
  const supabase = await createClient();
  const [{ data: profile }, signed] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
    getSignedVersion(),
  ]);
  const docs = agreementDocuments();

  return (
    <>
      <h1 className="text-2xl font-semibold">{signed ? "המסמכים עודכנו" : "לפני שמתחילים: חתימה על ההסכם"}</h1>
      <p className="mt-2 text-ink-soft">
        {signed
          ? "עדכנו את תנאי השימוש. כדי להמשיך, קראו את הנוסח החדש וחתמו עליו."
          : "השימוש במערכת מותנה בהסכמה לתנאי השימוש, למדיניות הפרטיות ולהסכם עיבוד המידע. החתימה נשמרת יחד עם עותק של המסמכים, ותמיד אפשר לראות אותה בהגדרות ← החשבון שלי."}
      </p>

      <div
        tabIndex={0}
        role="region"
        aria-label="המסמכים לחתימה"
        className="mt-6 max-h-[28rem] space-y-8 overflow-y-auto rounded-lg border border-line p-4 sm:p-5"
      >
        {docs.map((doc) => (
          <section key={doc.slug} aria-labelledby={`doc-${doc.slug}`}>
            <h2 id={`doc-${doc.slug}`} className="text-xl font-semibold">
              {doc.title}
            </h2>
            {doc.interim ? <p className="mt-1 text-sm text-warning">נוסח זמני, גרסה {doc.version}. ייבדק על ידי עורך דין.</p> : null}
            <ol className="mt-3 space-y-4">
              {doc.sections.map((section, i) => (
                <li key={section.heading}>
                  <h3 className="font-semibold">
                    {i + 1}. {section.heading}
                  </h3>
                  {section.paragraphs.map((p) => (
                    <p key={p} className="mt-1 text-md leading-relaxed">
                      <BlankText text={p} />
                    </p>
                  ))}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>

      <div className="mt-6">
        <SignAgreementForm next={next} defaultName={profile?.full_name ?? ""} />
      </div>
      <p className="mt-4 text-sm text-ink-soft">גרסה {AGREEMENT_VERSION}</p>
    </>
  );
}
