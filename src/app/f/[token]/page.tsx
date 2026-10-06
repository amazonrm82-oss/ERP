import type { Metadata } from "next";

import { PublicLeadForm } from "@/features/intake/components/public-lead-form";
import { getPublicForm } from "@/features/intake/public-form";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "טופס פנייה", robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// Public, no sign-in. `?embed=1` drops the page frame for use inside an iframe.
export default async function PublicFormPage({ params, searchParams }: Props) {
  const { token } = await params;
  const embed = (await searchParams).embed === "1";
  const form = await getPublicForm(token);

  return (
    <main className={cn("mx-auto w-full max-w-md px-5", embed ? "py-4" : "min-h-dvh py-10 sm:py-16")}>
      {form === null || form === "not-configured" ? (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {form === null ? "הטופס לא נמצא או שאינו פעיל כרגע." : "הטופס אינו זמין כרגע."}
        </p>
      ) : (
        <>
          <h1 className="text-2xl font-semibold">{form.title}</h1>
          {form.intro ? <p className="mt-1 whitespace-pre-wrap text-ink-soft">{form.intro}</p> : null}
          <div className="mt-6">
            <PublicLeadForm token={token} fields={form.fields} submitLabel={form.submitLabel} />
          </div>
        </>
      )}
    </main>
  );
}
