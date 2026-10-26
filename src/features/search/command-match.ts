// REC-09: matching the command palette's actions and places to the typed text. No server code and no icons here: the
// palette in the browser imports only this file; the list itself is built on the server (commands.ts).

import { searchNorm } from "@/lib/search-norm";

export type CommandGroup = "create" | "navigate" | "settings";

export type Command = {
  key: string;
  group: CommandGroup;
  label: string;
  /** a short line under the label (a settings section's description) */
  hint: string | null;
  href: string;
  /** more words that find it: synonyms, today's word when the business uses another one */
  keywords: string[];
};

export const COMMAND_GROUP_LABELS: Record<CommandGroup, string> = {
  create: "פעולות",
  navigate: "מעבר למסך",
  settings: "הגדרות",
};

/** How many commands the palette shows at most, above the records. */
export const COMMAND_LIMIT = 6;

const words = (text: string) => searchNorm(text).split(/[\s,.:;()"'/-]+/).filter(Boolean);

// Hebrew attaches ה, ו, ב, ל, מ, ש, כ to the word ("להגדרות", "והתראות"); one such letter in front is let go
const PREFIX_LETTERS = "הובלמשכ";

function tokenHits(token: string, list: string[]): boolean {
  if (list.some((w) => w.startsWith(token))) return true;
  if (token.length > 2 && PREFIX_LETTERS.includes(token[0])) {
    const rest = token.slice(1);
    return list.some((w) => w.startsWith(rest));
  }
  return false;
}

/**
 * The rank of a command for the typed text, or null when it does not match. Every typed word must start a word of
 * the label, a keyword or the hint (one attached Hebrew letter allowed). Lower is better: the label itself, then a
 * label that starts with the text, then every word in the label, then matches through keywords, then the hint.
 */
export function commandRank(command: Command, query: string): number | null {
  const q = searchNorm(query).trim().replace(/\s+/g, " ");
  if (!q) return null;
  const tokens = q.split(" ");
  const label = searchNorm(command.label);
  const labelWords = words(command.label);
  const keywordWords = command.keywords.flatMap(words);
  const hintWords = command.hint ? words(command.hint) : [];
  if (label === q) return 0;
  if (label.startsWith(q)) return 1;
  if (tokens.every((t) => tokenHits(t, labelWords))) return 2;
  if (tokens.every((t) => tokenHits(t, [...labelWords, ...keywordWords]))) return 3;
  if (tokens.every((t) => tokenHits(t, [...labelWords, ...keywordWords, ...hintWords]))) return 4;
  return null;
}

/** The commands that match, best first; a tie keeps the list's order (actions, screens, settings). */
export function matchCommands(commands: readonly Command[], query: string, limit = COMMAND_LIMIT): Command[] {
  return commands
    .map((command, index) => ({ command, index, rank: commandRank(command, query) }))
    .filter((c): c is { command: Command; index: number; rank: number } => c.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((c) => c.command);
}
