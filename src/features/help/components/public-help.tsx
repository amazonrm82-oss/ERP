import Link from "next/link";

import { buttonClasses, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { APP_NAME } from "@/lib/app";
import { paths } from "@/lib/paths";
import { SUPPORT } from "@/lib/support";

import type { HelpArticle } from "../types";
import { HelpIndex } from "./help-views";

// The public help center's front page (UX-06): static, from docs/help/ through content.generated.ts, no customer data,
// no database read and no service key. It is handed the public list only (`PUBLIC_HELP_ARTICLES`, drafts left out); with
// nothing approved yet it says so plainly and points to the roadmap and to support instead of an empty search box.
export function PublicHelpIndex({ articles }: { articles: HelpArticle[] }) {
  return (
    <>
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-3xl font-semibold">מרכז עזרה</h1>
        <p className="mt-2 mb-6 text-lg text-ink-soft">מדריכים קצרים, צעד אחר צעד.</p>
      </div>

      {articles.length > 0 ? (
        <HelpIndex articles={articles} base={paths.help} />
      ) : (
        <EmptyState
          title="המדריכים עוד בכתיבה"
          description={`בינתיים אפשר לראות מה אנחנו בונים, או לפנות אלינו ונעזור. לקוחות ${APP_NAME} מוצאים הסברים גם בתוך המערכת.`}
          action={
            <div className="flex flex-wrap justify-center gap-3">
              <ButtonLink href={paths.roadmap}>מפת דרכים</ButtonLink>
              <a href={SUPPORT.whatsappHref} target="_blank" rel="noopener noreferrer" className={buttonClasses("ghost")}>
                פנייה בוואטסאפ
                <span className="sr-only">(נפתח בחלון חדש)</span>
              </a>
            </div>
          }
        />
      )}

      <p className="mx-auto mt-12 max-w-2xl border-t border-line pt-6 text-center text-md text-ink-soft">
        רוצים לדעת מה בדרך?{" "}
        <Link href={paths.roadmap} className="text-accent-strong underline underline-offset-4">
          מפת הדרכים
        </Link>
        {" · "}
        <Link href={paths.home} className="text-accent-strong underline underline-offset-4">
          כניסה למערכת
        </Link>
      </p>
    </>
  );
}
