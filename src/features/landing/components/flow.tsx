import styles from "./landing.module.css";

// LND-20 v2 (4) "מאיפה שלא יגיע": the prototype's diagram, five sources into Mexuz and out to four people. Names and places
// are demo data. The dots run with SVG animateMotion; the page's pause button and prefers-reduced-motion stop them
// (pause-button.tsx, landing.module.css). One picture for screen readers (role img with a label).
const LABEL = "פניות מכל המקורות נכנסות ל-Mexuz ומחולקות לצוות";

const SOURCES = [
  { y: 50, title: "פייסבוק ואינסטגרם", sub: "Lead Ads, בקרוב", dur: 2.2, begin: 0, short: "פייסבוק ואינסטגרם" },
  { y: 130, title: "טופס באתר", sub: "וכפתור צף", dur: 2.55, begin: 0.5, short: "טופס באתר" },
  { y: 210, title: "קוד QR", sub: "שלט, פלייר, רכב", dur: 2.9, begin: 1, short: "קוד QR" },
  { y: 290, title: "כרטיס ביקור דיגיטלי", sub: "וואטסאפ וחיוג", dur: 3.25, begin: 1.5, short: "כרטיס ביקור" },
  { y: 370, title: "דף קביעת תור", sub: "הלקוח בוחר שעה", dur: 3.6, begin: 2, short: "דף קביעת תור" },
];
const PEOPLE = [
  { y: 70, name: "רונית", role: 'מכירות · ראשל"צ', dur: 2.0, begin: 1.0 },
  { y: 165, name: "יוסי", role: "מכירות · ירושלים", dur: 2.4, begin: 1.6 },
  { y: 260, name: "דנה", role: "שירות", dur: 2.8, begin: 2.2 },
  { y: 355, name: "צוות ב'", role: "לפי תור", dur: 3.2, begin: 2.8 },
];

function Wire({ d, dur, begin, r }: { d: string; dur: number; begin: number; r: number }) {
  return (
    <>
      <path className={styles.path} d={d} />
      <path className={`${styles.path} ${styles.live}`} d={d} />
      <circle className={styles.dot} r={r}>
        <animateMotion dur={`${dur}s`} repeatCount="indefinite" begin={`${begin}s`} path={d} />
      </circle>
    </>
  );
}

function Pulse({ cx, cy, r, from, to }: { cx: number; cy: number; r: number; from: number; to: number }) {
  return (
    <circle className={styles.ring} cx={cx} cy={cy} r={r}>
      <animate attributeName="r" values={`${from};${to};${from}`} dur="3s" repeatCount="indefinite" />
      <animate attributeName="stroke-opacity" values=".5;0;.5" dur="3s" repeatCount="indefinite" />
    </circle>
  );
}

function Desktop() {
  return (
    <svg data-landing-svg className={styles.flowDesk} viewBox="0 0 960 420" role="img" aria-label={LABEL}>
      {SOURCES.map((s) => (
        <g key={s.title}>
          <Wire d={`M710 ${s.y} C 620 ${s.y}, 660 210, 550 210`} dur={s.dur} begin={s.begin} r={5} />
          <rect className={styles.src} x={710} y={s.y - 26} width={230} height={52} rx={12} />
          <text className={styles.srct} x={925} y={s.y - 3} textAnchor="start">
            {s.title}
          </text>
          <text className={styles.srcs} x={925} y={s.y + 16} textAnchor="start">
            {s.sub}
          </text>
        </g>
      ))}
      {PEOPLE.map((p) => (
        <g key={p.name}>
          <Wire d={`M410 210 C 300 210, 340 ${p.y}, 235 ${p.y}`} dur={p.dur} begin={p.begin} r={5} />
          <rect className={styles.who} x={45} y={p.y - 26} width={190} height={52} rx={26} />
          <circle className={styles.whoDot} cx={208} cy={p.y} r={16} />
          <text className={styles.whot} x={184} y={p.y - 3} textAnchor="start">
            {p.name}
          </text>
          <text className={styles.whos} x={184} y={p.y + 15} textAnchor="start">
            {p.role}
          </text>
        </g>
      ))}
      <circle className={styles.hub} cx={480} cy={210} r={72} />
      <Pulse cx={480} cy={210} r={84} from={80} to={96} />
      <text className={styles.hubt} x={480} y={212} textAnchor="middle">
        Mexuz
      </text>
      <text className={styles.hubs} x={480} y={234} textAnchor="middle">
        חלוקה · שעון · התראה
      </text>
      <text className={styles.ok} x={300} y={400} textAnchor="middle">
        ✓ כל ליד אצל מישהו תוך דקה
      </text>
    </svg>
  );
}

function Phone() {
  const xs = [40, 110, 180, 250, 320];
  const ps = [55, 138, 222, 305];
  return (
    <svg data-landing-svg className={styles.flowPhone} viewBox="0 0 360 560" role="img" aria-label={LABEL}>
      {SOURCES.map((s, i) => (
        <g key={s.title}>
          <Wire d={`M${xs[i]} 82 C ${xs[i]} 180, 180 140, 180 220`} dur={2 + i * 0.3} begin={i * 0.4} r={4} />
          <rect className={styles.src} x={xs[i] - 32} y={38} width={64} height={44} rx={10} />
          <text className={styles.srcm} x={xs[i]} y={64} textAnchor="middle">
            {s.short}
          </text>
        </g>
      ))}
      {PEOPLE.map((p, i) => (
        <g key={p.name}>
          <Wire d={`M180 340 C 180 430, ${ps[i]} 370, ${ps[i]} 454`} dur={2 + i * 0.4} begin={1 + i * 0.5} r={4} />
          <rect className={styles.who} x={ps[i] - 36} y={454} width={72} height={52} rx={26} />
          <circle className={styles.whoDot} cx={ps[i]} cy={474} r={10} />
          <text className={styles.whom} x={ps[i]} y={498} textAnchor="middle">
            {p.name}
          </text>
        </g>
      ))}
      <circle className={styles.hub} cx={180} cy={280} r={60} />
      <Pulse cx={180} cy={280} r={70} from={66} to={82} />
      <text className={styles.hubt} x={180} y={282} textAnchor="middle">
        Mexuz
      </text>
      <text className={styles.hubs} x={180} y={302} textAnchor="middle">
        חלוקה · שעון · התראה
      </text>
      <text className={styles.ok} x={180} y={545} textAnchor="middle">
        ✓ כל ליד אצל מישהו תוך דקה
      </text>
    </svg>
  );
}

export function FlowSection() {
  return (
    <section aria-labelledby="flow-title" className={styles.flow}>
      <div className={styles.wrap}>
        <div className={styles.flowTop}>
          <span className={styles.eyebrow}>מאיפה שלא יגיע</span>
          <h2 id="flow-title" className="mt-3 text-ln-h2">
            כל פנייה נכנסת למקום אחד, ויוצאת לאדם
          </h2>
        </div>
        <div className={styles.flowbox}>
          <Desktop />
          <Phone />
        </div>
      </div>
    </section>
  );
}
