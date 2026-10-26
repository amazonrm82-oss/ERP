// FLD-10 part three (owner's decision (b2), 20 October 2026): notifications are written by the database in today's
// words ("ליד", "איש קשר", "עסקה"). The app redraws them in the business's own words when it shows them (the bell, the
// notifications page, a push), from a CLOSED list of anchored patterns of exactly those stored texts. A text no pattern
// recognises is shown as it was stored, so the worst case is today's words. Names, numbers and a business's name are
// taken only from anchored captures, and the result is plain text (React escapes it; nothing is read as markup).
//
// tests/unit/notification-text.test.ts reads the migrations: every literal with a record word in the latest definition
// of a function that writes notifications (or of the text helpers below) must be covered here, so a text changed in SQL
// fails that test instead of silently staying in today's words.

import { byGender, DEFAULT_TERMS, withPrefixThe, type OrgTerms, type TermForms } from "@/features/terminology/terms";

export type NotificationTextRow = { type: string; title: string; body: string | null };

type Field = "title" | "body";

type Pattern = {
  id: string;
  field: Field;
  // notification kinds the text is written with; any other kind is never touched
  types: readonly string[];
  re: RegExp;
  // an extra condition on the row (the body of one title, for instance)
  when?: (row: NotificationTextRow) => boolean;
  render: (match: RegExpExecArray, terms: OrgTerms) => string;
  // the SQL literals this pattern stands for (read by the migration test)
  literals: readonly string[];
};

type RecordWord = "lead" | "contact" | "deal";

// the record words as the database writes them
const WORD: Record<string, RecordWord> = { "ליד": "lead", "איש קשר": "contact", "עסקה": "deal" };
// the names the database gives a record without one (app.mention_subject, app.follow_record)
const FALLBACK_NAME: Partial<Record<RecordWord, string>> = { lead: "ליד", contact: "איש קשר" };

const g = byGender;

/** A record's name as captured, unless it is the database's stand-in for "no name", which is said in the business's word. */
function recordName(kind: RecordWord, name: string, terms: OrgTerms): string {
  return name === FALLBACK_NAME[kind] ? terms[kind].singular : name;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// QUO-13: what the database adds to an accepted quote's notice about its deal (app.quote_accept_deal, quote_public_decide)
const QUOTE_DEAL_NOTES: ReadonlyArray<{ literal: string; render: (deal: TermForms) => string }> = [
  {
    literal: "להעביר את העסקה לזכייה ולעדכן את השורות?",
    render: (d) => `להעביר את ${d.theSingular} לזכייה ולעדכן את השורות?`,
  },
  {
    literal: "בתהליך המכירה של העסקה אין שלב זכייה, ולכן העסקה לא הועברה והשורות לא עודכנו.",
    render: (d) => `בתהליך המכירה של ${d.theSingular} אין שלב זכייה, ולכן ${d.theSingular} לא ${g(d, "הועבר", "הועברה")} והשורות לא עודכנו.`,
  },
  {
    literal: "העסקה לא הועברה לזכייה והשורות לא עודכנו. אפשר לעשות זאת מדף ההצעה.",
    render: (d) => `${d.theSingular} לא ${g(d, "הועבר", "הועברה")} לזכייה והשורות לא עודכנו. אפשר לעשות זאת מדף ההצעה.`,
  },
  {
    literal: "העסקה עברה לזכייה והשורות עודכנו לפי ההצעה.",
    render: (d) => `${d.theSingular} ${g(d, "עבר", "עברה")} לזכייה והשורות עודכנו לפי ההצעה.`,
  },
  {
    literal: "העסקה עברה לזכייה, אבל השורות לא עודכנו לפי ההצעה. אפשר לעדכן אותן בעסקה.",
    render: (d) => `${d.theSingular} ${g(d, "עבר", "עברה")} לזכייה, אבל השורות לא עודכנו לפי ההצעה. אפשר לעדכן אותן ${withPrefixThe("ב", d)}.`,
  },
  {
    literal: "לא הצלחנו לטפל בעסקה של ההצעה. אפשר להעביר אותה לזכייה מדף ההצעה.",
    render: (d) => `לא הצלחנו לטפל ${withPrefixThe("ב", d)} של ההצעה. אפשר להעביר ${g(d, "אותו", "אותה")} לזכייה מדף ההצעה.`,
  },
];

export const NOTIFICATION_PATTERNS: readonly Pattern[] = [
  {
    // app.notify_assignment (an intake lead, a lead given back) and the leads trigger; before 0048 "לך"
    id: "lead_assigned",
    field: "title",
    types: ["lead_new", "assigned"],
    re: /^ליד חדש הוקצה (לכם|לך)$/,
    render: (m, t) => `${t.lead.newOne} ${g(t.lead, "הוקצה", "הוקצתה")} ${m[1]}`,
    literals: ["ליד חדש הוקצה לכם"],
  },
  {
    // the deals trigger of app.notify_assignment
    id: "deal_assigned",
    field: "title",
    types: ["assigned"],
    re: /^עסקה הוקצתה (לכם|לך)$/,
    render: (m, t) => `${t.deal.singular} ${g(t.deal, "הוקצה", "הוקצתה")} ${m[1]}`,
    literals: ["עסקה הוקצתה לכם"],
  },
  {
    // app.assign_lead_owner_auto, public.intake_submit
    id: "lead_unowned",
    field: "title",
    types: ["lead_new"],
    re: /^ליד חדש מחכה למי שייקח אותו$/,
    render: (_m, t) => `${t.lead.newOne} מחכה למי שייקח ${g(t.lead, "אותו", "אותה")}`,
    literals: ["ליד חדש מחכה למי שייקח אותו"],
  },
  {
    // app.send_task_reminders: an intake call-back task still without an owner
    id: "lead_reminder_body",
    field: "body",
    types: ["lead_new"],
    re: /^הליד עוד לא אצל אף אחד$/,
    render: (_m, t) => `${t.lead.theSingular} עוד לא אצל אף אחד`,
    literals: ["הליד עוד לא אצל אף אחד"],
  },
  {
    // app.check_lead_responses (SPD-03): to the owner the lead was taken from
    id: "response_passed",
    field: "title",
    types: ["response_overdue"],
    re: /^ליד הועבר לנציג אחר$/,
    render: (_m, t) => `${t.lead.singular} ${g(t.lead, "הועבר", "הועברה")} לנציג אחר`,
    literals: ["ליד הועבר לנציג אחר"],
  },
  {
    // app.check_lead_responses: to the managers, when the lead was passed on
    id: "response_passed_managers",
    field: "title",
    types: ["response_overdue"],
    re: /^ליד לא נענה בתוך (\d+) דקות והועבר$/,
    render: (m, t) => `${t.lead.singular} לא ${g(t.lead, "נענה", "נענתה")} בתוך ${m[1]} דקות ${g(t.lead, "והועבר", "והועברה")}`,
    literals: ["ליד לא נענה בתוך "],
  },
  {
    // app.check_lead_responses: to the managers, when nobody is left to pass it to
    id: "response_overdue",
    field: "title",
    types: ["response_overdue"],
    re: /^ליד מחכה למענה יותר מ-(\d+) דקות$/,
    render: (m, t) => `${t.lead.singular} מחכה למענה יותר מ-${m[1]} דקות`,
    literals: ["ליד מחכה למענה יותר מ-"],
  },
  {
    // app.check_lead_responses: the body starts with the lead's name, "ליד ללא שם" for a lead without one
    id: "response_unnamed_body",
    field: "body",
    types: ["response_overdue"],
    re: /^ליד ללא שם((?: · [\s\S]*)?)$/,
    render: (m, t) => `${t.lead.singular} ללא שם${m[1]}`,
    literals: ["ליד ללא שם"],
  },
  {
    // app.notify_mentions (REC-02); the name comes from app.mention_subject
    id: "mention",
    field: "title",
    types: ["mention"],
    re: /^הזכירו אתכם ב(ליד|איש קשר|עסקה): ([\s\S]*)$/,
    render: (m, t) => {
      const kind = WORD[m[1]];
      return `הזכירו אתכם ב${t[kind].singular}: ${recordName(kind, m[2], t)}`;
    },
    literals: ["הזכירו אתכם בליד: ", "הזכירו אתכם באיש קשר: ", "הזכירו אתכם בעסקה: ", "ליד", "איש קשר"],
  },
  {
    // app.follow_title (REC-03); the name comes from app.follow_record
    id: "follow",
    field: "title",
    types: ["follow"],
    re: /^עדכון ב(ליד|איש קשר|עסקה) שבמעקב: ([\s\S]*)$/,
    render: (m, t) => {
      const kind = WORD[m[1]];
      return `עדכון ב${t[kind].singular} שבמעקב: ${recordName(kind, m[2], t)}`;
    },
    literals: ["עדכון בליד שבמעקב: ", "עדכון באיש קשר שבמעקב: ", "עדכון בעסקה שבמעקב: ", "ליד", "איש קשר"],
  },
  {
    // app.suspended_lead_arrived (BIL-09): the first lead of a closed business, to its owner
    id: "suspended_first_lead",
    field: "title",
    types: ["system"],
    re: /^נכנס ליד חדש ל([\s\S]+)\. כדי לראות אותו, חדשו את המנוי\.$/,
    render: (m, t) => `${g(t.lead, "נכנס", "נכנסה")} ${t.lead.newOne} ל${m[1]}. כדי לראות ${g(t.lead, "אותו", "אותה")}, חדשו את המנוי.`,
    literals: ["נכנס ליד חדש ל"],
  },
  {
    // app.leads_waiting_text, one lead
    id: "suspended_one_waiting",
    field: "title",
    types: ["system"],
    re: /^ליד אחד מחכה לכם ב([\s\S]+)\. כדי לראות אותו, חדשו את המנוי\.$/,
    render: (m, t) => `${t.lead.singular} ${g(t.lead, "אחד", "אחת")} מחכה לכם ב${m[1]}. כדי לראות ${g(t.lead, "אותו", "אותה")}, חדשו את המנוי.`,
    literals: ["ליד אחד מחכה לכם ב"],
  },
  {
    // app.leads_waiting_text, several
    id: "suspended_many_waiting",
    field: "title",
    types: ["system"],
    re: /^(\d+) לידים מחכים לכם ב([\s\S]+)\. כדי לראות אותם, חדשו את המנוי\.$/,
    render: (m, t) => `${m[1]} ${t.lead.plural} ${g(t.lead, "מחכים", "מחכות")} לכם ב${m[2]}. כדי לראות ${g(t.lead, "אותם", "אותן")}, חדשו את המנוי.`,
    literals: [" לידים מחכים לכם ב"],
  },
  {
    // app.run_lead_retention (PRV-01): a new round, one lead
    id: "retention_round_one",
    field: "title",
    types: ["system"],
    re: /^מדיניות השמירה: ליד אחד יעבור לסל המחזור בעוד 14 יום$/,
    render: (_m, t) => `מדיניות השמירה: ${t.lead.singular} ${g(t.lead, "אחד יעבור", "אחת תעבור")} לסל המחזור בעוד 14 יום`,
    literals: ["מדיניות השמירה: ליד אחד יעבור לסל המחזור בעוד 14 יום"],
  },
  {
    // app.run_lead_retention (PRV-01): a new round, several
    id: "retention_round_many",
    field: "title",
    types: ["system"],
    re: /^מדיניות השמירה: (\d+) לידים יעברו לסל המחזור בעוד 14 יום$/,
    render: (m, t) => `מדיניות השמירה: ${m[1]} ${t.lead.plural} יעברו לסל המחזור בעוד 14 יום`,
    literals: [" לידים יעברו לסל המחזור בעוד 14 יום"],
  },
  {
    // app.run_lead_retention (PRV-01): the round moved its leads to the bin, one
    id: "retention_binned_one",
    field: "title",
    types: ["system"],
    re: /^מדיניות השמירה העבירה ליד אחד לסל המחזור$/,
    render: (_m, t) => `מדיניות השמירה העבירה ${t.lead.singular} ${g(t.lead, "אחד", "אחת")} לסל המחזור`,
    literals: ["מדיניות השמירה העבירה ליד אחד לסל המחזור"],
  },
  {
    // app.run_lead_retention (PRV-01): the round moved its leads to the bin, several
    id: "retention_binned_many",
    field: "title",
    types: ["system"],
    re: /^מדיניות השמירה העבירה (\d+) לידים לסל המחזור$/,
    render: (m, t) => `מדיניות השמירה העבירה ${m[1]} ${t.lead.plural} לסל המחזור`,
    literals: [" לידים לסל המחזור"],
  },
  {
    // app.member_leaves_deputy_notice (HEB-08)
    id: "deputy_body",
    field: "body",
    types: ["system"],
    re: /^([\s\S]*)\. ממלא המקום רואה בזמן הזה את הרשומות של המשימות הפתוחות והלידים שלא נענו\.$/,
    render: (m, t) => `${m[1]}. ממלא המקום רואה בזמן הזה את הרשומות של המשימות הפתוחות ו${t.lead.thePlural} שלא נענו.`,
    literals: [". ממלא המקום רואה בזמן הזה את הרשומות של המשימות הפתוחות והלידים שלא נענו."],
  },
  {
    // app.complete_pending_erasures (CNS): the kind of record whose erasure finished
    id: "erasure_done_body",
    field: "body",
    types: ["system"],
    when: (row) => row.title === "המחיקה שביקשתם הושלמה",
    re: /^(ליד|איש קשר)$/,
    render: (m, t) => t[WORD[m[1]]].singular,
    literals: ["ליד", "איש קשר"],
  },
  {
    // public.transfer_records: the counts of a handover. Since 020875 quotes and orders move too; a notice stored before
    // it ends "משימות ו-N פגישות." and still renders (the record words are all in the head)
    id: "transfer_body",
    field: "body",
    types: ["assigned"],
    re: /^(\d+) לידים, (\d+) אנשי קשר, (\d+) חברות, (\d+) עסקאות, (\d+) משימות( ו-\d+ פגישות\.|, \d+ פגישות, \d+ הצעות מחיר ו-\d+ הזמנות\.)$/,
    render: (m, t) => `${m[1]} ${t.lead.plural}, ${m[2]} ${t.contact.plural}, ${m[3]} חברות, ${m[4]} ${t.deal.plural}, ${m[5]} משימות${m[6]}`,
    literals: ["%s לידים, %s אנשי קשר, %s חברות, %s עסקאות, %s משימות, %s פגישות, %s הצעות מחיר ו-%s הזמנות."],
  },
  ...QUOTE_DEAL_NOTES.map(
    (note, index): Pattern => ({
      // public.quote_public_decide: "הצעה <number> · <note>", or the note alone
      id: `quote_deal_note_${index + 1}`,
      field: "body",
      types: ["quote"],
      re: new RegExp(`^((?:הצעה [^·]+ · )?)${escapeRe(note.literal)}$`),
      render: (m, t) => `${m[1]}${note.render(t.deal)}`,
      literals: [note.literal],
    }),
  ),
];

/**
 * Literals with a record word that are not notification text, each with why it stays as it is (the migration test
 * accepts them): the automation's default deal name is a stored record name (the rule builder now saves the business's
 * own word), and "הליד הועבר" is the timeline entry of SPD-03, drawn from its metadata by the timeline.
 */
export const NOT_NOTIFICATION_LITERALS: Readonly<Record<string, string>> = {
  "עסקה: {{name}}": "the default name of a deal an automation makes (stored data; the builder saves the business's word)",
  "עסקה": "the name of such a deal when the template is empty (stored data)",
  "הליד הועבר": "the SPD-03 timeline entry, drawn from its metadata (activities/queries.ts)",
};

function redraw(row: NotificationTextRow, field: Field, terms: OrgTerms): string | null {
  const text = row[field];
  if (text === null) return null;
  for (const pattern of NOTIFICATION_PATTERNS) {
    if (pattern.field !== field || !pattern.types.includes(row.type)) continue;
    if (pattern.when && !pattern.when(row)) continue;
    const match = pattern.re.exec(text);
    if (match) return pattern.render(match, terms);
  }
  return text;
}

/** A notification's title and body in the business's words (unrecognised text: as stored). */
export function notificationText(row: NotificationTextRow, terms: OrgTerms = DEFAULT_TERMS): { title: string; body: string | null } {
  return { title: redraw(row, "title", terms) ?? row.title, body: redraw(row, "body", terms) };
}
