import type { Metadata } from "next";

import { PUBLIC_HELP_ARTICLES } from "@/features/help/articles";
import { HelpIndex } from "@/features/help/components/help-views";
import { APP_NAME } from "@/lib/app";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "מרכז עזרה", description: `מדריכים קצרים לעבודה עם ${APP_NAME}` };

// The public help center (UX-06): the same articles as the center inside the app (docs/help/), drafts left out.
export default function HelpIndexPage() {
  return (
    <>
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-3xl font-semibold">מרכז עזרה</h1>
        <p className="mt-2 mb-6 text-lg text-ink-soft">מדריכים קצרים, צעד אחר צעד.</p>
      </div>
      <HelpIndex articles={PUBLIC_HELP_ARTICLES} base={paths.help} />
    </>
  );
}
