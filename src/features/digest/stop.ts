// USR-11 / WAB-03 (owner (377) ב): the one-click stop link of the daily summary email. Shared by the page, the route and the
// sender (no server-only imports).

/** A stop token: 64 base64url characters (app.digest_stop_token_issue). */
export const DIGEST_STOP_TOKEN = /^[A-Za-z0-9_-]{64}$/;

export const digestStopPagePath = (token: string) => `/f/digest-stop/${token}`;
export const digestStopSubmitPath = (token: string) => `/api/forms/digest-stop/${token}`;

export const DIGEST_STOP_TEXTS = {
  title: "הפסקת הסיכום היומי",
  preview: "הפסקת הסיכום היומי",
  previewDescription: "קישור אישי להפסקת הסיכום היומי במייל.",
  intro: (business: string) => `הסיכום היומי במייל מ${business} פעיל. אפשר להפסיק אותו כאן בלחיצה אחת, בלי להתחבר.`,
  button: "הפסקת הסיכום היומי",
  stopped: "הסיכום היומי הופסק.",
  stoppedLine: "אפשר להפעיל אותו מחדש מתי שתרצו, בהגדרות ההתראות בחשבון שלכם במקסוז.",
  used: "הקישור הזה כבר הפסיק את הסיכום פעם אחת, ומאז הסיכום הופעל שוב. הקישור לא משנה דבר. אפשר להפסיק את הסיכום בקישור שבמייל הבא או בהגדרות ההתראות בחשבון.",
  notFound: "הקישור אינו זמין. ייתכן שפג תוקפו (30 יום) או שכבר השתמשו בו. אפשר להפסיק את הסיכום בהגדרות החשבון במקסוז.",
  notConfigured: "הדף אינו זמין כרגע.",
  error: "משהו השתבש. נסו שוב בעוד רגע.",
  offline: "אין חיבור לשרת כרגע. בדקו את החיבור לאינטרנט ונסו שוב.",
} as const;
