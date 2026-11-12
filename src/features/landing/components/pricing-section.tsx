import type { PublicPlan } from "@/features/plans/public-plans";
import { paths } from "@/lib/paths";

import { comparisonRows, planCards, pricingFootnote, pricingShowsSoon, type ComparisonCell } from "../pricing";
import styles from "./landing.module.css";
import { PriceCards } from "./price-cards";

function Cell({ cell }: { cell: ComparisonCell }) {
  if (cell.kind === "yes")
    return (
      <>
        <span aria-hidden="true">✓</span>
        <span className="sr-only">כלול</span>
      </>
    );
  if (cell.kind === "no")
    return (
      <>
        <span aria-hidden="true">–</span>
        <span className="sr-only">לא כלול</span>
      </>
    );
  return <>{cell.text}</>;
}

/**
 * LND-13 / LND-20 v2 (6): the price list, from the plans table (public.plans_public, cached an hour). Available and coming-soon
 * plans only; a coming-soon plan is marked and offers "תודיעו לי כשנפתח". When the plans cannot be read, the section says so
 * and shows no price. `waiting`: the built capabilities that wait for their real provider (feature keys only, owner (339) ב).
 */
export function PricingSection({ plans, waiting }: { plans: PublicPlan[] | null; waiting: readonly string[] }) {
  const shown = plans ?? [];
  const waitingSet = new Set(waiting);
  const rows = comparisonRows(shown, waitingSet);
  const cards = planCards(shown, waitingSet);
  return (
    <section aria-labelledby="prices-title" id="pricing" className={styles.sec}>
      <div className={`${styles.wrap} ${styles.center}`}>
        <span className={styles.eyebrow}>מחירון</span>
        <h2 id="prices-title" className="mt-3 text-ln-h2">
          מחיר אחד לחודש. בלי הפתעות.
        </h2>
        {shown.length === 0 ? (
          <>
            <p className={`${styles.lead} text-ln-lead`} style={{ margin: "14px auto 0" }}>
              לא הצלחנו להציג כרגע את המחירים. נסו לרענן את הדף בעוד כמה דקות.
            </p>
            <a href={paths.signup} className={`${styles.btn} ${styles.primary}`} style={{ marginTop: 24 }}>
              הרשמה לתקופת ניסיון
            </a>
          </>
        ) : (
          <>
            <p className={`${styles.lead} text-ln-lead`} style={{ margin: "14px auto 0" }}>
              המחירים לחודש, לפני מע&quot;מ. לחצו על חבילה כדי לראות הכול.
            </p>
            <PriceCards cards={cards} />
            <details className={styles.all}>
              <summary>טבלת השוואה מלאה</summary>
              <div className={styles.tbl}>
                <table>
                  <caption className="sr-only">מה כלול בכל חבילה</caption>
                  <thead>
                    <tr>
                      <th scope="col">יכולת</th>
                      {shown.map((plan) => (
                        <th key={plan.key} scope="col" className={styles.c}>
                          {plan.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key}>
                        <th scope="row" style={{ fontWeight: 400, color: "inherit" }}>
                          {row.label}
                          {row.soon ? " (בקרוב)" : ""}
                        </th>
                        {row.cells.map((cell, i) => (
                          <td key={shown[i].key} className={styles.c}>
                            <Cell cell={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <p className={styles.hint}>{pricingFootnote(pricingShowsSoon(cards, rows))}</p>
          </>
        )}
      </div>
    </section>
  );
}
