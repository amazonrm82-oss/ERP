import type { Metadata } from "next";

import { PUBLIC_HELP_ARTICLES } from "@/features/help/articles";
import { PublicHelpIndex } from "@/features/help/components/public-help";
import { APP_NAME } from "@/lib/app";
import { paths } from "@/lib/paths";

const DESCRIPTION = `מדריכים קצרים לעבודה עם ${APP_NAME}: לידים, עסקאות, משימות, דוחות, ייבוא והגדרות.`;

export const metadata: Metadata = {
  title: "מרכז עזרה",
  description: DESCRIPTION,
  alternates: { canonical: paths.help },
  openGraph: { title: `מרכז עזרה | ${APP_NAME}`, description: DESCRIPTION, url: paths.help, type: "website", locale: "he_IL" },
};

// The public help center (UX-06): the same articles as the center inside the app (docs/help/), drafts left out. Static:
// it reads no database, takes no visitor input and uses no key.
export default function HelpIndexPage() {
  return <PublicHelpIndex articles={PUBLIC_HELP_ARTICLES} />;
}
