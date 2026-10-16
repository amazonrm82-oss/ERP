// FXA-08: focus must not fall back to the start of the page when the control that had it disappears (a row deleted
// after "מחיקה", a window closed after its row went away, a question replaced by its answer). One rule for the whole
// app: when focus is lost, it lands on the next row of the same list (else the previous one), else on the page's main
// heading. Where it should land is worked out while the control is still on the page, and resolved when it is needed.
// The rule only uses a few element properties, so it is unit-tested with plain objects (no browser).

/** The parts of an element this rule reads; an HTMLElement has them all. */
export type FocusNode = {
  tagName: string;
  parentElement: FocusNode | null;
  readonly children: ArrayLike<FocusNode>;
  nextElementSibling: FocusNode | null;
  previousElementSibling: FocusNode | null;
  isConnected: boolean;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  focus(): void;
};

/** Finds where focus should go when the control it was given disappears. Null when nothing fits. */
export type FocusLanding = () => FocusNode | null;

const FIELD_TAGS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
const ROW_TAGS = new Set(["LI", "TR"]);

/** Something a person can tab to. */
export function isFocusable(el: FocusNode): boolean {
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
  const tabindex = el.getAttribute("tabindex");
  if (tabindex !== null) return Number(tabindex) >= 0;
  if (el.tagName === "A") return el.hasAttribute("href");
  if (FIELD_TAGS.has(el.tagName)) return !el.hasAttribute("disabled") && !(el.tagName === "INPUT" && el.getAttribute("type") === "hidden");
  return false;
}

/** The first focusable element inside (or at) `el`, in document order. */
export function firstFocusable(el: FocusNode): FocusNode | null {
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return null;
  if (isFocusable(el)) return el;
  for (let i = 0; i < el.children.length; i += 1) {
    const found = firstFocusable(el.children[i]);
    if (found) return found;
  }
  return null;
}

/** The row an element sits in: a list item, a table row, or anything marked data-focus-item. Not past a dialog. */
export function rowOf(el: FocusNode): FocusNode | null {
  for (let node: FocusNode | null = el; node; node = node.parentElement) {
    if (node.tagName === "DIALOG") return null;
    if (ROW_TAGS.has(node.tagName) || node.hasAttribute("data-focus-item")) return node;
  }
  return null;
}

/** The page's main heading (made focusable without joining the tab order), else the main area. */
function pageHeading(root: FocusNode | null): FocusNode | null {
  if (!root) return null;
  const find = (node: FocusNode, tag: string): FocusNode | null => {
    if (node.tagName === tag) return node;
    for (let i = 0; i < node.children.length; i += 1) {
      const found = find(node.children[i], tag);
      if (found) return found;
    }
    return null;
  };
  const main = find(root, "MAIN") ?? root;
  const target = find(main, "H1") ?? (main.tagName === "MAIN" ? main : null);
  if (target && target.getAttribute("tabindex") === null) target.setAttribute("tabindex", "-1");
  return target;
}

function rootOf(el: FocusNode): FocusNode {
  let node = el;
  while (node.parentElement) node = node.parentElement;
  return node;
}

// a window's own landing: where focus goes when the window and the control that opened it are both gone
const dialogLandings = new WeakMap<object, FocusLanding>();

/** Remembers, for a modal window, where focus lands if what opened it has gone (set by Dialog when it opens). */
export function setDialogLanding(dialog: object, landing: FocusLanding): void {
  dialogLandings.set(dialog, landing);
}

/**
 * Where focus should go if `el` disappears, worked out now (while `el` is on the page): the next row of its list, else
 * the previous one. Past that, inside a modal window: the window's first control while it is still open, else the
 * window's own landing (the opener's row, set by Dialog); outside one: the page's main heading.
 */
export function focusLanding(el: FocusNode): FocusLanding {
  let dialog: FocusNode | null = null;
  for (let node: FocusNode | null = el; node; node = node.parentElement) {
    if (node.tagName === "DIALOG") {
      dialog = node;
      break;
    }
  }
  const row = rowOf(el);
  const next = row?.nextElementSibling ?? null;
  const previous = row?.previousElementSibling ?? null;
  const root = rootOf(el);
  return () => {
    for (let node = next; node; node = node.nextElementSibling) {
      if (!node.isConnected) break;
      const target = firstFocusable(node);
      if (target) return target;
    }
    for (let node = previous; node; node = node.previousElementSibling) {
      if (!node.isConnected) break;
      const target = firstFocusable(node);
      if (target) return target;
    }
    if (dialog) {
      // an open window keeps focus inside (or leaves it to Dialog, which gives it back to the opener when it closes)
      if (dialog.isConnected && dialog.hasAttribute("open")) return firstFocusable(dialog);
      return dialogLandings.get(dialog)?.() ?? null;
    }
    return pageHeading(root.isConnected ? root : null);
  };
}

/** Focus is lost: on nothing, on the page itself, or on an element that is no longer on the page. */
export function focusIsLost(active: FocusNode | null, body: FocusNode | null): boolean {
  return !active || active === body || !active.isConnected;
}

/**
 * The page-wide safety net (mounted once by FocusRescue). `focusIn` is told of every element that gets focus, `changed`
 * of every change to the page. Two ways focus gets lost are put right:
 * - the focused element left the page: focus goes to its landing (the next row, else the previous one, else the heading);
 * - the focused button was disabled while its action ran (the browser drops focus to the page): when it is enabled again
 *   and focus is still nowhere, it gets it back.
 * Focus that a person moved somewhere else is never taken.
 */
export function createFocusRescue(page: { activeElement: () => FocusNode | null; body: FocusNode | null }) {
  let last: FocusNode | null = null;
  let landing: FocusLanding | null = null;
  let waitingForEnable = false;

  return {
    focusIn(target: FocusNode) {
      if (target === page.body) return;
      last = target;
      landing = focusLanding(target);
      waitingForEnable = false;
    },
    changed() {
      if (!last) return;
      const active = page.activeElement();
      const lost = focusIsLost(active, page.body);
      if (!last.isConnected) {
        if (!lost) return;
        const target = landing?.() ?? null;
        last = null;
        landing = null;
        waitingForEnable = false;
        target?.focus();
        return;
      }
      if (last.hasAttribute("disabled")) {
        if (lost || active === last) waitingForEnable = true;
      } else if (waitingForEnable) {
        waitingForEnable = false;
        if (lost) last.focus();
      }
    },
  };
}
