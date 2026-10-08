import type { ReactNode } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import {
  BellIcon,
  BoardIcon,
  BuildingIcon,
  ChatIcon,
  CheckSquareIcon,
  ChevronIcon,
  HomeIcon,
  InboxIcon,
  MailIcon,
  PhoneIcon,
  PlusIcon,
  SearchIcon,
  UsersIcon,
} from "@/components/ui/icons";
import { cn } from "@/lib/cn";

// DSN-02: the screens the owner chooses a direction on. They are drawn with the
// app's own pieces (buttons, badges, icons, colour and size tokens) and sample
// data, so a direction looks here as it will in the app. Each is laid out for
// its frame with container queries: narrow is the phone, @3xl and up the computer.

const H = "[font-weight:var(--heading-weight)]";

type Lead = { name: string; phone: string; status: string; tone: BadgeTone; source: string; owner: string; when: string };

const LEADS: Lead[] = [
  { name: "נועה כהן", phone: "052-123-4567", status: "חדש", tone: "accent", source: "טופס באתר", owner: "דנה", when: "לפני 12 דק'" },
  { name: "אבי לוי", phone: "054-765-4321", status: "נוצר קשר", tone: "neutral", source: "פייסבוק", owner: "רונית", when: "לפני שעה" },
  { name: "מיכל אברהם", phone: "050-222-3344", status: "פגישה נקבעה", tone: "success", source: "המלצה", owner: "דנה", when: "אתמול" },
  { name: "יוסי מזרחי", phone: "053-888-1212", status: "מחכה להצעה", tone: "warning", source: "טופס באתר", owner: "רונית", when: "אתמול" },
  { name: "שירה פרץ", phone: "058-444-9090", status: "לא רלוונטי", tone: "danger", source: "גוגל", owner: "דנה", when: "לפני 3 ימים" },
];

const NAV = [
  { label: "היום שלי", icon: HomeIcon },
  { label: "לידים", icon: InboxIcon },
  { label: "עסקאות", icon: BoardIcon },
  { label: "משימות", icon: CheckSquareIcon },
  { label: "אנשי קשר", icon: UsersIcon },
];

/** The app frame: top bar and bottom bar on the phone, side menu on the computer. */
function AppShell({ active, title, action, children }: { active: number; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 bg-canvas">
      <aside className="hidden w-60 shrink-0 flex-col gap-1 bg-[var(--color-chrome)] p-3 @3xl:flex">
        <div className={cn("mb-4 px-2 py-1 text-lg text-[var(--color-chrome-ink)]", H)}>Mexuz</div>
        {NAV.map((item, i) => (
          <span
            key={item.label}
            className={cn(
              "flex min-h-10 items-center gap-3 rounded-md px-3 text-[0.9375rem]",
              i === active ? "bg-accent text-white" : "text-[var(--color-chrome-ink-soft)]",
            )}
          >
            <item.icon className="size-5" />
            {item.label}
          </span>
        ))}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 items-center justify-between gap-3 border-b border-line bg-[var(--color-chrome)] px-4">
          <span className={cn("text-lg text-[var(--color-chrome-ink)]", H)}>{title}</span>
          <span className="flex items-center gap-1 text-[var(--color-chrome-ink-soft)]">
            <SearchIcon className="size-5" />
            <span className="relative p-2">
              <BellIcon className="size-5" />
              <span className="absolute end-1 top-1 size-2 rounded-full bg-danger" />
            </span>
          </span>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden p-4 @3xl:p-6">
          {action ? <div className="mb-4 flex justify-end">{action}</div> : null}
          {children}
        </main>
        <nav className="grid grid-cols-5 border-t border-line bg-[var(--color-chrome)] @3xl:hidden">
          {NAV.map((item, i) => (
            <span
              key={item.label}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[0.6875rem]",
                i === active ? "font-medium text-[var(--color-chrome-active)]" : "text-[var(--color-chrome-ink-soft)]",
              )}
            >
              <item.icon className="size-5" />
              {item.label}
            </span>
          ))}
        </nav>
      </div>
    </div>
  );
}

function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-lg border border-line bg-surface", className)}>{children}</div>;
}

export function TodayScreen() {
  const tasks = [
    { title: "להתקשר לנועה כהן", time: "09:30", kind: "שיחה", late: false },
    { title: "לשלוח הצעת מחיר ליוסי", time: "11:00", kind: "מייל", late: true },
    { title: "פגישה עם מיכל אברהם", time: "14:00", kind: "פגישה", late: false },
  ];
  return (
    <AppShell active={0} title="בוקר טוב, דנה">
      <dl className="grid grid-cols-3 gap-2 @3xl:gap-4">
        {[
          ["לידים חדשים", "6"],
          ["משימות להיום", "4"],
          ["עסקאות פתוחות", "₪184,500"],
        ].map(([label, value]) => (
          <Card key={label} className="p-3 @3xl:p-4">
            <dt className="text-[0.75rem] text-ink-soft @3xl:text-sm">{label}</dt>
            <dd className={cn("mt-1 text-lg tabular-nums @3xl:text-2xl", H)}>{value}</dd>
          </Card>
        ))}
      </dl>
      <div className="mt-4 grid gap-4 @3xl:grid-cols-2">
        <Card>
          <h2 className={cn("border-b border-line px-4 py-3", H)}>מה מחכה לך היום</h2>
          <ul className="divide-y divide-line">
            {tasks.map((t) => (
              <li key={t.title} className="flex items-center gap-3 px-4 py-3">
                <span className="size-5 shrink-0 rounded-sm border-2 border-line-control" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{t.title}</span>
                  <span className={cn("text-sm", t.late ? "text-danger" : "text-ink-soft")}>
                    {t.late ? "באיחור · " : ""}
                    <span dir="ltr">{t.time}</span> · {t.kind}
                  </span>
                </span>
                <span className="rounded-full bg-accent-soft p-2 text-accent-strong">
                  <PhoneIcon className="size-4" />
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="hidden @3xl:block">
          <h2 className={cn("border-b border-line px-4 py-3", H)}>לידים אחרונים</h2>
          <ul className="divide-y divide-line">
            {LEADS.slice(0, 4).map((l) => (
              <li key={l.name} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="font-medium">{l.name}</span>
                <Badge tone={l.tone}>{l.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </AppShell>
  );
}

export function LeadsScreen() {
  return (
    <AppShell
      active={1}
      title="לידים"
      action={
        <span className={buttonClasses("primary", "md")}>
          <PlusIcon className="size-5" />
          ליד חדש
        </span>
      }
    >
      <div className="mb-3 flex items-center gap-2 rounded-md border border-line-control bg-surface px-3 py-2 text-ink-soft">
        <SearchIcon className="size-5" />
        חיפוש לפי שם, טלפון או אימייל
      </div>
      <div className="mb-3 flex gap-2 overflow-hidden">
        {["כל הלידים", "שלי", "חדשים", "מחכים לטיפול"].map((chip, i) => (
          <span
            key={chip}
            className={cn(
              "rounded-full border px-3 py-1 text-sm whitespace-nowrap",
              i === 0 ? "border-accent bg-accent-soft text-accent-strong" : "border-line bg-surface text-ink-soft",
            )}
          >
            {chip}
          </span>
        ))}
      </div>
      {/* phone: cards */}
      <ul className="space-y-2 @3xl:hidden">
        {LEADS.map((l) => (
          <li key={l.name}>
            <Card className="flex items-center gap-3 p-3">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{l.name}</span>
                  <Badge tone={l.tone}>{l.status}</Badge>
                </span>
                <span className="mt-0.5 block text-sm text-ink-soft">
                  <span dir="ltr">{l.phone}</span> · {l.source} · {l.when}
                </span>
              </span>
              <ChevronIcon className="size-5 shrink-0 text-ink-soft" />
            </Card>
          </li>
        ))}
      </ul>
      {/* computer: table */}
      <Card className="hidden overflow-hidden @3xl:block">
        <table className="w-full text-start text-[0.9375rem]">
          <thead className="bg-canvas text-sm text-ink-soft">
            <tr>
              {["שם", "טלפון", "סטטוס", "מקור", "בעלים", "נוצר"].map((h) => (
                <th key={h} className="px-4 py-2.5 text-start font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {LEADS.map((l) => (
              <tr key={l.name}>
                <td className="px-4 py-2.5 font-medium text-accent-strong">{l.name}</td>
                <td className="px-4 py-2.5 tabular-nums" dir="ltr">
                  {l.phone}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={l.tone}>{l.status}</Badge>
                </td>
                <td className="px-4 py-2.5 text-ink-soft">{l.source}</td>
                <td className="px-4 py-2.5 text-ink-soft">{l.owner}</td>
                <td className="px-4 py-2.5 text-ink-soft">{l.when}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </AppShell>
  );
}

export function LeadCardScreen() {
  const timeline = [
    { who: "דנה", what: "שיחה: מעוניינת בשיפוץ מטבח, תקציב עד 60 אלף. לחזור אליה ביום ראשון.", when: "היום 09:41" },
    { who: "טופס באתר", what: "\"שלום, אשמח להצעת מחיר לשיפוץ מטבח ואמבטיה בדירת 4 חדרים.\"", when: "היום 09:12" },
  ];
  return (
    <AppShell active={1} title="נועה כהן">
      <div className="grid gap-4 @3xl:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={cn("text-xl", H)}>נועה כהן</h2>
              <Badge tone="accent">חדש</Badge>
            </div>
            <p className="mt-1 text-sm text-ink-soft">טופס באתר · דנה · לפני 12 דקות</p>
            <div className="mt-4 grid grid-cols-3 gap-2">
              {[
                { label: "שיחה", icon: PhoneIcon },
                { label: "וואטסאפ", icon: ChatIcon },
                { label: "אימייל", icon: MailIcon },
              ].map((b) => (
                <span key={b.label} className={buttonClasses(b.label === "שיחה" ? "primary" : "secondary", "md")}>
                  <b.icon className="size-5" />
                  {b.label}
                </span>
              ))}
            </div>
          </Card>
          <Card>
            <h3 className={cn("border-b border-line px-4 py-3", H)}>מה קרה עד עכשיו</h3>
            <ol className="divide-y divide-line">
              {timeline.map((t) => (
                <li key={t.when} className="px-4 py-3">
                  <p className="text-[0.9375rem]">{t.what}</p>
                  <p className="mt-1 text-sm text-ink-soft">
                    {t.who} · {t.when}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <Card className="h-fit p-4">
          <h3 className={cn("mb-3", H)}>פרטים</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[0.9375rem]">
            <dt className="text-ink-soft">טלפון</dt>
            <dd dir="ltr" className="text-end tabular-nums">
              052-123-4567
            </dd>
            <dt className="text-ink-soft">אימייל</dt>
            <dd dir="ltr" className="truncate text-end">
              noa@example.co.il
            </dd>
            <dt className="text-ink-soft">עיר</dt>
            <dd>רמת גן</dd>
            <dt className="text-ink-soft">תקציב</dt>
            <dd className="tabular-nums">₪60,000</dd>
          </dl>
        </Card>
      </div>
    </AppShell>
  );
}

export function DealBoardScreen() {
  const columns = [
    { stage: "חדשה", total: "₪72,000", deals: [["מטבח, נועה כהן", "₪60,000"], ["תיקון רטיבות", "₪12,000"]] },
    { stage: "הצעה נשלחה", total: "₪98,500", deals: [["שיפוץ דירה, יוסי מזרחי", "₪85,000"], ["צביעה, משרדי אלון", "₪13,500"]] },
    { stage: "משא ומתן", total: "₪14,000", deals: [["אמבטיה, מיכל אברהם", "₪14,000"]] },
    { stage: "נסגרה", total: "₪41,000", deals: [["מרפסת, משפחת רז", "₪41,000"]] },
  ];
  return (
    <AppShell active={2} title="עסקאות">
      <div className="flex gap-3 overflow-hidden">
        {columns.map((col) => (
          <section key={col.stage} className="w-64 shrink-0 rounded-lg bg-line/60 p-2 @3xl:flex-1">
            <header className="mb-2 flex items-baseline justify-between px-1">
              <h3 className={cn("text-[0.9375rem]", H)}>{col.stage}</h3>
              <span className="text-sm text-ink-soft tabular-nums">{col.total}</span>
            </header>
            <ul className="space-y-2">
              {col.deals.map(([name, amount]) => (
                <li key={name}>
                  <Card className="p-3">
                    <p className="font-medium">{name}</p>
                    <p className="mt-1 text-sm text-ink-soft tabular-nums">{amount}</p>
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </AppShell>
  );
}

function Field({ label, placeholder, ltr }: { label: string; placeholder?: string; ltr?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[0.9375rem] font-medium">{label}</span>
      <span
        dir={ltr ? "ltr" : undefined}
        className="flex min-h-11 items-center rounded-md border border-line-control bg-surface px-3 text-ink-soft"
      >
        {placeholder ?? ""}
      </span>
    </label>
  );
}

export function LoginScreen() {
  return (
    <div className="flex h-full items-center justify-center bg-canvas p-4">
      <Card className="w-full max-w-sm p-6">
        <p className={cn("text-center text-2xl text-accent-strong", H)}>Mexuz</p>
        <h2 className={cn("mt-4 text-xl", H)}>כניסה</h2>
        <div className="mt-4 space-y-3">
          <Field label="אימייל" placeholder="name@example.co.il" ltr />
          <Field label="סיסמה" />
        </div>
        <span className={buttonClasses("primary", "md", "mt-5 w-full")}>כניסה</span>
        <span className={buttonClasses("secondary", "md", "mt-2 w-full")}>כניסה עם Google</span>
        <p className="mt-4 text-center text-sm">
          <span className="text-accent underline underline-offset-4">שכחתי סיסמה</span>
          <span className="text-ink-soft"> · </span>
          <span className="text-accent underline underline-offset-4">הרשמה</span>
        </p>
      </Card>
    </div>
  );
}

export function PublicFormScreen() {
  return (
    <div className="flex h-full items-start justify-center bg-canvas p-4 @3xl:items-center">
      <Card className="w-full max-w-md p-6">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-md bg-accent-soft text-accent-strong">
            <BuildingIcon className="size-6" />
          </span>
          <span>
            <span className={cn("block", H)}>שיפוצים בע&quot;מ</span>
            <span className="text-sm text-ink-soft">השאירו פרטים ונחזור אליכם</span>
          </span>
        </div>
        <div className="mt-5 space-y-3">
          <Field label="שם מלא" />
          <Field label="טלפון" ltr />
          <Field label="אימייל" ltr />
          <label className="block">
            <span className="mb-1 block text-[0.9375rem] font-medium">במה נוכל לעזור?</span>
            <span className="block h-20 rounded-md border border-line-control bg-surface" />
          </label>
        </div>
        <span className={buttonClasses("primary", "md", "mt-5 w-full")}>שליחה</span>
        <p className="mt-3 text-center text-[0.75rem] text-ink-soft">הפרטים נשמרים אצל שיפוצים בע&quot;מ בלבד.</p>
      </Card>
    </div>
  );
}

export const SCREENS = [
  { key: "today", label: "היום שלי", Screen: TodayScreen },
  { key: "leads", label: "רשימת לידים", Screen: LeadsScreen },
  { key: "lead", label: "כרטיס ליד", Screen: LeadCardScreen },
  { key: "deals", label: "לוח עסקאות", Screen: DealBoardScreen },
  { key: "login", label: "כניסה", Screen: LoginScreen },
  { key: "form", label: "טופס ציבורי", Screen: PublicFormScreen },
] as const;
