import Link from "next/link";

import { cn } from "@/lib/cn";
import { paths } from "@/lib/paths";

import { SETUP_STEP_COUNT, SETUP_STEPS, type SetupStep } from "../steps";

type Props = { orgId: string; step: SetupStep };

/** "Step X of 4" with the four steps; any step can be opened from here. */
export function SetupProgress({ orgId, step }: Props) {
  return (
    <nav aria-label="שלבי ההקמה" className="mb-5">
      <p className="mb-2 text-sm font-medium text-ink-soft">
        שלב {step} מתוך {SETUP_STEP_COUNT}
      </p>
      <ol className="grid grid-cols-4 gap-2">
        {SETUP_STEPS.map((item) => {
          const current = item.step === step;
          return (
            <li key={item.step}>
              <Link
                href={paths.setup(orgId, item.step)}
                aria-current={current ? "step" : undefined}
                className="group flex flex-col gap-1.5 rounded-md py-1 focus-visible:outline-offset-2"
              >
                <span aria-hidden="true" className={cn("h-1.5 rounded-full", item.step <= step ? "bg-accent" : "bg-line-strong")} />
                <span
                  className={cn(
                    "text-caption leading-snug group-hover:underline sm:text-sm",
                    current ? "font-semibold text-ink" : "text-ink-soft",
                  )}
                >
                  <span className="sr-only">{`שלב ${item.step}: `}</span>
                  {item.title}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
