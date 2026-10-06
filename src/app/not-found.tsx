import type { Metadata } from "next";

import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "הדף לא נמצא" };

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-start justify-center px-5 py-12">
      <h1 className="text-2xl font-semibold">הדף לא נמצא</h1>
      <p className="mt-2 text-ink-soft">ייתכן שהקישור שגוי, שהרשומה נמחקה, או שאין לך גישה אליה.</p>
      <ButtonLink href="/" className="mt-6">
        חזרה לדף הבית
      </ButtonLink>
    </main>
  );
}
