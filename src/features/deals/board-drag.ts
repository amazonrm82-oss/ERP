// DEAL-10: moving a deal on the board by touch and by keyboard. Pure rules, unit tested;
// the board (components/deals-board.tsx) feeds them keys, positions and stages.
// The long press itself is the calendar's (CAL-02, src/features/calendar/long-press.ts).

type StageLike = { id: string; name: string };

/**
 * The stage a key moves the keyboard target to. The first stage sits on the start side,
 * so in a right-to-left page ArrowLeft goes forward in the pipeline and ArrowRight back
 * (the other way round left to right). ArrowDown / ArrowUp also go forward / back, and
 * Home / End jump to the first / last stage. Another key, or the edge: null.
 */
export function stepStage(stages: StageLike[], currentId: string, key: string, rtl: boolean): string | null {
  const index = stages.findIndex((stage) => stage.id === currentId);
  if (index < 0 || stages.length === 0) return null;
  let next: number;
  switch (key) {
    case "ArrowLeft":
      next = rtl ? index + 1 : index - 1;
      break;
    case "ArrowRight":
      next = rtl ? index - 1 : index + 1;
      break;
    case "ArrowDown":
      next = index + 1;
      break;
    case "ArrowUp":
      next = index - 1;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = stages.length - 1;
      break;
    default:
      return null;
  }
  if (next < 0 || next >= stages.length || next === index) return null;
  return stages[next].id;
}

// how close (CSS pixels) to an edge the finger must be for the board to scroll, and the fastest step per frame
export const EDGE_ZONE = 56;
export const EDGE_MAX_STEP = 18;

/**
 * How far to scroll per frame while a finger drags near an edge: negative toward the
 * start of the axis (left / top), positive toward its end, 0 away from the edges. The
 * closer to the edge, the faster; a point past the edge scrolls at full speed.
 */
export function edgeStep(point: number, start: number, end: number, zone = EDGE_ZONE, max = EDGE_MAX_STEP): number {
  if (!Number.isFinite(point) || end - start <= zone * 2) {
    // too small to have two edge zones: scroll only past the ends
    if (point < start) return -max;
    if (point > end) return max;
    return 0;
  }
  if (point < start + zone) {
    return -Math.ceil(max * Math.min(1, (start + zone - point) / zone));
  }
  if (point > end - zone) {
    return Math.ceil(max * Math.min(1, (point - (end - zone)) / zone));
  }
  return 0;
}

/** What a screen reader hears while a deal is moved with the keyboard (Hebrew, short). */
export const moveTexts = {
  instructions: "כדי להזיז: רווח או Enter להרמה, חיצים לבחירת שלב, Enter להנחה, Escape לביטול.",
  lifted: (deal: string, stage: string) => `העסקה ${deal} הורמה. היא בשלב ${stage}. בחרו שלב בחיצים, Enter להנחה, Escape לביטול.`,
  over: (stage: string, position: number, total: number, current: boolean) =>
    `${stage}, שלב ${position} מתוך ${total}${current ? ", השלב הנוכחי" : ""}.`,
  cancelled: (deal: string) => `ההזזה בוטלה. העסקה ${deal} נשארה במקומה.`,
  unchanged: (deal: string, stage: string) => `העסקה ${deal} נשארה בשלב ${stage}.`,
  moved: (deal: string, stage: string) => `העסקה ${deal} הועברה לשלב ${stage}.`,
  // shown on the lifted card, for sighted keyboard users
  visibleHint: "חיצים או לחיצה על עמודה לבחירת שלב, Enter להנחה, Escape לביטול.",
  touchLifted: (deal: string) => `העסקה ${deal} הורמה. גררו אותה לשלב אחר והרימו את האצבע.`,
};
