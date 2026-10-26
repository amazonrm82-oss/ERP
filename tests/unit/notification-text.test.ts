import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { leadsWaitingText } from "@/features/notifications/lead-count";
import { NOT_NOTIFICATION_LITERALS, NOTIFICATION_PATTERNS, notificationText, type NotificationTextRow } from "@/features/notifications/notification-text";
import { DEFAULT_TERMS, resolveTerms } from "@/features/terminology/terms";

// every word masculine: מתעניין, לקוח, תיק
const MASCULINE = resolveTerms({ contact: "customer", lead: "prospect", deal: "case" });
// lead and deal feminine (פנייה, הזדמנות); every contact word is masculine, so the contact is מטופל here
const FEMININE = resolveTerms({ contact: "patient", lead: "inquiry", deal: "opportunity" });

type Case = { pattern: string; row: NotificationTextRow; field: "title" | "body"; masculine: string; feminine: string };

const row = (type: string, title: string, body: string | null = null): NotificationTextRow => ({ type, title, body });
const deputy = "נבחר ממלא מקום על ידי דנה: יוסי, מ-01.11.2026 עד 05.11.2026";

// one stored text per pattern (written as the database writes it), and how it reads in each set of words
const CASES: Case[] = [
  { pattern: "lead_assigned", field: "title", row: row("lead_new", "ליד חדש הוקצה לכם"), masculine: "מתעניין חדש הוקצה לכם", feminine: "פנייה חדשה הוקצתה לכם" },
  { pattern: "lead_assigned", field: "title", row: row("assigned", "ליד חדש הוקצה לך"), masculine: "מתעניין חדש הוקצה לך", feminine: "פנייה חדשה הוקצתה לך" },
  { pattern: "deal_assigned", field: "title", row: row("assigned", "עסקה הוקצתה לכם"), masculine: "תיק הוקצה לכם", feminine: "הזדמנות הוקצתה לכם" },
  {
    pattern: "lead_unowned",
    field: "title",
    row: row("lead_new", "ליד חדש מחכה למי שייקח אותו"),
    masculine: "מתעניין חדש מחכה למי שייקח אותו",
    feminine: "פנייה חדשה מחכה למי שייקח אותה",
  },
  {
    pattern: "lead_reminder_body",
    field: "body",
    row: row("lead_new", "תזכורת: להתקשר", "הליד עוד לא אצל אף אחד"),
    masculine: "המתעניין עוד לא אצל אף אחד",
    feminine: "הפנייה עוד לא אצל אף אחד",
  },
  { pattern: "response_passed", field: "title", row: row("response_overdue", "ליד הועבר לנציג אחר"), masculine: "מתעניין הועבר לנציג אחר", feminine: "פנייה הועברה לנציג אחר" },
  {
    pattern: "response_passed_managers",
    field: "title",
    row: row("response_overdue", "ליד לא נענה בתוך 60 דקות והועבר"),
    masculine: "מתעניין לא נענה בתוך 60 דקות והועבר",
    feminine: "פנייה לא נענתה בתוך 60 דקות והועברה",
  },
  {
    pattern: "response_overdue",
    field: "title",
    row: row("response_overdue", "ליד מחכה למענה יותר מ-15 דקות"),
    masculine: "מתעניין מחכה למענה יותר מ-15 דקות",
    feminine: "פנייה מחכה למענה יותר מ-15 דקות",
  },
  {
    pattern: "response_unnamed_body",
    field: "body",
    row: row("response_overdue", "ליד הועבר לנציג אחר", "ליד ללא שם · לא נוצר קשר בתוך 60 דקות"),
    masculine: "מתעניין ללא שם · לא נוצר קשר בתוך 60 דקות",
    feminine: "פנייה ללא שם · לא נוצר קשר בתוך 60 דקות",
  },
  { pattern: "mention", field: "title", row: row("mention", "הזכירו אתכם בליד: דנה כהן"), masculine: "הזכירו אתכם במתעניין: דנה כהן", feminine: "הזכירו אתכם בפנייה: דנה כהן" },
  { pattern: "mention", field: "title", row: row("mention", "הזכירו אתכם באיש קשר: איש קשר"), masculine: "הזכירו אתכם בלקוח: לקוח", feminine: "הזכירו אתכם במטופל: מטופל" },
  { pattern: "mention", field: "title", row: row("mention", "הזכירו אתכם בעסקה: חוזה שנתי"), masculine: "הזכירו אתכם בתיק: חוזה שנתי", feminine: "הזכירו אתכם בהזדמנות: חוזה שנתי" },
  { pattern: "follow", field: "title", row: row("follow", "עדכון בליד שבמעקב: ליד"), masculine: "עדכון במתעניין שבמעקב: מתעניין", feminine: "עדכון בפנייה שבמעקב: פנייה" },
  { pattern: "follow", field: "title", row: row("follow", "עדכון באיש קשר שבמעקב: רון"), masculine: "עדכון בלקוח שבמעקב: רון", feminine: "עדכון במטופל שבמעקב: רון" },
  { pattern: "follow", field: "title", row: row("follow", "עדכון בעסקה שבמעקב: חוזה"), masculine: "עדכון בתיק שבמעקב: חוזה", feminine: "עדכון בהזדמנות שבמעקב: חוזה" },
  {
    pattern: "suspended_first_lead",
    field: "title",
    row: row("system", "נכנס ליד חדש לעסק לדוגמה בע\"מ. כדי לראות אותו, חדשו את המנוי."),
    masculine: "נכנס מתעניין חדש לעסק לדוגמה בע\"מ. כדי לראות אותו, חדשו את המנוי.",
    feminine: "נכנסה פנייה חדשה לעסק לדוגמה בע\"מ. כדי לראות אותה, חדשו את המנוי.",
  },
  {
    pattern: "suspended_one_waiting",
    field: "title",
    row: row("system", leadsWaitingText(1, "עסק")),
    masculine: "מתעניין אחד מחכה לכם בעסק. כדי לראות אותו, חדשו את המנוי.",
    feminine: "פנייה אחת מחכה לכם בעסק. כדי לראות אותה, חדשו את המנוי.",
  },
  {
    pattern: "suspended_many_waiting",
    field: "title",
    row: row("system", leadsWaitingText(3, "עסק")),
    masculine: "3 מתעניינים מחכים לכם בעסק. כדי לראות אותם, חדשו את המנוי.",
    feminine: "3 פניות מחכות לכם בעסק. כדי לראות אותן, חדשו את המנוי.",
  },
  {
    pattern: "deputy_body",
    field: "body",
    row: row("system", "ממלא מקום בהיעדרות: דנה", `${deputy}. ממלא המקום רואה בזמן הזה את הרשומות של המשימות הפתוחות והלידים שלא נענו.`),
    masculine: `${deputy}. ממלא המקום רואה בזמן הזה את הרשומות של המשימות הפתוחות והמתעניינים שלא נענו.`,
    feminine: `${deputy}. ממלא המקום רואה בזמן הזה את הרשומות של המשימות הפתוחות והפניות שלא נענו.`,
  },
  { pattern: "erasure_done_body", field: "body", row: row("system", "המחיקה שביקשתם הושלמה", "ליד"), masculine: "מתעניין", feminine: "פנייה" },
  { pattern: "erasure_done_body", field: "body", row: row("system", "המחיקה שביקשתם הושלמה", "איש קשר"), masculine: "לקוח", feminine: "מטופל" },
  {
    pattern: "transfer_body",
    field: "body",
    row: row("assigned", "הועברו אליכם רשומות של דנה", "2 לידים, 3 אנשי קשר, 0 חברות, 1 עסקאות, 4 משימות ו-0 פגישות."),
    masculine: "2 מתעניינים, 3 לקוחות, 0 חברות, 1 תיקים, 4 משימות ו-0 פגישות.",
    feminine: "2 פניות, 3 מטופלים, 0 חברות, 1 הזדמנויות, 4 משימות ו-0 פגישות.",
  },
  {
    pattern: "transfer_body",
    field: "body",
    row: row("assigned", "הועברו אליכם רשומות של דנה", "2 לידים, 3 אנשי קשר, 0 חברות, 1 עסקאות, 4 משימות, 0 פגישות, 5 הצעות מחיר ו-1 הזמנות."),
    masculine: "2 מתעניינים, 3 לקוחות, 0 חברות, 1 תיקים, 4 משימות, 0 פגישות, 5 הצעות מחיר ו-1 הזמנות.",
    feminine: "2 פניות, 3 מטופלים, 0 חברות, 1 הזדמנויות, 4 משימות, 0 פגישות, 5 הצעות מחיר ו-1 הזמנות.",
  },
  {
    pattern: "quote_deal_note_1",
    field: "body",
    row: row("quote", "הצעת מחיר אושרה: שיפוץ", "הצעה Q-1001 · להעביר את העסקה לזכייה ולעדכן את השורות?"),
    masculine: "הצעה Q-1001 · להעביר את התיק לזכייה ולעדכן את השורות?",
    feminine: "הצעה Q-1001 · להעביר את ההזדמנות לזכייה ולעדכן את השורות?",
  },
  {
    pattern: "quote_deal_note_2",
    field: "body",
    row: row("quote", "הצעת מחיר אושרה: שיפוץ", "בתהליך המכירה של העסקה אין שלב זכייה, ולכן העסקה לא הועברה והשורות לא עודכנו."),
    masculine: "בתהליך המכירה של התיק אין שלב זכייה, ולכן התיק לא הועבר והשורות לא עודכנו.",
    feminine: "בתהליך המכירה של ההזדמנות אין שלב זכייה, ולכן ההזדמנות לא הועברה והשורות לא עודכנו.",
  },
  {
    pattern: "quote_deal_note_3",
    field: "body",
    row: row("quote", "הצעת מחיר אושרה: שיפוץ", "הצעה 17 · העסקה לא הועברה לזכייה והשורות לא עודכנו. אפשר לעשות זאת מדף ההצעה."),
    masculine: "הצעה 17 · התיק לא הועבר לזכייה והשורות לא עודכנו. אפשר לעשות זאת מדף ההצעה.",
    feminine: "הצעה 17 · ההזדמנות לא הועברה לזכייה והשורות לא עודכנו. אפשר לעשות זאת מדף ההצעה.",
  },
  {
    pattern: "quote_deal_note_4",
    field: "body",
    row: row("quote", "הצעת מחיר אושרה: שיפוץ", "הצעה Q-1001 · העסקה עברה לזכייה והשורות עודכנו לפי ההצעה."),
    masculine: "הצעה Q-1001 · התיק עבר לזכייה והשורות עודכנו לפי ההצעה.",
    feminine: "הצעה Q-1001 · ההזדמנות עברה לזכייה והשורות עודכנו לפי ההצעה.",
  },
  {
    pattern: "quote_deal_note_5",
    field: "body",
    row: row("quote", "הצעת מחיר אושרה: שיפוץ", "העסקה עברה לזכייה, אבל השורות לא עודכנו לפי ההצעה. אפשר לעדכן אותן בעסקה."),
    masculine: "התיק עבר לזכייה, אבל השורות לא עודכנו לפי ההצעה. אפשר לעדכן אותן בתיק.",
    feminine: "ההזדמנות עברה לזכייה, אבל השורות לא עודכנו לפי ההצעה. אפשר לעדכן אותן בהזדמנות.",
  },
  {
    pattern: "quote_deal_note_6",
    field: "body",
    row: row("quote", "הצעת מחיר אושרה: שיפוץ", "הצעה Q-1001 · לא הצלחנו לטפל בעסקה של ההצעה. אפשר להעביר אותה לזכייה מדף ההצעה."),
    masculine: "הצעה Q-1001 · לא הצלחנו לטפל בתיק של ההצעה. אפשר להעביר אותו לזכייה מדף ההצעה.",
    feminine: "הצעה Q-1001 · לא הצלחנו לטפל בהזדמנות של ההצעה. אפשר להעביר אותה לזכייה מדף ההצעה.",
  },
];

describe("notifications in the business's words (FLD-10 part three)", () => {
  it("every pattern is tested", () => {
    expect(new Set(CASES.map((c) => c.pattern))).toEqual(new Set(NOTIFICATION_PATTERNS.map((p) => p.id)));
  });

  it.each(CASES.map((c) => [`${c.pattern}: ${c.row[c.field]}`, c] as const))("%s", (_name, c) => {
    // today's words read exactly as stored
    expect(notificationText(c.row, DEFAULT_TERMS)[c.field]).toBe(c.row[c.field]);
    expect(notificationText(c.row, MASCULINE)[c.field]).toBe(c.masculine);
    expect(notificationText(c.row, FEMININE)[c.field]).toBe(c.feminine);
    // the other field is left as it is when no pattern of its own matches
    const other = c.field === "title" ? "body" : "title";
    const otherSame = notificationText(c.row, DEFAULT_TERMS)[other];
    expect(otherSame).toBe(c.row[other]);
  });

  it("leaves what it does not recognise as stored", () => {
    // another kind with the same text, a company, an unknown text, a body that only starts like a known one
    expect(notificationText(row("task_reminder", "ליד חדש הוקצה לכם"), FEMININE).title).toBe("ליד חדש הוקצה לכם");
    expect(notificationText(row("mention", "הזכירו אתכם בחברה: אקמה"), FEMININE).title).toBe("הזכירו אתכם בחברה: אקמה");
    expect(notificationText(row("system", "מנוי חודש"), FEMININE).title).toBe("מנוי חודש");
    expect(notificationText(row("lead_new", "ליד חדש הוקצה לכם ועוד"), FEMININE).title).toBe("ליד חדש הוקצה לכם ועוד");
    expect(notificationText(row("system", "סתם כותרת", "ליד"), FEMININE).body).toBe("ליד");
    expect(notificationText(row("lead_new", "x", null), FEMININE).body).toBeNull();
  });

  it("takes names only from the anchored capture and keeps them as plain text", () => {
    const name = '<b onclick="x">דנה</b> · ליד חדש הוקצה לכם';
    expect(notificationText(row("mention", `הזכירו אתכם בליד: ${name}`), FEMININE).title).toBe(`הזכירו אתכם בפנייה: ${name}`);
    // a record really named like the stand-in is said in the business's word only when it is exactly the stand-in
    expect(notificationText(row("follow", "עדכון בליד שבמעקב: ליד יקר"), FEMININE).title).toBe("עדכון בפנייה שבמעקב: ליד יקר");
  });
});

// The guard: every literal with a record word in the latest definition of a function that writes notifications (or of a
// text helper), and every title of the notify_assignment triggers, must be one the renderer knows, or be listed as not a
// notification text. A text changed in SQL then fails here instead of silently staying in today's words.
const MIGRATIONS = join(process.cwd(), "supabase/migrations");
const TEXT_HELPERS = ["app.follow_title", "app.follow_record", "app.mention_subject", "app.leads_waiting_text", "app.quote_accept_deal"];
// the record words (the end customer, "לקוח", stays as it is: owner, 20 October 2026)
const RECORD_WORD = /ליד|איש קשר|אנשי קשר|עסקה|עסקאות/;

/**
 * The latest definition of every function, and the latest title of every notify_assignment trigger, in name order. A
 * body is read from the first dollar quote after the signature to the SAME tag ($$, $fn$, $body$ …), so a function with a
 * named tag is read under its own name and with its own body.
 */
export function parseDefinitions(sqls: string[]): { functions: Map<string, string>; triggerTitles: Map<string, string>; crossed: string[] } {
  const functions = new Map<string, string>();
  const triggerTitles = new Map<string, string>();
  // a match whose signature runs into another function's definition: the body read would not be its own
  const crossed: string[] = [];
  for (const sql of sqls) {
    for (const m of sql.matchAll(/create (?:or replace )?function ([a-z_]+\.[a-z_0-9]+)\s*\([\s\S]*?\$([A-Za-z_]*)\$([\s\S]*?)\$\2\$/gi)) {
      const signature = m[0].slice(0, m[0].length - m[3].length - 2 * (m[2].length + 2));
      if ((signature.match(/create (?:or replace )?function/gi) ?? []).length > 1) crossed.push(m[1].toLowerCase());
      functions.set(m[1].toLowerCase(), m[3]);
    }
    for (const m of sql.matchAll(/create (?:or replace )?trigger ([a-z_]+)[^;]*?execute function app\.notify_assignment\('[a-z]+', '([^']*)'\)/gi)) {
      triggerTitles.set(m[1], m[2]);
    }
  }
  return { functions, triggerTitles, crossed };
}

function latestDefinitions(): { functions: Map<string, string>; triggerTitles: Map<string, string>; crossed: string[] } {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  return parseDefinitions(files.map((file) => readFileSync(join(MIGRATIONS, file), "utf8")));
}

function recordWordLiterals(): Map<string, string[]> {
  const { functions, triggerTitles } = latestDefinitions();
  const found = new Map<string, string[]>();
  const add = (literal: string, where: string) => found.set(literal, [...(found.get(literal) ?? []), where]);
  for (const [name, body] of functions) {
    const code = body.replace(/--[^\n]*/g, "");
    const writes = /insert into public\.notifications|app\.owner_plan_notice\(/.test(code);
    if (!writes && !TEXT_HELPERS.includes(name)) continue;
    for (const m of code.matchAll(/'((?:[^']|'')*)'/g)) {
      const literal = m[1].replace(/''/g, "'");
      if (RECORD_WORD.test(literal)) add(literal, name);
    }
  }
  for (const [trigger, title] of triggerTitles) if (RECORD_WORD.test(title)) add(title, `trigger ${trigger}`);
  return found;
}

describe("the closed list follows the database", () => {
  const found = recordWordLiterals();
  const known = new Set([...NOTIFICATION_PATTERNS.flatMap((p) => p.literals), ...Object.keys(NOT_NOTIFICATION_LITERALS)]);

  it("reads a function with a named dollar tag under its own name and with its own body", () => {
    const sql = [
      "create or replace function app.tagged(p_org uuid) returns void language plpgsql as $fn$",
      "begin insert into public.notifications (title) values ('ליד בתג'); end;",
      "$fn$;",
      "create or replace function app.plain() returns void language plpgsql as $$ begin perform 1; end; $$;",
      "create function app.inner_dollars() returns text language plpgsql as $body$ begin return $q$x$q$ || 'עסקה'; end; $body$;",
    ].join("\n");
    const { functions, crossed } = parseDefinitions([sql]);
    expect(crossed).toEqual([]);
    expect([...functions.keys()]).toEqual(["app.tagged", "app.plain", "app.inner_dollars"]);
    expect(functions.get("app.tagged")).toContain("'ליד בתג'");
    expect(functions.get("app.tagged")).not.toContain("perform 1");
    expect(functions.get("app.plain")).toBe(" begin perform 1; end; ");
    // a body that quotes with another tag inside is read to its own closing tag
    expect(functions.get("app.inner_dollars")).toContain("'עסקה'");
    // a later file's definition wins
    const later = parseDefinitions([sql, "create or replace function app.tagged() returns void as $x$ select 2 $x$;"]);
    expect(later.functions.get("app.tagged")).toBe(" select 2 ");
  });

  it("reads every function of this project from its own signature to its own body", () => {
    const { functions, crossed } = latestDefinitions();
    expect(crossed).toEqual([]);
    for (const [name, body] of functions) {
      expect(/create (?:or replace )?function/i.test(body), name).toBe(false);
    }
    // two that are defined with a named tag (020445, 020605)
    expect(functions.get("app.product_categories_check")).toMatch(/product_categories:depth/);
    expect(functions.get("app.industry_template_products")).toBeTruthy();
  });

  it("finds the texts it guards (the scan itself works)", () => {
    expect(found.has("ליד חדש הוקצה לכם")).toBe(true);
    expect(found.get("עסקה הוקצתה לכם")).toEqual(["trigger deals_notify_assignment"]);
    expect(found.size).toBeGreaterThan(20);
  });

  it("every record-word literal of a notification is covered by a pattern, or listed as not a notification", () => {
    const uncovered = [...found.entries()].filter(([literal]) => !known.has(literal)).map(([literal, where]) => `${where.join(", ")}: ${literal}`);
    expect(uncovered).toEqual([]);
  });

  it("every literal the patterns name is still written by the database (no stale pattern)", () => {
    const stale = [...known].filter((literal) => !found.has(literal));
    expect(stale).toEqual([]);
  });
});
