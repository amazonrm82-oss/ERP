// DSN-02: three design directions, shown on the same sample screens in the
// internal preview page (/admin/design). Each is a set of design tokens that
// overrides the app's CSS variables inside its frame, so the screens are built
// once from the app's own pieces. The chosen one becomes the design system
// (DSN-03 to DSN-06); the other two are deleted.

export type DirectionKey = "calm" | "warm" | "bold";

export type Direction = {
  key: DirectionKey;
  name: string;
  /** Two lines for the owner: what it feels like, and how it differs. */
  summary: string;
  font: string;
  fontLabel: string;
  /** Corner rounding (px) of small controls, cards and sheets. */
  radius: { sm: number; md: number; lg: number; xl: number };
  /** Tailwind's spacing unit (rem): the density of the whole screen. */
  spacing: number;
  densityLabel: string;
  iconStroke: number;
  iconCaps: "round" | "square";
  iconLabel: string;
  headingWeight: number;
  colors: {
    canvas: string;
    surface: string;
    line: string;
    lineStrong: string;
    lineControl: string;
    ink: string;
    inkSoft: string;
    accent: string;
    accentStrong: string;
    accentSoft: string;
    danger: string;
    dangerStrong: string;
    dangerSoft: string;
    warning: string;
    warningSoft: string;
    success: string;
    successSoft: string;
    /** The app frame: top bar, side menu, bottom bar. */
    chrome: string;
    chromeInk: string;
    chromeInkSoft: string;
    /** The current item in the bottom bar, on the frame colour. */
    chromeActive: string;
  };
};

export const DIRECTIONS: Direction[] = [
  {
    key: "calm",
    name: "שקט ומקצועי",
    summary: "קרוב למה שיש היום, מסודר יותר. אפור קר, כחול הלוגו, פינות מעוגלות מעט, הרבה מידע במסך.",
    font: '"Heebo Variable", "Heebo", Arial, sans-serif',
    fontLabel: "Heebo (הגופן של היום)",
    radius: { sm: 4, md: 6, lg: 8, xl: 12 },
    spacing: 0.25,
    densityLabel: "צפוף",
    iconStroke: 1.5,
    iconCaps: "round",
    iconLabel: "קו דק",
    headingWeight: 600,
    colors: {
      canvas: "#f4f6f8",
      surface: "#ffffff",
      line: "#e2e6eb",
      lineStrong: "#c5ccd5",
      lineControl: "#838e9b",
      ink: "#141c26",
      inkSoft: "#525e6c",
      accent: "#1e56d6",
      accentStrong: "#173f9e",
      accentSoft: "#eaf0fd",
      danger: "#b42318",
      dangerStrong: "#8f1b12",
      dangerSoft: "#fdecea",
      warning: "#8a5300",
      warningSoft: "#fdf3dc",
      success: "#1b6e3f",
      successSoft: "#e5f4ea",
      chrome: "#ffffff",
      chromeInk: "#141c26",
      chromeInkSoft: "#525e6c",
      chromeActive: "#1e56d6",
    },
  },
  {
    key: "warm",
    name: "חם וידידותי",
    summary: "רך ומזמין לאנשים שלא אוהבים מחשבים. רקע שמנת, פינות עגולות, כפתורים גדולים ומרווחים, גופן Rubik.",
    font: '"Rubik Variable", "Rubik", Arial, sans-serif',
    fontLabel: "Rubik",
    radius: { sm: 10, md: 14, lg: 20, xl: 26 },
    spacing: 0.3,
    densityLabel: "מרווח",
    iconStroke: 2,
    iconCaps: "round",
    iconLabel: "קו עבה ועגול",
    headingWeight: 600,
    colors: {
      canvas: "#f6f0e6",
      surface: "#ffffff",
      line: "#e9e0d2",
      lineStrong: "#d6cdbf",
      lineControl: "#8c8273",
      ink: "#211b14",
      inkSoft: "#5f564a",
      accent: "#1d4fc7",
      accentStrong: "#163c96",
      accentSoft: "#e9effc",
      danger: "#b3261e",
      dangerStrong: "#8c1d17",
      dangerSoft: "#fcebe8",
      warning: "#875200",
      warningSoft: "#fcf1d9",
      success: "#1d6b3e",
      successSoft: "#e4f2e8",
      chrome: "#ffffff",
      chromeInk: "#211b14",
      chromeInkSoft: "#5f564a",
      chromeActive: "#1d4fc7",
    },
  },
  {
    key: "bold",
    name: "חד ונועז",
    summary: "מראה של כלי עבודה רציני. מסגרת בכחול הכהה של הלוגו, פינות כמעט ישרות, כותרות בולטות, גופן Assistant.",
    font: '"Assistant Variable", "Assistant", Arial, sans-serif',
    fontLabel: "Assistant",
    radius: { sm: 2, md: 3, lg: 4, xl: 6 },
    spacing: 0.24,
    densityLabel: "צפוף מאוד",
    iconStroke: 2.25,
    iconCaps: "square",
    iconLabel: "קו עבה וחד",
    headingWeight: 700,
    colors: {
      canvas: "#eef1f5",
      surface: "#ffffff",
      line: "#d8dee6",
      lineStrong: "#b9c2ce",
      lineControl: "#7d8899",
      ink: "#0e1c36",
      inkSoft: "#46546a",
      accent: "#1e56d6",
      accentStrong: "#0e1c36",
      accentSoft: "#e0e9fc",
      danger: "#b01f16",
      dangerStrong: "#8a1810",
      dangerSoft: "#fce9e7",
      warning: "#855000",
      warningSoft: "#fbefd5",
      success: "#176238",
      successSoft: "#e1f1e7",
      chrome: "#0e1c36",
      chromeInk: "#ffffff",
      chromeInkSoft: "#c3cde0",
      chromeActive: "#9dbcff",
    },
  },
];

export function findDirection(key: string | undefined): Direction {
  return DIRECTIONS.find((d) => d.key === key) ?? DIRECTIONS[0];
}

/** The CSS variables of a direction, for the frame's style attribute. */
export function directionStyle(d: Direction): Record<string, string> {
  const c = d.colors;
  return {
    "--font-sans": d.font,
    fontFamily: d.font,
    "--spacing": `${d.spacing}rem`,
    "--radius-sm": `${d.radius.sm}px`,
    "--radius-md": `${d.radius.md}px`,
    "--radius-lg": `${d.radius.lg}px`,
    "--radius-xl": `${d.radius.xl}px`,
    "--radius-2xl": `${d.radius.xl + 4}px`,
    "--icon-stroke": String(d.iconStroke),
    "--icon-caps": d.iconCaps,
    "--heading-weight": String(d.headingWeight),
    "--color-canvas": c.canvas,
    "--color-surface": c.surface,
    "--color-line": c.line,
    "--color-line-strong": c.lineStrong,
    "--color-line-control": c.lineControl,
    "--color-ink": c.ink,
    "--color-ink-soft": c.inkSoft,
    "--color-accent": c.accent,
    "--color-accent-strong": c.accentStrong,
    "--color-accent-soft": c.accentSoft,
    "--color-danger": c.danger,
    "--color-danger-strong": c.dangerStrong,
    "--color-danger-soft": c.dangerSoft,
    "--color-warning": c.warning,
    "--color-warning-soft": c.warningSoft,
    "--color-success": c.success,
    "--color-success-soft": c.successSoft,
    "--color-chrome": c.chrome,
    "--color-chrome-ink": c.chromeInk,
    "--color-chrome-ink-soft": c.chromeInkSoft,
    "--color-chrome-active": c.chromeActive,
    background: c.canvas,
    color: c.ink,
  };
}

// --- contrast (WCAG 2.0) ------------------------------------------------------

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every text-on-background pair the screens use, with its contrast. */
export function textPairs(d: Direction): Array<{ pair: string; ratio: number }> {
  const c = d.colors;
  const pairs: Array<[string, string, string]> = [
    ["ink on surface", c.ink, c.surface],
    ["ink on canvas", c.ink, c.canvas],
    ["ink-soft on surface", c.inkSoft, c.surface],
    ["ink-soft on canvas", c.inkSoft, c.canvas],
    ["white on accent", "#ffffff", c.accent],
    ["accent on surface", c.accent, c.surface],
    ["accent on canvas", c.accent, c.canvas],
    ["accent-strong on accent-soft", c.accentStrong, c.accentSoft],
    ["danger on surface", c.danger, c.surface],
    ["danger on danger-soft", c.danger, c.dangerSoft],
    ["warning on warning-soft", c.warning, c.warningSoft],
    ["success on success-soft", c.success, c.successSoft],
    ["white on danger", "#ffffff", c.danger],
    ["chrome-ink on chrome", c.chromeInk, c.chrome],
    ["chrome-ink-soft on chrome", c.chromeInkSoft, c.chrome],
    ["chrome-active on chrome", c.chromeActive, c.chrome],
  ];
  return pairs.map(([pair, fg, bg]) => ({ pair, ratio: Math.round(contrast(fg, bg) * 100) / 100 }));
}
