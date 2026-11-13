// What makes a screenshot repeatable (DSN-18). Injected into the page only by the
// visual run, never by the app.

// No motion, no blinking caret, no smooth scrolling, no scrollbars that come and go.
export const STABLE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important;
  transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important;
}
html { scrollbar-width: none !important; }
::-webkit-scrollbar { display: none !important; }
`;

// The placeholder every masked text becomes: a fixed string, so the layout around it
// does not move when the date, the time or an id changes from run to run.
export const MASK = "▒▒▒▒";

/**
 * Patterns of text that changes between runs on the same sample data: dates and times
 * (the sample is made "now"), relative ages, ids, the run's own e-mail addresses.
 * Kept as strings so the same list runs in the browser and in the unit test.
 */
export const MASK_PATTERNS = [
  // ids and tokens
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
  // e-mail addresses (the sample's owner is screens-<time>@example.test)
  "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
  // "1 בנובמבר 2026", "יום ראשון, 1 בנובמבר"
  "(יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת),? ?)?\\d{1,2} ב(ינואר|פברואר|מרץ|מרס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)( \\d{4})?",
  // the short month form Intl gives with month "short" ("8 בנוב׳ 2026", "יום ראשון, 8 בנוב' 2026"); geresh or apostrophe
  "(יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת),? ?)?\\d{1,2} ב(ינו|פבר|אפר|אוג|ספט|אוק|נוב|דצמ)['׳]( \\d{4})?",
  // a month and year ("נובמבר 2026"), a week day on its own
  "(ינואר|פברואר|מרץ|מרס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר) \\d{4}",
  "יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)",
  // numeric dates: 1.11.2026, 01/11/26, 2026-11-01, 1.11
  "\\d{4}-\\d{2}-\\d{2}",
  "\\d{1,2}[./]\\d{1,2}([./]\\d{2,4})?",
  // times: 09:30, 9:30
  "\\d{1,2}:\\d{2}",
  // ages and countdowns: "לפני 3 שעות", "בעוד יומיים", "5 דק'", "3 ימים"
  "(לפני|בעוד) [^,.;·|()]{1,24}",
  "\\d+ ?(שניות|שנייה|דקות|דקה|דק'|שעות|שעה|ימים|יום|שבועות|שבוע|חודשים|חודש|שנים|שנה)",
  // the snooze button's first choice reads "למחר", or "ליום העבודה הבא" when tomorrow is a rest day in the business zone
  // (a CI run after midnight Israel time on a Thursday): the same button either way
  "ליום העבודה הבא|למחר",
];

/** The same replacement the browser does, for the unit test. */
export function maskText(text, patterns = MASK_PATTERNS) {
  return new RegExp(patterns.map((p) => `(?:${p})`).join("|"), "gu")[Symbol.replace](text, MASK);
}

/**
 * Runs in the page (page.evaluate): replaces every changing text with the placeholder,
 * fixes date and time inputs, freezes media, and adds the stable CSS.
 * @param {{ css: string, patterns: string[], mask: string, hide: string[] }} args
 */
export function stabilizePage({ css, patterns, mask, hide }) {
  const style = document.createElement("style");
  style.setAttribute("data-visual-test", "");
  style.textContent = css + hide.map((s) => `${s} { visibility: hidden !important; }`).join("\n");
  document.head.appendChild(style);
  const re = new RegExp(patterns.map((p) => `(?:${p})`).join("|"), "gu");
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent || parent.closest("script, style, noscript")) continue;
    const next = node.data.replace(re, mask);
    if (next !== node.data) node.data = next;
  }
  for (const input of document.querySelectorAll("input")) {
    const type = input.type;
    if (type === "date") input.value = "2026-01-01";
    else if (type === "datetime-local") input.value = "2026-01-01T09:00";
    else if (type === "time") input.value = "09:00";
    else if (type === "month") input.value = "2026-01";
    else if (input.value && re.test(input.value)) input.value = input.value.replace(re, mask);
    re.lastIndex = 0;
  }
  // a rest-day warning was worked out from the real date the page opened with: tell it the fixed date (2026-01-01, a
  // Thursday), so the shot does not change when the run falls on a rest day in Israel. Only the date fields of a form that
  // holds such a warning get the events, so no other screen reacts.
  for (const warning of document.querySelectorAll("[data-rest-day-warning]")) {
    for (const input of warning.closest("form")?.querySelectorAll('input[type="date"]') ?? []) {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  for (const media of document.querySelectorAll("video, audio")) {
    media.pause();
    media.currentTime = 0;
  }
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}
