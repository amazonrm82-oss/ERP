// A record's summary as plain text, for sending to someone outside the business
// (a subcontractor, a partner) in WhatsApp: no link, no access (GAP-04).

export type SummaryLine = [label: string, value: string | null | undefined];

export function recordSummary(title: string, lines: SummaryLine[]): string {
  const body = lines
    .map(([label, value]) => [label, value?.trim()] as const)
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`);
  // WhatsApp shows *text* in bold
  return [`*${title.trim()}*`, ...body].join("\n");
}
