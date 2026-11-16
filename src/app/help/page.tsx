import type { Metadata } from "next";

import { PUBLIC_HELP_ARTICLES } from "@/features/help/articles";
import { PublicHelpIndex } from "@/features/help/components/public-help";
import { APP_NAME } from "@/lib/app";
import { paths } from "@/lib/paths";
import { publicPageMetadata } from "@/features/seo/page-metadata";

const DESCRIPTION = `מדריכים קצרים לעבודה עם ${APP_NAME}: לידים, עסקאות, משימות, דוחות, ייבוא והגדרות.`;

export const metadata: Metadata = publicPageMetadata({ title: "מרכז עזרה", description: DESCRIPTION, path: paths.help, index: true });

// The public help center (UX-06): the same articles as the center inside the app (docs/help/), drafts left out. Static:
// it reads no database, takes no visitor input and uses no key.
export default function HelpIndexPage() {
  return <PublicHelpIndex articles={PUBLIC_HELP_ARTICLES} />;
}
