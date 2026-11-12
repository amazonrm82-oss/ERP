import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { CheckIcon } from "@/components/ui/icons";
import { annualPriceLabel, monthlyPriceLabel, VAT_NOTE } from "@/features/plans/price";
import { landingCoreCapabilities, landingPlanCapabilities, planQuotaLines, type PublicPlan } from "@/features/plans/public-plans";
import { paths } from "@/lib/paths";

const priced = (plan: PublicPlan) => ({
  price_monthly_agorot: plan.priceMonthlyAgorot,
  price_annual_agorot: plan.priceAnnualAgorot,
  price_unit: plan.priceUnit,
});

function Included({ label }: { label: string }) {
  return (
    <li className="flex gap-2">
      <CheckIcon aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-success" />
      <span>{label}</span>
    </li>
  );
}

/**
 * LND-13: the price list, from the plans table (public.plans_public, cached an hour). Available and coming-soon plans
 * only; a coming-soon plan is marked and cannot be joined yet (the "notify me" form, LND-13's anonymous write, is not
 * built). When the plans cannot be read, the section says so and shows no price.
 */
export function PriceList({ plans }: { plans: PublicPlan[] | null }) {
  const shown = plans ?? [];
  const core = landingCoreCapabilities();
  return (
    <section aria-labelledby="prices-title" className="border-t border-line">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        <h2 id="prices-title" className="text-2xl font-semibold">
          מחירון
        </h2>
        {shown.length === 0 ? (
          <div className="mt-4 max-w-2xl space-y-4">
            <p className="text-md text-ink-soft">לא הצלחנו להציג כרגע את המחירים. נסו לרענן את הדף בעוד כמה דקות.</p>
            <ButtonLink href={paths.signup} variant="secondary">
              הרשמה לתקופת ניסיון
            </ButtonLink>
          </div>
        ) : (
          <>
            <p className="mt-2 max-w-2xl text-md text-ink-soft">המחירים לחודש, {VAT_NOTE}. בתשלום שנתי המחיר לחודש נמוך יותר.</p>
            {core.length > 0 ? (
              <div className="mt-6 rounded-lg border border-line bg-canvas p-5">
                <h3 className="font-semibold">בכל החבילות</h3>
                <ul className="mt-3 grid gap-2 text-md sm:grid-cols-2">
                  {core.map((item) => (
                    <Included key={item.feature} label={item.label} />
                  ))}
                </ul>
              </div>
            ) : null}
            <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {shown.map((plan) => {
                const titleId = `price-plan-${plan.key}`;
                const soon = plan.availability === "coming_soon";
                return (
                  <li
                    key={plan.key}
                    aria-labelledby={titleId}
                    className={`flex flex-col gap-4 rounded-lg border bg-surface p-5 ${soon ? "border-dashed border-line-strong" : "border-line"}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 id={titleId} className="text-lead font-semibold">
                        {plan.name}
                      </h3>
                      {soon ? <Badge tone="accent">בקרוב</Badge> : null}
                    </div>
                    <div>
                      <p className="text-md font-semibold">{monthlyPriceLabel(priced(plan))}</p>
                      <p className="text-sm text-ink-soft">{annualPriceLabel(priced(plan))}</p>
                    </div>
                    <ul className="space-y-1.5 text-sm">
                      {planQuotaLines(plan.limits).map((line) => (
                        <Included key={line} label={line} />
                      ))}
                      {landingPlanCapabilities(plan.features).map((item) => (
                        <Included key={item.feature} label={item.label} />
                      ))}
                    </ul>
                    <div className="mt-auto pt-2">
                      {soon ? (
                        <p className="text-sm text-ink-soft">החבילה עוד לא פתוחה להצטרפות.</p>
                      ) : (
                        <ButtonLink href={paths.signup} variant="secondary" className="w-full">
                          הרשמה
                          <span className="sr-only"> לחבילה {plan.name}</span>
                        </ButtonLink>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
