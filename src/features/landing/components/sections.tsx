import Image from "next/image";
import Link from "next/link";

import { ChatIcon, PhoneIcon } from "@/components/ui/icons";
import { LEGAL_DOCUMENTS } from "@/features/legal/documents";
import { paths } from "@/lib/paths";
import { SUPPORT } from "@/lib/support";
import { SUPPORT_PHONE } from "@/lib/support-phone";
import logoDark from "@/assets/mexuz-logo-dark.png";

import { HeroCanvas } from "./hero-canvas";
import styles from "./landing.module.css";
import { PauseButton } from "./pause-button";
import { RotWord } from "./rot-word";

// LND-20 v2: the landing page's sections, one to one with the owner's approved prototype (texts and order). Names, phones
// and amounts in the product pictures are demo data.

export function LandingNav() {
  return (
    <header className={styles.nav}>
      <div className={`${styles.wrap} ${styles.navInner}`}>
        <Link href={paths.landing} aria-label="Mexuz, לדף הבית" className="rounded-md">
          <Image src={logoDark} alt="" priority className={styles.logo} sizes="160px" />
        </Link>
        <nav aria-label="כניסה והרשמה" className={styles.navActions}>
          <Link href={paths.login} className={`${styles.btn} ${styles.ghost}`}>
            כניסה
          </Link>
          <Link href={paths.signup} className={`${styles.btn} ${styles.primary}`}>
            הרשמה
          </Link>
        </nav>
      </div>
    </header>
  );
}

function ProductMock() {
  const rows = [
    { name: "משה כהן", phone: "050-1234567", status: "בשיחה" },
    { name: "שירה אברהם", phone: "052-7654321", status: "הצעה נשלחה" },
    { name: "דוד מזרחי", phone: "054-1112233", status: "פגישה" },
  ];
  return (
    <div className={styles.stage} role="img" aria-label='הדגמה: ליד נכנס לרשימה, התראה בטלפון, הנציג לוקח אותו'>
      <div className={styles.laptop} aria-hidden="true">
        <div className={styles.screen}>
          <aside className={styles.side}>
            <Image src={logoDark} alt="" className={styles.logo} sizes="110px" />
            <div>היום שלי</div>
            <div className={styles.on}>לידים</div>
            <div>אנשי קשר</div>
            <div>עסקאות</div>
            <div>משימות</div>
            <div>יומן</div>
            <div>דוחות</div>
          </aside>
          <div className={styles.main}>
            <h4>לידים</h4>
            <p className={styles.sub}>לידים שעוד לא סוננו. כשמתאים, ממירים לאיש קשר ולעסקה.</p>
            <span className={styles.timer}>לא נענה · 00:42</span>
            <div className={`${styles.row} ${styles.rowIn}`}>
              <span className={styles.nm}>אורית נחום</span>
              <span className={styles.ph}>050-7788990</span>
              <span className={`${styles.st} ${styles.stNew}`}>חדש</span>
              <span className={`${styles.st} ${styles.stMine}`}>בטיפול: רונית</span>
            </div>
            {rows.map((row) => (
              <div key={row.name} className={styles.row}>
                <span className={styles.nm}>{row.name}</span>
                <span className={styles.ph}>{row.phone}</span>
                <span className={styles.st}>{row.status}</span>
              </div>
            ))}
            <div className={styles.done}>✓ רונית לקחה את הליד</div>
          </div>
        </div>
        <div className={styles.base} />
      </div>
      <div className={styles.phone} aria-hidden="true">
        <div className={styles.pscreen}>
          <div className={styles.toast}>
            <b>ליד חדש: אורית נחום</b>
            <span className={styles.toastT}>מהאתר · מטבח מודולרי · לפני רגע</span>
            <div className={styles.take}>
              <span>אחר כך</span>
              <span className={styles.go}>לקחתי</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className={styles.hero}>
      <HeroCanvas />
      <div aria-hidden="true" className={`${styles.orb} ${styles.orbA}`} />
      <div aria-hidden="true" className={`${styles.orb} ${styles.orbB}`} />
      <div aria-hidden="true" className={`${styles.orb} ${styles.orbC}`} />
      <div className={styles.wrap}>
        <span className={styles.tag}>
          <i aria-hidden="true" /> תקופת ניסיון חינם · בלי כרטיס אשראי
        </span>
        <h1 id="hero-title" className="text-ln-h1">
          ליד נכנס.
          <br />
          תוך <span className={styles.mark}>דקה</span> מישהו מתקשר.
        </h1>
        <p className={`${styles.heroLead} text-ln-lead`}>
          כל ה<RotWord /> של העסק, במקום אחד. בעברית, בטלפון ובמחשב.
        </p>
        <div className={styles.ctas}>
          <Link href={paths.signup} className={`${styles.btn} ${styles.primary}`}>
            הרשמה לתקופת ניסיון
          </Link>
          <a href="#contact" className={`${styles.btn} ${styles.ghost}`}>
            שנחזור אליכם
          </a>
        </div>
        <p className={styles.hint}>מתחילים ב-5 דקות. אפשר לייבא את מה שיש לכם באקסל.</p>
        <PauseButton />
        <ProductMock />
      </div>
    </section>
  );
}

/** DRAFT list of business kinds (the prototype's), until there are customer logos. Written twice so the strip never ends. */
export const MARQUEE_KINDS = ["מספרות", "קליניקות", "קבלנים", "סטודיו ואולפנים", "מטבחים ונגרות", "מכוני כושר", "סוכנויות ביטוח", "משרדי תיווך", "מורים פרטיים", "חנויות"];

export function Marquee() {
  return (
    <div className={styles.marq}>
      <p className="sr-only">מתאים ל{MARQUEE_KINDS.join(", ")}.</p>
      <div className={styles.track} aria-hidden="true">
        {[...MARQUEE_KINDS, ...MARQUEE_KINDS].map((kind, i) => (
          <span key={`${kind}-${i}`}>{kind}</span>
        ))}
      </div>
    </div>
  );
}

const STEPS = [
  { title: "נרשמים ומזמינים את הצוות", text: "שם לעסק, הזמנה במייל לעובדים, וייבוא הלקוחות מאקסל אם יש." },
  { title: "מחברים את מקורות הלידים", text: "טופס לאתר, קוד QR, כרטיס ביקור דיגיטלי, ובקרוב פייסבוק ואינסטגרם." },
  { title: "הצוות עובד מהטלפון", text: 'התראה על כל ליד, "לקחתי" בלחיצה, חיוג ו-WhatsApp מהרשימה, ו"היום שלי" לכל אחד.' },
];

export function Steps() {
  return (
    <section aria-labelledby="steps-title" className={styles.sec}>
      <div className={styles.wrap}>
        <span className={styles.eyebrow}>איך זה עובד</span>
        <h2 id="steps-title" className="mt-3 text-ln-h2">
          שלושה צעדים, ואף ליד לא נופל בין הכיסאות
        </h2>
        <ol className={styles.steps}>
          {STEPS.map((step, i) => (
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
  );
}

const MORE = ["הצעות מחיר", "הזמנות", "תשלומים וגבייה", "דף קביעת תור", "מסמכים לחתימה", "כרטיסיות", "כרטיס ביקור וקוד QR", "אוטומציות", "דוחות", "ייבוא מאקסל", "צוותים והרשאות", "אימות דו-שלבי"];

export function ProductBlocks() {
  return (
    <section aria-labelledby="blocks-title" className={`${styles.sec} ${styles.alt}`}>
      <div className={styles.wrap}>
        <span className={styles.eyebrow}>מה שחשוב באמת</span>
        <h2 id="blocks-title" className="mt-3 text-ln-h2">
          שלושה דברים שהמערכת עושה בשבילכם כל יום
        </h2>

        <div className={styles.block}>
          <div className={styles.txt}>
            <h3 className="text-ln-h3">לידים: כל פנייה במקום אחד, עם שעון</h3>
            <p>פניות מהאתר, מהטופס ומהטלפון נכנסות לרשימה אחת. ליד שאיש לא ענה לו מקבל שעון, והמנהל רואה את זה לפני שהלקוח הולך למתחרה.</p>
            <ul className={styles.ticks}>
              <li>חיוג ו-WhatsApp בלחיצה מהרשימה</li>
              <li>חלוקה אוטומטית לצוות לפי תור, עומס או כללים</li>
              <li>&quot;לקחתי&quot;: הראשון שלוחץ מקבל את הליד</li>
            </ul>
          </div>
          <div className={styles.shot} role="img" aria-label="רשימת לידים בטלפון עם חיוג ו-WhatsApp לכל ליד">
            <div className={styles.phoneShot} aria-hidden="true">
              <div className={styles.phoneIn}>
                {[
                  ["אורית נחום", "מטבח מודולרי · 3 יח'"],
                  ["גיל ששון", "שיפוץ חדר רחצה"],
                  ["נועה פרידמן", "סטודיו נועה"],
                ].map(([name, line]) => (
                  <div key={name} className={styles.row}>
                    <div>
                      <span className={styles.nm}>{name}</span>
                      <br />
                      <small>{line}</small>
                    </div>
                    <div className={styles.act}>
                      <span>
                        <PhoneIcon className="size-4" />
                      </span>
                      <span>
                        <ChatIcon className="size-4" />
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className={styles.block}>
          <div className={styles.txt}>
            <h3 className="text-ln-h3">עסקאות: לוח שמראה איפה כל שקל תקוע</h3>
            <p>שלבי המכירה שלכם, סכום פתוח בכל שלב, ועסקה שנתקעה יותר מדי זמן מסומנת. גוררים לשלב הבא וממשיכים.</p>
            <ul className={styles.ticks}>
              <li>הצעת מחיר מהקטלוג, PDF ממותג וחתימה מהטלפון</li>
              <li>הצעה שאושרה הופכת להזמנה</li>
              <li>יעד לעסק, לצוות ולנציג</li>
            </ul>
          </div>
          <div className={styles.shot} role="img" aria-label="לוח עסקאות בשלושה שלבים עם סכום פתוח בכל שלב">
            <div className={styles.board} aria-hidden="true">
              <div className={styles.col}>
                <h5>
                  פנייה <b>₪48,000</b>
                </h5>
                <div className={styles.card}>
                  כהן ובניו<small>₪18,000 · 3 ימים</small>
                </div>
                <div className={styles.card}>
                  סטודיו נועה<small>₪30,000 · היום</small>
                </div>
              </div>
              <div className={styles.col}>
                <h5>
                  הצעה <b>₪112,500</b>
                </h5>
                <div className={`${styles.card} ${styles.drag}`}>
                  מזרחי נכסים<small>₪64,500 · נצפתה</small>
                </div>
                <div className={styles.card}>
                  שלום הפקות<small>₪48,000 · 9 ימים ⚠</small>
                </div>
              </div>
              <div className={styles.col}>
                <h5>
                  נסגר <b>₪84,000</b>
                </h5>
                <div className={styles.card}>
                  רוזן אדריכלים<small>₪84,000 · אתמול</small>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.block}>
          <div className={styles.txt}>
            <h3 className="text-ln-h3">כסף: מספר אחד כל בוקר</h3>
            <p>עסקאות תקועות, הצעות פתוחות וחובות באיחור, מסוכמים לשקל אחד. לכל שורה יש פעולה אחת, ותזכורות הגבייה יוצאות לבד.</p>
            <ul className={styles.ticks}>
              <li>רישום תשלומים, צ&apos;קים והחזרים</li>
              <li>כרטסת לקוח וחובות לפי גיל</li>
              <li>כרטיסיות שנפתחות עם התשלום</li>
            </ul>
          </div>
          <div className={`${styles.shot} ${styles.money}`} role="img" aria-label="מסך כסף שמחכה: סכום אחד ושלוש שורות">
            <div aria-hidden="true">
              <div className={`${styles.big} text-ln-money`}>₪224,790</div>
              <div className={styles.cap}>מחכה לכם השבוע</div>
              <div className={styles.moneyRows}>
                <div>
                  <span>הצעות פתוחות (6)</span>
                  <b>₪112,500</b>
                </div>
                <div>
                  <span>עסקאות תקועות (4)</span>
                  <b>₪71,290</b>
                </div>
                <div>
                  <span>חובות באיחור (3)</span>
                  <b>₪41,000</b>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className={styles.more}>
          {MORE.map((item) => (
            <span key={item}>{item}</span>
          ))}
          <Link href={paths.features}>כל היכולות ←</Link>
        </div>
      </div>
    </section>
  );
}

export const FOUNDER_QUOTE = {
  text: "בניתי את Mexuz כי ראיתי עסקים טובים מפספסים לידים רק כי הטלפון צלצל בזמן הלא נכון. המערכת דואגת שכל פנייה תגיע למישהו, ושאף אחד לא יצטרך לזכור בראש.",
  name: "מתן זזון",
  role: "מייסד Mexuz",
};

export function Quote() {
  return (
    <section aria-label="מהמייסד" className={`${styles.sec} ${styles.alt}`}>
      <div className={styles.wrap}>
        <figure className={styles.quote}>
          <blockquote className="text-ln-quote">&quot;{FOUNDER_QUOTE.text}&quot;</blockquote>
          <figcaption>
            <b>{FOUNDER_QUOTE.name}</b> · {FOUNDER_QUOTE.role}
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

export const FAQ = [
  { q: "כמה זמן לוקח להתחיל?", a: "נרשמים, נותנים שם לעסק ומוסיפים ליד תוך דקות. ייבוא הלקוחות מאקסל לוקח כרבע שעה, ואפשר לבטל ייבוא." },
  { q: "הנתונים שלי בטוחים?", a: "המידע שלכם שמור במסד נתונים באיחוד האירופי (אירלנד), עם הפרדה מלאה בין עסקים, אימות דו-שלבי ויומן של כל שינוי. אפשר לייצא הכול בכל רגע." },
  { q: "אפשר לייבא ממערכת אחרת?", a: "כן. Excel או CSV, עם מיפוי עמודות, זיהוי כפולים, ויצירת סטטוסים ומקורות שחסרים תוך כדי." },
  { q: "אפשר לבטל בכל עת?", a: "כן, בלי התחייבות. הביטול נכנס לתוקף בסוף התקופה ששולמה, והנתונים זמינים לייצוא לפני הסגירה." },
  { q: "יש WhatsApp?", a: "חיוג ו-WhatsApp בלחיצה מכל ליד ואיש קשר כבר היום, עם תבניות הודעה. הודעות אוטומטיות ב-WhatsApp בדרך." },
  { q: "כמה עולה SMS?", a: "לכל חבילה יש מכסה חודשית כלולה. מעבר לה: 20 אגורות להודעה, מארנק שטוענים מראש." },
];

export function Faq() {
  return (
    <section aria-labelledby="faq-title" className={styles.sec}>
      <div className={`${styles.wrap} ${styles.center}`}>
        <span className={styles.eyebrow}>שאלות נפוצות</span>
        <h2 id="faq-title" className="mt-3 text-ln-h2">
          מה שכולם שואלים לפני שמתחילים
        </h2>
        <div className={styles.faq}>
          {FAQ.map((item) => (
            <details key={item.q}>
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Cta() {
  return (
    <section aria-labelledby="cta-title" className={`${styles.sec} ${styles.cta}`}>
      <div className={styles.wrap}>
        <h2 id="cta-title" className="text-ln-h2">
          מתחילים בכמה דקות
        </h2>
        <p>נרשמים, נותנים שם לעסק, ומוסיפים את הליד הראשון. אפשר לייבא את מה שיש לכם באקסל.</p>
        <Link href={paths.signup} className={`${styles.btn} ${styles.ctaBtn}`}>
          הרשמה לתקופת ניסיון
        </Link>
      </div>
    </section>
  );
}

export function LandingFooter() {
  const legal = LEGAL_DOCUMENTS.filter((doc) => ["terms", "privacy", "dpa", "accessibility"].includes(doc.slug));
  return (
    <footer className={styles.footer}>
      <div className={`${styles.wrap} ${styles.footerInner}`}>
        <span>
          Mexuz ·{" "}
          <a href={SUPPORT.whatsappHref} dir="ltr">
            WhatsApp {SUPPORT_PHONE}
          </a>
        </span>
        <nav aria-label="מידע ומסמכים">
          <ul>
            <li>
              <Link href={paths.help}>מרכז עזרה</Link>
            </li>
            <li>
              <Link href={paths.roadmap}>מפת דרכים</Link>
            </li>
            {(legal.length ? legal : LEGAL_DOCUMENTS).map((doc) => (
              <li key={doc.slug}>
                <Link href={paths.legal(doc.slug)}>{doc.title}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
