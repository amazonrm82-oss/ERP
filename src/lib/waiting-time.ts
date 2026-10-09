// How long a lead has waited for an answer, in short Hebrew (SPD-02).

export function waitingText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "פחות מדקה";
  if (minutes === 1) return "דקה";
  if (minutes < 60) return `${minutes} דקות`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) {
    const h = hours === 1 ? "שעה" : hours === 2 ? "שעתיים" : `${hours} שעות`;
    return rest === 0 ? h : rest === 1 ? `${h} ודקה` : `${h} ו-${rest} דקות`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? "יום" : days === 2 ? "יומיים" : `${days} ימים`;
}
