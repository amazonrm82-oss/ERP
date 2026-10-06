import type { ReactNode } from "react";

import { Wordmark } from "@/components/wordmark";

// The path a lead takes through the product. It is a real sequence, so it is
// drawn as one: an ordered list with a connecting line.
const JOURNEY = [
  { title: "ליד נכנס", text: "נרשם עם מקור, סטטוס ובעלים." },
  { title: "נוצר קשר", text: "כל שיחה והערה נשמרות בציר הזמן." },
  { title: "המרה לעסקה", text: "איש קשר ועסקה נוצרים בלחיצה אחת." },
  { title: "נסגר בהצלחה", text: "העסקה מתקדמת בלוח עד הסגירה." },
];

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-surface lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
      <main className="flex flex-col px-5 py-6 sm:px-10 lg:px-16">
        <Wordmark className="text-lg" />
        <div className="mx-auto my-auto w-full max-w-sm py-10">{children}</div>
      </main>

      <aside aria-label="איך המערכת עובדת" className="hidden bg-accent-strong px-12 py-16 text-white lg:flex lg:flex-col lg:justify-center">
        <p className="max-w-sm text-3xl font-semibold leading-snug text-balance">
          מהפנייה הראשונה ועד סגירת העסקה, במקום אחד.
        </p>
        <ol className="mt-10 max-w-sm">
          {JOURNEY.map((step, index) => (
            <li key={step.title} className="relative flex gap-4 pb-7 last:pb-0">
              {index < JOURNEY.length - 1 ? (
                <span aria-hidden="true" className="absolute start-[0.4375rem] top-5 bottom-0 w-px bg-white/30" />
              ) : null}
              <span aria-hidden="true" className="relative mt-1.5 size-[0.9375rem] shrink-0 rounded-full border-2 border-white bg-accent-strong" />
              <span>
                <span className="block font-semibold">{step.title}</span>
                <span className="block text-[0.9375rem] text-white/85">{step.text}</span>
              </span>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
