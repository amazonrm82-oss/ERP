// USR-11 second part / WAB-03 / MNY-03: the text of the daily summary email. Pure: it takes the counts public.digest_job_compose
// answered (computed under the recipient's own read rules, owner (375) ב) and builds the subject and the plain text. Numbers and
// links only: never a customer's name, phone, email or a record's title (WAB-03 keeps the same rule for WhatsApp). The wording is
// the draft the owner approved (378) א.
// A staff email: it does not go through customer consent (the recipient is the business's own person); it waits for the
// recipient's quiet hours (the queue's run time, app.digest_run_at) and carries a one-click stop link (owner (377) ב).

import { MONEY_GROUPS, type MoneyGroupKey } from "@/features/money-waiting/groups";
import { formatMoney, formatNumber } from "@/lib/format";

import type { DigestKind } from "./settings";

/** MNY-01's groups of money waiting, the three largest shown under the total (MNY-03). */
export type DigestMoneyLine = { label: string; agorot: number };

export type DigestCounts = {
  /** leads that arrived since the previous business day began (the business lines; null = not shown) */
  newLeads: number | null;
  /** leads waiting for a first contact (the SPD-02 rule, the recipient's view; null = the leads module is off) */
  waitingLeads: number | null;
  /** open tasks past their due time (the recipient's own; what a manager reads for 'manager') */
  overdueTasks: number;
  /** the recipient's own tasks still ahead today */
  tasksToday: number;
  /** MNY-01's total, null when the summary has no money part; `vat` says whether the amounts include VAT */
  moneyWaiting: { totalAgorot: number; lines: DigestMoneyLine[]; vat?: "included" | "none" | "unknown" } | null;
};

export type DigestLinks = {
  myDay: string;
  leadsWaiting: string;
  tasks: string;
  moneyWaiting: string;
  settings: string;
  /** the one-click stop page (owner (377) ב) */
  stop: string;
};

export type DigestEmailInput = {
  kind: DigestKind;
  businessName: string;
  /** the business day in Hebrew, e.g. "יום שני, 16 בנובמבר" */
  dayLabel: string;
  /** null = the person reads nothing: fixed text and a link only (owner (375) ב) */
  counts: DigestCounts | null;
  /** absolute https links, made by the sender from NEXT_PUBLIC_SITE_URL */
  links: DigestLinks;
};

export type DigestEmail = { subject: string; text: string; links: string[] };

/** A business name as one line: no control characters, at most 80 characters. */
function cleanName(name: string): string {
  const flat = name.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return (flat || "העסק").slice(0, 80);
}

const count = (n: number) => formatNumber(Math.max(0, Math.trunc(Number.isFinite(n) ? n : 0)));

/** The three largest money groups, larger first; groups at zero are left out. */
export function topMoneyLines(lines: DigestMoneyLine[]): DigestMoneyLine[] {
  return lines
    .filter((l) => Number.isFinite(l.agorot) && l.agorot > 0)
    .sort((a, b) => b.agorot - a.agorot)
    .slice(0, 3);
}

const MONEY_KEYS: MoneyGroupKey[] = ["debts", "quotes", "stuck", "overdue", "renewals"];
const asCount = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * public.digest_job_compose's `counts` as the email takes them; null for no counts (the person reads nothing) or a shape that is
 * not the database's (then the email says nothing but the fixed text, never a wrong number).
 */
export function digestCountsFrom(raw: unknown): DigestCounts | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.reads_anything !== true) return null;
  const overdue = asCount(r.overdue_tasks);
  const today = asCount(r.tasks_today);
  if (overdue === null || today === null) return null;
  let money: DigestCounts["moneyWaiting"] = null;
  const m = r.money;
  if (m && typeof m === "object" && !Array.isArray(m)) {
    const groups = (m as { groups?: unknown }).groups;
    const vat = (m as { vat_mode?: unknown }).vat_mode;
    if (groups && typeof groups === "object" && !Array.isArray(groups)) {
      const g = groups as Record<string, unknown>;
      const lines = MONEY_KEYS.flatMap((key) => {
        const agorot = asCount(g[key]);
        const group = MONEY_GROUPS.find((x) => x.key === key);
        return agorot === null || !group ? [] : [{ label: group.title, agorot }];
      });
      money = {
        totalAgorot: lines.reduce((sum, l) => sum + Math.max(0, l.agorot), 0),
        lines,
        vat: vat === "none" || vat === "unknown" ? vat : "included",
      };
    }
  }
  return { newLeads: asCount(r.new_leads), waitingLeads: asCount(r.waiting_leads), overdueTasks: overdue, tasksToday: today, moneyWaiting: money };
}

const VAT_MARK = { included: ' (כולל מע"מ)', none: "", unknown: ' (לפני מע"מ)' } as const;

export function buildDigestEmail(input: DigestEmailInput): DigestEmail {
  const business = cleanName(input.businessName);
  const { counts, links } = input;
  const subject = `הסיכום היומי שלכם ב${business}: ${input.dayLabel}`.slice(0, 255);
  const lines: string[] = [`בוקר טוב,`, `זה הסיכום של ${input.dayLabel} ב${business}.`, ""];
  const used: string[] = [links.myDay];

  if (!counts) {
    // owner (375) ב: a person who reads nothing gets fixed text and a link only
    lines.push("כל מה שמחכה לכם היום נמצא במסך היום שלי.", "", `היום שלי: ${links.myDay}`);
  } else {
    if (input.kind === "manager") {
      if (counts.newLeads !== null) lines.push(`לידים חדשים מאתמול: ${count(counts.newLeads)}`);
      if (counts.waitingLeads !== null) lines.push(`לידים שמחכים למגע ראשון: ${count(counts.waitingLeads)}`);
      lines.push(`משימות באיחור בצוות: ${count(counts.overdueTasks)}`);
    } else {
      if (counts.waitingLeads !== null) lines.push(`לידים שלכם שמחכים למגע ראשון: ${count(counts.waitingLeads)}`);
      lines.push(`משימות שלכם באיחור: ${count(counts.overdueTasks)}`);
    }
    lines.push(`משימות שלכם להיום: ${count(counts.tasksToday)}`);

    if (counts.moneyWaiting && counts.moneyWaiting.totalAgorot > 0) {
      const mark = VAT_MARK[counts.moneyWaiting.vat ?? "included"];
      lines.push("", `כסף שמחכה${mark}: ${formatMoney(counts.moneyWaiting.totalAgorot)}`);
      for (const line of topMoneyLines(counts.moneyWaiting.lines)) {
        lines.push(`· ${line.label}: ${formatMoney(line.agorot)}`);
      }
      lines.push(`לפירוט: ${links.moneyWaiting}`);
      used.push(links.moneyWaiting);
    }

    lines.push("", `היום שלי: ${links.myDay}`);
    if (counts.waitingLeads !== null) {
      lines.push(`לידים שמחכים: ${links.leadsWaiting}`);
      used.push(links.leadsWaiting);
    }
    lines.push(`משימות: ${links.tasks}`);
    used.push(links.tasks);
  }

  lines.push(
    "",
    "—",
    "קיבלתם את המייל הזה כי הפעלתם סיכום יומי במקסוז.",
    `להפסקת הסיכום בלחיצה אחת: ${links.stop}`,
    `לשינוי השעה או להפעלה מחדש: ${links.settings}`,
  );
  used.push(links.stop, links.settings);
  return { subject, text: lines.join("\n"), links: used };
}

/** The business day "YYYY-MM-DD" as the email names it, e.g. "יום שני, 16 בנובמבר"; null for anything else. */
export function digestDayLabel(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  return new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(date);
}
