import { Wordmark } from "@/components/wordmark";

/** Shown instead of the app when the Supabase environment variables are not set. */
export function ConfigMissing() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-5 py-12">
      <Wordmark className="mb-10 h-7" />
      <h1 className="text-2xl font-semibold leading-tight">המערכת עוד לא הוגדרה</h1>
      <p className="mt-3 text-ink-soft">
        חסרים פרטי החיבור למסד הנתונים, ולכן אי אפשר להתחבר או להציג נתונים. זו הגדרה חד-פעמית של מי שמתקין את
        המערכת.
      </p>
      <div className="mt-6 rounded-lg border border-line bg-surface p-5">
        <h2 className="font-semibold">מה צריך לעשות</h2>
        <ol className="mt-3 list-decimal space-y-2 ps-5 text-[0.9375rem]">
          <li>
            להעתיק את הקובץ{" "}
            <code dir="ltr" className="rounded bg-canvas px-1.5 py-0.5 text-sm">
              .env.example
            </code>{" "}
            לקובץ חדש בשם{" "}
            <code dir="ltr" className="rounded bg-canvas px-1.5 py-0.5 text-sm">
              .env.local
            </code>
          </li>
          <li>
            למלא בו את שני הערכים הבאים, מתוך הגדרות הפרויקט ב-Supabase:
            <ul className="mt-2 space-y-1">
              <li>
                <code dir="ltr" className="rounded bg-canvas px-1.5 py-0.5 text-sm">
                  NEXT_PUBLIC_SUPABASE_URL
                </code>
              </li>
              <li>
                <code dir="ltr" className="rounded bg-canvas px-1.5 py-0.5 text-sm">
                  NEXT_PUBLIC_SUPABASE_ANON_KEY
                </code>
              </li>
            </ul>
          </li>
          <li>להפעיל את המערכת מחדש. בסביבת הייצור צריך גם לבנות אותה מחדש.</li>
        </ol>
      </div>
    </main>
  );
}
