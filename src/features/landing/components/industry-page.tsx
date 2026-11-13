import Link from "next/link";

import { paths } from "@/lib/paths";

import type { IndustryPage } from "../industries";
import styles from "./landing.module.css";
import { LandingFooter, LandingNav } from "./sections";

// VRT-02: an industry's marketing page, in the landing page's dark look. The pictures are drawn panels (not screenshots made on
// a machine), filled from the kit's own sample data (VRT-03), so they show what a business of that industry really gets.

const DEMO = "הדגמה עם נתוני דוגמה";

function BoardPicture({ board }: { board: IndustryPage["pictures"]["board"] }) {
  return (
    <figure className={styles.indShot}>
      <figcaption className={styles.indShotCap}>{board.title}</figcaption>
      <div role="img" aria-label={`${DEMO}: תהליך המכירה "${board.title}" עם ${board.columns.map((c) => c.stage).join(", ")}`}>
        <div className={styles.board} aria-hidden="true">
          {board.columns.map((column) => (
            <div key={column.stage} className={styles.col}>
              <h5>{column.stage}</h5>
              {column.cards.map((card) => (
                <div key={card.name} className={styles.card}>
                  {card.name}
                  <small>{card.line}</small>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}

function LeadsPicture({ leads, people }: { leads: IndustryPage["pictures"]["leads"]; people: string }) {
  return (
    <figure className={styles.indShot}>
      <figcaption className={styles.indShotCap}>
        {leads.title} של {people}
      </figcaption>
      <div role="img" aria-label={`${DEMO}: רשימת פניות עם סטטוס לכל פנייה`}>
        <div className={styles.phoneShot} aria-hidden="true">
          <div className={styles.phoneIn}>
            {leads.rows.map((row) => (
              <div key={row.name} className={`${styles.row} ${styles.indRow}`}>
                <div>
                  <span className={styles.nm}>{row.name}</span>
                  <br />
                  <small>{row.line}</small>
                </div>
                <span className={styles.st}>{row.status}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}

function DayPicture({ day }: { day: IndustryPage["pictures"]["day"] }) {
  return (
    <figure className={styles.indShot}>
      <figcaption className={styles.indShotCap}>{day.title}</figcaption>
      <div role="img" aria-label={`${DEMO}: יומן עם ${day.rows.map((r) => r.type).join(", ")}`}>
        <ul className={styles.indDay} aria-hidden="true">
          {day.rows.map((row) => (
            <li key={`${row.time}-${row.type}`}>
              <span className={styles.indTime} dir="ltr">
                {row.time}
              </span>
              <span>
                <b>{row.type}</b>
                <small>
                  {row.name} · {row.minutes} דק&apos;
                </small>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

function CardPicture({ card }: { card: NonNullable<IndustryPage["pictures"]["card"]> }) {
  return (
    <figure className={styles.indShot}>
      <figcaption className={styles.indShotCap}>כרטיסייה</figcaption>
      <div role="img" aria-label={`${DEMO}: ${card.title}, ${card.used} מתוך ${card.entries} כניסות נוצלו`}>
        <div className={styles.indCard} aria-hidden="true">
          <b>{card.title}</b>
          <small>
            {card.holder} · {card.validity}
          </small>
          <div className={styles.indPunches}>
            {[...Array(card.entries).keys()].map((i) => (
              <span key={i} data-used={i < card.used ? "true" : "false"} />
            ))}
          </div>
          <small>
            נוצלו {card.used} מתוך {card.entries}
          </small>
        </div>
      </div>
    </figure>
  );
}

export function IndustryLanding({ page }: { page: IndustryPage }) {
  const { copy, setup, pictures } = page;
  return (
    <div className={styles.page}>
      <LandingNav />
      <main className="flex-1">
        <section aria-labelledby="industry-title" className={`${styles.hero} ${styles.indHero}`}>
          <div className={styles.wrap}>
            <span className={styles.tag}>
              <i aria-hidden="true" /> {copy.eyebrow}
            </span>
            <h1 id="industry-title" className="text-ln-h1">
              {copy.title}
            </h1>
            <p className={`${styles.heroLead} text-ln-lead`}>{copy.lead}</p>
            <div className={styles.ctas}>
              <Link href={paths.signup} className={`${styles.btn} ${styles.primary}`}>
                הרשמה לתקופת ניסיון
              </Link>
              <Link href={paths.pricing} className={`${styles.btn} ${styles.ghost}`}>
                למחירון
              </Link>
            </div>
          </div>
        </section>

        <section aria-labelledby="industry-pictures" className={`${styles.sec} ${styles.alt}`}>
          <div className={styles.wrap}>
            <span className={styles.eyebrow}>ככה זה נראה</span>
            <h2 id="industry-pictures" className="mt-3 text-ln-h2">
              המערכת כבר מדברת בשפה שלכם
            </h2>
            <p className={`${styles.lead} mt-4`}>הדגמה עם נתוני דוגמה מהערכה. אצלכם יופיעו ה{copy.people} שלכם.</p>
            <div className={styles.indShots}>
              <BoardPicture board={pictures.board} />
              <LeadsPicture leads={pictures.leads} people={copy.people} />
              <DayPicture day={pictures.day} />
              {pictures.card ? <CardPicture card={pictures.card} /> : null}
            </div>
          </div>
        </section>

        <section aria-labelledby="industry-setup" className={styles.sec}>
          <div className={styles.wrap}>
            <span className={styles.eyebrow}>מה הערכה מכינה</span>
            <h2 id="industry-setup" className="mt-3 text-ln-h2">
              הכול מוכן כשנכנסים בפעם הראשונה
            </h2>
            <p className={`${styles.lead} mt-4`}>הערכה מוסיפה רק מה שחסר. אפשר לשנות שם, למחוק או להוסיף כל דבר.</p>
            <ul className={styles.indSetup}>
              {setup.map((group) => (
                <li key={group.key}>
                  <h3 className="text-lead font-bold">{group.title}</h3>
                  <ul className={styles.indChips}>
                    {group.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  {group.note ? <p>{group.note}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="industry-steps" className={`${styles.sec} ${styles.alt}`}>
          <div className={styles.wrap}>
            <span className={styles.eyebrow}>איך זה עובד</span>
            <h2 id="industry-steps" className="mt-3 text-ln-h2">
              שלושה צעדים ומתחילים
            </h2>
            <ol className={styles.steps}>
              {copy.steps.map((step, i) => (
                <li key={step.title} className={styles.step}>
                  <div aria-hidden="true" className={`${styles.stepN} text-ln-step`}>
                    {i + 1}
                  </div>
                  <h3 className="mt-1.5 text-ln-h3">{step.title}</h3>
                  <p>{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="industry-cta" className={`${styles.sec} ${styles.cta}`}>
          <div className={styles.wrap}>
            <h2 id="industry-cta" className="text-ln-h2">
              מתחילים בכמה דקות
            </h2>
            <p>נרשמים, בוחרים את הערכה בשלב ההקמה, ומוסיפים את הפנייה הראשונה.</p>
            <Link href={paths.signup} className={`${styles.btn} ${styles.ctaBtn}`}>
              הרשמה לתקופת ניסיון
            </Link>
            <p>
              <Link href={paths.pricing} className={styles.indCtaLink}>
                המחירים בדף הבית
              </Link>
            </p>
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}

/** The landing page's links to the industry pages (VRT-02). */
export function IndustryLinks({ pages }: { pages: ReadonlyArray<{ key: string; label: string; teaser: string }> }) {
  return (
    <section aria-labelledby="industries-title" className={styles.sec}>
      <div className={styles.wrap}>
        <span className={styles.eyebrow}>ערכות לענפים</span>
        <h2 id="industries-title" className="mt-3 text-ln-h2">
          מגיעים עם ערכה מוכנה לענף שלכם
        </h2>
        <ul className={styles.indLinks}>
          {pages.map((page) => (
            <li key={page.key}>
              <Link href={paths.industry(page.key)}>
                <b className="text-ln-h3">{page.label}</b>
                <span>{page.teaser}</span>
                <span className={styles.indMore}>לפרטים על הערכה ←</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
